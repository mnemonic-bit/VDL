"""Persistent, single-worker preparation of Library thumbnail and montage assets.

The queue keeps demand separate from enqueue order. Callers publish media first,
then register it; a bounded startup reconciliation closes a missed-register gap.
"""
import glob
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import nullcontext


class AssetQueue:
    BATCH_SIZE = 100
    RECONCILE_SECONDS = 0.05
    MAX_TABS = 256
    DEMAND_SECONDS = 60
    RETRY_DELAYS = (30, 300)

    def __init__(self, *, db, db_lock, get_entry, eligible, asset_path,
                 generate, versions, notify=None, clock=time.time, confined=None):
        self.db = db
        self.db_lock = db_lock
        self.get_entry = get_entry
        self.eligible = eligible
        self.asset_path = asset_path
        self.generate = generate
        self.versions = dict(versions)
        self.notify = notify or (lambda ids: None)
        self.clock = clock
        self.confined = confined or (lambda path: True)
        # Removal uses the same order: publication guard, then database lock.
        self.publication_lock = threading.RLock()
        self._generation_lock = threading.Lock()
        self._service_lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        self._foreground_count = 0
        self._scan_cursor = 0
        self._scan_done = False
        self._deferred_failure = None

    @staticmethod
    def init_schema(conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS generated_assets (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK(kind IN ('thumbnail', 'montage')),
                version INTEGER NOT NULL,
                source TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('queued','running','ready','failed')),
                attempts INTEGER NOT NULL DEFAULT 0,
                retry_at REAL NOT NULL DEFAULT 0,
                failure TEXT NOT NULL DEFAULT '',
                token TEXT,
                temporary_path TEXT,
                UNIQUE(download_id,kind,version)
            );
            CREATE INDEX IF NOT EXISTS generated_assets_dispatch
                ON generated_assets(state,retry_at,sequence);
            CREATE TABLE IF NOT EXISTS asset_invalidations (
                download_id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS asset_demand_tabs (
                owner TEXT NOT NULL,
                tab TEXT NOT NULL,
                revision INTEGER NOT NULL,
                signature TEXT NOT NULL,
                changed INTEGER NOT NULL,
                touched REAL NOT NULL,
                PRIMARY KEY(owner,tab)
            );
            CREATE TABLE IF NOT EXISTS asset_demands (
                owner TEXT NOT NULL,
                tab TEXT NOT NULL,
                download_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                tier INTEGER NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(owner,tab,download_id,kind),
                FOREIGN KEY(owner,tab) REFERENCES asset_demand_tabs(owner,tab) ON DELETE CASCADE
            );
        """)

    @staticmethod
    def _identity(path):
        info = os.stat(path)
        return json.dumps([info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns])

    @staticmethod
    def _nonempty(path):
        try:
            return bool(path and os.path.isfile(path) and os.path.getsize(path) > 0)
        except OSError:
            return False

    @staticmethod
    def _remove(path):
        if not path:
            return
        try:
            os.remove(path)
        except OSError:
            pass

    def _resolve(self, download_id):
        entry = self.get_entry(download_id)
        if entry is None or not self.eligible(entry):
            return None
        try:
            identity = self._identity(entry['filename'])
        except (OSError, KeyError, TypeError):
            return None
        return entry, identity

    def _discard_ineligible(self, download_id):
        entry = self.get_entry(download_id)
        if entry is not None:
            for kind in self.versions:
                path = self.asset_path(entry, kind)
                if path and self.confined(path):
                    self._remove(path)
        with self.db_lock, self.db() as conn:
            conn.execute('DELETE FROM generated_assets WHERE download_id=?', (download_id,))

    def register(self, entry):
        """Register both kinds without decoding, preserving failure budgets."""
        download_id = entry['id']
        with self.publication_lock:
            resolved = self._resolve(download_id)
            if resolved is None:
                self._discard_ineligible(download_id)
                return {}
            current, identity = resolved
            paths = {kind: self.asset_path(current, kind) for kind in self.versions}
            files = {kind: self._nonempty(path) for kind, path in paths.items()}
            result = {}
            with self.db_lock, self.db() as conn:
                if conn.execute('SELECT 1 FROM asset_invalidations WHERE download_id=?',
                                (download_id,)).fetchone():
                    return {}
                for kind, version in self.versions.items():
                    records = conn.execute('SELECT * FROM generated_assets WHERE download_id=? AND kind=?',
                                           (download_id, kind)).fetchall()
                    previous = records[0] if records else None
                    if previous is not None and previous['source'] != identity:
                        self._remove(paths[kind])
                        files[kind] = False
                    # Versions have their own retry budget; obsolete records must
                    # never become candidates after a cache-version upgrade.
                    # Even a DELETE matching no rows opens a write transaction.
                    # Unchanged startup caches and readiness checks need only reads.
                    if any(record['version'] != version for record in records):
                        conn.execute('DELETE FROM generated_assets WHERE download_id=? '
                                     'AND kind=? AND version<>?', (download_id, kind, version))
                    row = next((record for record in records if record['version'] == version), None)
                    if row is not None and row['source'] != identity:
                        self._remove(paths[kind])
                        files[kind] = False
                        conn.execute('DELETE FROM generated_assets WHERE sequence=?',
                                     (row['sequence'],))
                        row = None
                    if row is None:
                        state = 'ready' if files[kind] else 'queued'
                        conn.execute('INSERT INTO generated_assets '
                                     '(download_id,kind,version,source,state) VALUES (?,?,?,?,?)',
                                     (download_id, kind, version, identity, state))
                    else:
                        state = row['state']
                        if state == 'queued' and row['attempts'] == 0 and files[kind]:
                            state = 'ready'
                            conn.execute("UPDATE generated_assets SET state='ready' WHERE sequence=?",
                                         (row['sequence'],))
                        if state == 'ready' and not files[kind]:
                            state = 'failed' if row['attempts'] >= 3 else 'queued'
                            conn.execute('UPDATE generated_assets SET state=?,retry_at=0 '
                                         'WHERE sequence=?', (state, row['sequence']))
                        # A completed attempt is the only way an existing task
                        # may bless a sidecar after its identity was recorded.
                    result[kind] = state
        self._wake.set()
        return result

    def readiness(self, entry):
        return self.register(entry)

    def readiness_many(self, entries):
        """Read a collection's readiness with one database snapshot, no writes."""
        entries = list(entries)
        result = {}
        with self.db() as conn:
            records = {}
            for offset in range(0, len(entries), self.BATCH_SIZE):
                ids = [entry['id'] for entry in entries[offset:offset + self.BATCH_SIZE]]
                placeholders = ','.join('?' for _ in ids)
                for row in conn.execute('SELECT * FROM generated_assets WHERE download_id IN (' + placeholders + ')', ids):
                    records[(row['download_id'], row['kind'], row['version'])] = dict(row)
        for entry in entries:
            if not self.eligible(entry):
                continue
            try:
                identity = self._identity(entry['filename'])
            except (OSError, KeyError, TypeError):
                continue
            states = {}
            for kind, version in self.versions.items():
                row = records.get((entry['id'], kind, version))
                valid = self._nonempty(self.asset_path(entry, kind))
                if row is None:
                    state = 'ready' if valid else 'queued'
                elif row['source'] != identity:
                    state = 'queued'
                elif row['state'] == 'ready' and not valid:
                    state = 'failed' if row['attempts'] >= 3 else 'queued'
                elif row['state'] == 'queued' and row['attempts'] == 0 and valid:
                    state = 'ready'
                else:
                    state = row['state']
                states[kind] = state
            result[entry['id']] = states
        return result

    def invalidate(self, ids, *, conn=None):
        """Block re-registration before deleting media and its owned sidecars."""
        ids = list(dict.fromkeys(ids))
        with self.publication_lock:
            with (self.db_lock if conn is None else nullcontext()):
                with (self.db() if conn is None else nullcontext(conn)) as connection:
                    for download_id in ids:
                        connection.execute('INSERT OR IGNORE INTO asset_invalidations '
                                           'SELECT id FROM downloads WHERE id=?', (download_id,))
                        connection.execute('DELETE FROM generated_assets WHERE download_id=?',
                                           (download_id,))
                        connection.execute('DELETE FROM asset_demands WHERE download_id=?',
                                           (download_id,))
        self._wake.set()

    def replace_demand(self, owner, tab, revision, ids, hovered=None, *, renew=True):
        """Replace one authenticated tab's temporary demand, rejecting stale revisions."""
        owner = str(owner)
        ids = list(dict.fromkeys(ids))
        if (len(owner) > 512 or not isinstance(tab, str) or not 1 <= len(tab) <= 128
                or isinstance(revision, bool) or not isinstance(revision, int)
                or not 0 <= revision <= 9007199254740991 or len(ids) > 200
                or any(not isinstance(value, str) or len(value) > 128 for value in ids)
                or (hovered is not None and hovered not in ids)):
            raise ValueError('Invalid asset demand')
        signature = json.dumps([ids, hovered], separators=(',', ':'))
        now = self.clock()
        with self.db_lock, self.db() as conn:
            # Keep revision tombstones for cleared tabs until their normal TTL.
            conn.execute('DELETE FROM asset_demand_tabs WHERE touched<=?',
                         (now - self.DEMAND_SECONDS,))
            old = conn.execute('SELECT * FROM asset_demand_tabs WHERE owner=? AND tab=?',
                               (owner, tab)).fetchone()
            if old is not None and revision <= old['revision']:
                return False
            if not renew:
                if old is None:
                    return False
                # Readiness reconciliation is passive: retain the original
                # demand and expiry even when a slow response observes a new view.
                conn.execute('UPDATE asset_demand_tabs SET revision=? WHERE owner=? AND tab=?',
                             (revision, owner, tab))
                return True
            maximum = conn.execute('SELECT COALESCE(MAX(changed),0) FROM asset_demand_tabs').fetchone()[0]
            changed = old['changed'] if old is not None and old['signature'] == signature else maximum + 1
            if old is None:
                count = conn.execute('SELECT COUNT(*) FROM asset_demand_tabs').fetchone()[0]
                if count >= self.MAX_TABS:
                    conn.execute('DELETE FROM asset_demand_tabs WHERE rowid IN '
                                 '(SELECT rowid FROM asset_demand_tabs ORDER BY touched LIMIT 1)')
            conn.execute('INSERT INTO asset_demand_tabs(owner,tab,revision,signature,changed,touched) '
                         'VALUES (?,?,?,?,?,?) ON CONFLICT(owner,tab) DO UPDATE SET '
                         'revision=excluded.revision,signature=excluded.signature,'
                         'changed=excluded.changed,touched=excluded.touched',
                         (owner, tab, revision, signature, changed, now))
            conn.execute('DELETE FROM asset_demands WHERE owner=? AND tab=?', (owner, tab))
            conn.executemany('INSERT INTO asset_demands '
                             '(owner,tab,download_id,kind,tier,position) VALUES (?,?,?,?,?,?)',
                             [(owner, tab, download_id, kind,
                               1 if kind == 'thumbnail' else (2 if download_id == hovered else 3), position)
                              for position, download_id in enumerate(ids)
                              for kind in self.versions])
        self._wake.set()
        return True

    def clear_owner(self, owner):
        with self.db_lock, self.db() as conn:
            conn.execute('DELETE FROM asset_demand_tabs WHERE owner=?', (str(owner),))
        self._wake.set()

    def _candidate(self):
        now = self.clock()
        with self.db_lock, self.db() as conn:
            conn.execute('DELETE FROM asset_demand_tabs WHERE touched<=?',
                         (now - self.DEMAND_SECONDS,))
            ordinary = None
            if self._foreground_count >= 8:
                ordinary = conn.execute(
                    "SELECT a.* FROM generated_assets a WHERE state='queued' AND retry_at<=? "
                    'AND NOT EXISTS (SELECT 1 FROM asset_demands d WHERE d.download_id=a.download_id '
                    'AND d.kind=a.kind) ORDER BY sequence LIMIT 1', (now,)).fetchone()
            if ordinary is not None:
                self._foreground_count = 0
                return dict(ordinary)
            foreground = conn.execute(
                'SELECT a.* FROM generated_assets a JOIN asset_demands d '
                'ON d.download_id=a.download_id AND d.kind=a.kind '
                'JOIN asset_demand_tabs t ON t.owner=d.owner AND t.tab=d.tab '
                "WHERE a.state='queued' AND a.retry_at<=? "
                'ORDER BY d.tier,t.changed DESC,d.position,a.sequence LIMIT 1', (now,)).fetchone()
            if foreground is not None:
                self._foreground_count += 1
                return dict(foreground)
            self._foreground_count = 0
            row = conn.execute("SELECT * FROM generated_assets WHERE state='queued' "
                               'AND retry_at<=? ORDER BY sequence LIMIT 1', (now,)).fetchone()
            return dict(row) if row else None

    def _claim(self, task):
        with self.publication_lock:
            resolved = self._resolve(task['download_id'])
            if resolved is None:
                self._discard_ineligible(task['download_id'])
                return None
            entry, identity = resolved
            if identity != task['source'] or self.versions.get(task['kind']) != task['version']:
                self.register(entry)
                return None
            output = self.asset_path(entry, task['kind'])
            if task['attempts'] == 0 and self._nonempty(output):
                self.register(entry)
                return None
            suffix = '.jpg' if task['kind'] == 'thumbnail' else '.mp4'
            token = uuid.uuid4().hex
            temporary = f'{output}.{token}.asset-tmp{suffix}'
            with self.db_lock, self.db() as conn:
                updated = conn.execute(
                    "UPDATE generated_assets SET state='running',attempts=attempts+1,token=?,temporary_path=? "
                    "WHERE sequence=? AND state='queued' AND source=? AND attempts<3",
                    (token, temporary, task['sequence'], identity)).rowcount
                if not updated:
                    # A lost sidecar cannot repeatedly reset an exhausted budget.
                    conn.execute("UPDATE generated_assets SET state='failed' WHERE sequence=? AND attempts>=3",
                                 (task['sequence'],))
                    return None
            task.update(token=token, temporary_path=temporary, entry=entry,
                        attempts=task['attempts'] + 1)
            return task

    def _finish(self, task, generated, failure):
        changed = False
        with self.publication_lock:
            resolved = self._resolve(task['download_id'])
            with self.db_lock, self.db() as conn:
                owned = conn.execute("SELECT 1 FROM generated_assets WHERE sequence=? AND token=? AND state='running'",
                                     (task['sequence'], task['token'])).fetchone()
                if not owned:
                    return
                if resolved is None or resolved[1] != task['source']:
                    if resolved is not None:
                        self._remove(self.asset_path(resolved[0], task['kind']))
                    conn.execute('DELETE FROM generated_assets WHERE sequence=?', (task['sequence'],))
                    return
                entry, _identity = resolved
                if generated and self._nonempty(task['temporary_path']):
                    try:
                        os.replace(task['temporary_path'], self.asset_path(entry, task['kind']))
                    except OSError as exc:
                        failure = str(exc)
                    else:
                        conn.execute("UPDATE generated_assets SET state='ready',retry_at=0,failure='',"
                                     'token=NULL,temporary_path=NULL WHERE sequence=?', (task['sequence'],))
                        changed = True
                if not changed:
                    exhausted = task['attempts'] >= 3
                    delay = 0 if exhausted else self.RETRY_DELAYS[task['attempts'] - 1]
                    conn.execute('UPDATE generated_assets SET state=?,retry_at=?,failure=?,token=NULL,'
                                 'temporary_path=NULL WHERE sequence=?',
                                 ('failed' if exhausted else 'queued', self.clock() + delay,
                                  (failure or 'Preview extraction failed')[:240], task['sequence']))
                    changed = exhausted
        if changed:
            try:
                self.notify([task['download_id']])
            except Exception:
                # Notifications are hints; a disconnected observer cannot stop
                # durable queue progress. A later demand response reconciles it.
                pass

    def _settle_deferred_failure(self):
        if self._deferred_failure is None:
            return
        task, failure, failed_at = self._deferred_failure
        exhausted = task['attempts'] >= 3
        delay = 0 if exhausted else self.RETRY_DELAYS[task['attempts'] - 1]
        # A finalization transaction can fail after extraction has completed.
        # Keep just that owned task until its failure can be committed; decoder
        # work must not repeat while the database remains unavailable.
        with self.publication_lock, self.db_lock, self.db() as conn:
            changed = conn.execute(
                'UPDATE generated_assets SET state=?,retry_at=?,failure=?,token=NULL,'
                "temporary_path=NULL WHERE sequence=? AND token=? AND state='running'",
                ('failed' if exhausted else 'queued', failed_at + delay, failure,
                 task['sequence'], task['token']),
            ).rowcount
        self._deferred_failure = None
        if changed and exhausted:
            try:
                self.notify([task['download_id']])
            except Exception:
                pass

    def step(self):
        """Run at most one asset, also useful for deterministic queue tests."""
        if not self._generation_lock.acquire(blocking=False):
            return False
        try:
            self._settle_deferred_failure()
            task = self._candidate()
            if task is None:
                return False
            task = self._claim(task)
            if task is None:
                return True
            generated, failure = False, ''
            try:
                generated = bool(self.generate(task['kind'], task['entry']['filename'], task['temporary_path']))
            except Exception as exc:
                # A broken tool or corrupt file must not kill the dispatcher.
                failure = f'{type(exc).__name__}: {exc}'[:240]
            try:
                try:
                    self._finish(task, generated, failure)
                except (OSError, sqlite3.Error) as exc:
                    self._deferred_failure = (
                        task, f'{type(exc).__name__}: {exc}'[:240], self.clock(),
                    )
                    return True
                current = self.get_entry(task['download_id'])
                if current is not None:
                    try:
                        changed_source = self._identity(current['filename']) != task['source']
                    except (OSError, KeyError, TypeError):
                        changed_source = False
                    if changed_source:
                        self.register(current)
            finally:
                self._remove(task['temporary_path'])
                for path in glob.glob(task['temporary_path'] + '.*.tmp.*'):
                    self._remove(path)
            return True
        finally:
            self._generation_lock.release()

    def reconcile_batch(self):
        """Read a bounded collection slice; stat files outside the DB write lock."""
        if self._scan_done:
            return False
        deadline = time.monotonic() + self.RECONCILE_SECONDS
        with self.db() as conn:
            rows = conn.execute("SELECT rowid AS asset_rowid,id FROM downloads WHERE rowid>? "
                                "AND status='finished' ORDER BY rowid LIMIT ?",
                                (self._scan_cursor, self.BATCH_SIZE)).fetchall()
        if not rows:
            self._scan_done = True
            return False
        for row in rows:
            if self._stop.is_set():
                return False
            entry = self.get_entry(row['id'])
            if entry is not None:
                self.register(entry)
            self._scan_cursor = row['asset_rowid']
            # A slow commit may consume the whole slice. Give queued foreground
            # work a turn before attempting another unrelated registration.
            if time.monotonic() >= deadline:
                break
        return True

    def _recover(self):
        # Running attempts count even when the previous process died. Reclaim
        # them with their bounded budget instead of treating restarts as retries.
        with self.db() as conn:
            rows = conn.execute("SELECT sequence,temporary_path FROM generated_assets "
                                "WHERE state='running' ORDER BY sequence LIMIT ?", (self.BATCH_SIZE,)).fetchall()
        while rows:
            for row in rows:
                path = row['temporary_path']
                if path:
                    # Only remove paths under currently confined owned output.
                    with self.db() as conn:
                        record = conn.execute('SELECT download_id,kind FROM generated_assets WHERE sequence=?',
                                              (row['sequence'],)).fetchone()
                    entry = self.get_entry(record['download_id']) if record else None
                    output = self.asset_path(entry, record['kind']) if entry else None
                    if (output and path.startswith(output + '.')
                            and self.confined(output) and self.confined(path)):
                        self._remove(path)
                        for temporary in glob.glob(path + '.*.tmp.*'):
                            self._remove(temporary)
            with self.db_lock, self.db() as conn:
                conn.executemany("UPDATE generated_assets SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,"
                                 'token=NULL,temporary_path=NULL WHERE sequence=?', [(row['sequence'],) for row in rows])
            with self.db() as conn:
                rows = conn.execute("SELECT sequence,temporary_path FROM generated_assets WHERE state='running' "
                                    'ORDER BY sequence LIMIT ?', (self.BATCH_SIZE,)).fetchall()
        with self.db_lock, self.db() as conn:
            conn.execute('DELETE FROM asset_demand_tabs')

    def _run(self):
        try:
            self._recover()
        except (OSError, sqlite3.Error):
            pass
        while not self._stop.is_set():
            try:
                scanning = self.reconcile_batch()
                worked = self.step()
            except (OSError, sqlite3.Error):
                scanning = worked = False
            if not worked and not scanning:
                self._wake.wait(1)
                self._wake.clear()

    def start(self):
        """Start quickly; reconciliation takes place on the one worker."""
        with self._service_lock:
            if self._thread is not None and self._thread.is_alive():
                return self._thread
            self._stop.clear()
            self._scan_cursor, self._scan_done = 0, False
            self._thread = threading.Thread(target=self._run, name='vdl-assets', daemon=True)
            self._thread.start()
            return self._thread

    def stop(self):
        with self._service_lock:
            self._stop.set()
            self._wake.set()
            thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        return thread
