"""Persistent, single-worker preparation of Library thumbnail and montage assets.

The queue keeps demand separate from enqueue order. Callers publish media first,
then register it; a bounded startup reconciliation closes a missed-register gap.
"""
import glob
import errno
import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager, nullcontext
from preview_maintenance import PreviewMaintenance


class RegistrationBusy(Exception):
    pass


class AssetQueue:
    BATCH_SIZE = 100
    RECONCILE_SECONDS = 0.05
    MAX_TABS = 256
    DEMAND_SECONDS = 60
    RETRY_DELAYS = (30, 300)

    def __init__(self, *, db, db_lock, get_entry, eligible, asset_path,
                 generate, versions, notify=None, clock=time.time, confined=None,
                 notify_maintenance=None, validate=None, legacy_path=None):
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
        self.validate = validate or (lambda kind, path: self._nonempty(path))
        self.legacy_path = legacy_path or self._legacy_path
        self.notify_maintenance = notify_maintenance or (lambda: None)
        self.maintenance = PreviewMaintenance(self)
        self._shutdown = False
        self._maintenance_changed = False
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

        PreviewMaintenance.init_schema(conn)

    def _legacy_path(self, entry, kind, version):
        path = self.asset_path(entry, kind)
        current = self.versions[kind]
        return path.replace(f"preview-v{current}.", f"preview-v{version}.")

    def delivery(self, entry, identity=None, lease=False):
        selected = self.maintenance.delivery(entry, identity=identity, lease=lease)
        if not selected['available'] and identity is None:
            # First reads can precede bounded startup discovery. Adopt only
            # provenance-backed legacy or the owned current recipe sidecar.
            with self.db() as conn:
                known = conn.execute("SELECT 1 FROM generated_assets WHERE download_id=? AND kind='montage' AND state='ready'",
                                     (entry['id'],)).fetchone()
            if known or self._nonempty(self.asset_path(entry, 'montage')):
                try:
                    self.register(entry, blocking=False)
                except RegistrationBusy:
                    return selected
                selected = self.maintenance.delivery(entry, lease=lease)
        return selected

    def maintenance_status(self):
        return self.maintenance.status()

    def system_logs(self, **kwargs):
        return self.maintenance.logs(**kwargs)

    def _maintenance_hint(self):
        if not self._maintenance_changed:
            return
        self._maintenance_changed = False
        try:
            self.notify_maintenance()
        except Exception:
            pass

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
            self.maintenance.skip(conn, download_id)
            conn.execute('DELETE FROM preview_deliveries WHERE download_id=?', (download_id,))

    @contextmanager
    def _registration_lock(self, blocking, lock=None):
        lock = lock or self.db_lock
        acquired = lock.acquire(blocking=blocking)
        if not acquired:
            raise RegistrationBusy()
        try:
            yield
        finally:
            lock.release()

    def register(self, entry, *, blocking=True):
        """Register both kinds without decoding, preserving failure budgets."""
        download_id = entry['id']
        with self._registration_lock(blocking, self.publication_lock):
            resolved = self._resolve(download_id)
            if resolved is None:
                if not blocking:
                    return {}
                self._discard_ineligible(download_id)
                return {}
            current, identity = resolved
            paths = {kind: self.asset_path(current, kind) for kind in self.versions}
            files = {kind: self._nonempty(path) for kind, path in paths.items()}
            file_identities = {kind: self._identity(path) for kind, path in paths.items() if files[kind]}
            with self.db() as snapshot:
                all_records = snapshot.execute('SELECT * FROM generated_assets WHERE download_id=?', (download_id,)).fetchall()
            records_by_kind = {kind: [row for row in all_records if row['kind'] == kind] for kind in self.versions}
            legacy_files = []
            for record in records_by_kind.get('montage', []):
                if (record['version'] < self.versions['montage'] and record['source'] == identity
                        and record['state'] == 'ready'):
                    old_path = self.legacy_path(current, 'montage', record['version'])
                    if old_path != paths['montage'] and self._nonempty(old_path) and self.confined(old_path):
                        legacy_files.append((record['version'], old_path, self._identity(old_path)))
            result = {}
            with self._registration_lock(blocking), self.db() as conn:
                if conn.execute('SELECT 1 FROM asset_invalidations WHERE download_id=?',
                                (download_id,)).fetchone():
                    return {}
                self.maintenance.skip(conn, download_id, identity)
                for kind, version in self.versions.items():
                    records = records_by_kind[kind]
                    previous = records[0] if records else None
                    if previous is not None and previous['source'] != identity:
                        self._remove(paths[kind])
                        files[kind] = False
                    # Preserve original source provenance before retiring queue records.
                    legacy = False
                    if kind == 'montage':
                        for old_version, old_path, old_identity in legacy_files:
                            self.maintenance.add_delivery(conn, current, identity, old_version, old_path, old_identity)
                            legacy = True
                        if legacy:
                            self.maintenance.member(conn, download_id, identity)
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
                    if kind == 'montage' and state == 'ready':
                        serving = self.maintenance.add_delivery(conn, current, identity, version, paths[kind], file_identities.get(kind))
                        if legacy:
                            conn.execute('UPDATE preview_deliveries SET selected=0,lease_until=MAX(lease_until,?) '
                                         'WHERE download_id=? AND identity<>?',
                                         (self.clock() + self.maintenance.LEASE_SECONDS, download_id, serving))
                            self.maintenance.outcome(conn, dict(kind=kind, download_id=download_id, source=identity), 'updated')
                    result[kind] = state
        self._wake.set()
        self._maintenance_hint()
        return result

    def readiness(self, entry):
        return self.register(entry)

    def readiness_many(self, entries, *, include_delivery=False):
        """Read a collection's readiness with one database snapshot, no writes."""
        entries = list(entries)
        result = {}
        with self.db() as conn:
            records = {}
            records_by_id = {}
            deliveries = {}
            invalidated = set()
            for offset in range(0, len(entries), self.BATCH_SIZE):
                ids = [entry['id'] for entry in entries[offset:offset + self.BATCH_SIZE]]
                placeholders = ','.join('?' for _ in ids)
                for row in conn.execute('SELECT * FROM generated_assets WHERE download_id IN (' + placeholders + ')', ids):
                    records[(row['download_id'], row['kind'], row['version'])] = dict(row)
                    records_by_id.setdefault(row['download_id'], []).append(dict(row))
                if include_delivery:
                    for row in conn.execute('SELECT * FROM preview_deliveries WHERE download_id IN (' + placeholders + ')', ids):
                        deliveries.setdefault(row['download_id'], []).append(dict(row))
                    invalidated.update(row[0] for row in conn.execute('SELECT download_id FROM asset_invalidations WHERE download_id IN (' + placeholders + ')', ids))
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
            if include_delivery:
                states['montage_delivery'] = (dict(available=False, current=False, identity=None) if entry['id'] in invalidated else
                    self.maintenance.delivery_metadata(entry, identity, records_by_id.get(entry['id'], []), deliveries.get(entry['id'], [])))
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
                        self.maintenance.skip(connection, download_id)
                        connection.execute('DELETE FROM preview_deliveries WHERE download_id=?', (download_id,))
                        connection.execute('DELETE FROM preview_publications WHERE download_id=?', (download_id,))
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
            # SQL excludes cooling upgrades before LIMIT, so a delayed oldest
            # task cannot hold the rest of the shared queue hostage.
            eligible = ("a.state='queued' AND a.retry_at<=? AND a.version=CASE a.kind "
                        "WHEN 'montage' THEN ? ELSE ? END AND (NOT EXISTS ("
                        "SELECT 1 FROM preview_members m JOIN preview_campaigns c ON c.id=m.campaign_id "
                        "WHERE m.download_id=a.download_id AND m.source=a.source AND m.state='left' "
                        "AND c.target=a.version AND a.kind='montage') OR EXISTS ("
                        "SELECT 1 FROM asset_demands h WHERE h.download_id=a.download_id "
                        "AND h.kind=a.kind AND h.tier=2) OR EXISTS (SELECT 1 FROM preview_campaigns c "
                        "WHERE c.target=a.version AND c.next_at<=?))")
            args = (now, self.versions['montage'], self.versions['thumbnail'], now)
            # A visible legacy sequence remains background work. Only intentional
            # hover grants its target a foreground tier.
            foreground = ("EXISTS (SELECT 1 FROM asset_demands d WHERE d.download_id=a.download_id "
                          "AND d.kind=a.kind AND (d.tier<>3 OR NOT EXISTS (SELECT 1 FROM preview_members m "
                          "JOIN preview_campaigns c ON c.id=m.campaign_id WHERE m.download_id=a.download_id "
                          "AND m.source=a.source AND m.state='left' AND c.target=a.version AND a.kind='montage')))")
            if self._foreground_count >= 8:
                row = conn.execute('SELECT a.* FROM generated_assets a WHERE ' + eligible +
                                   ' AND NOT ' + foreground + ' ORDER BY a.sequence LIMIT 1', args).fetchone()
                if row:
                    self._foreground_count = 0
                    return dict(row)
            row = conn.execute('SELECT a.* FROM generated_assets a JOIN asset_demands d '
                               'ON d.download_id=a.download_id AND d.kind=a.kind '
                               'JOIN asset_demand_tabs t ON t.owner=d.owner AND t.tab=d.tab WHERE ' + eligible +
                               ' AND ' + foreground + ' ORDER BY d.tier,t.changed DESC,d.position,a.sequence LIMIT 1', args).fetchone()
            if row:
                self._foreground_count += 1
                return dict(row)
            self._foreground_count = 0
            row = conn.execute('SELECT a.* FROM generated_assets a WHERE ' + eligible +
                               ' ORDER BY a.sequence LIMIT 1', args).fetchone()
            return dict(row) if row else None

    def _claim(self, task):
        with self.publication_lock:
            if self._shutdown:
                return None
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
        if task['kind'] == 'montage':
            return self._finish_montage(task, generated, failure)
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

    @staticmethod
    def _sync_file(path):
        with open(path, 'rb') as output:
            os.fsync(output.fileno())

    @staticmethod
    def _sync_directory(path):
        descriptor = os.open(os.path.dirname(path), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            try:
                os.fsync(descriptor)
            except OSError as error:
                # Some filesystems do not implement directory synchronization.
                if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                    raise
        finally:
            os.close(descriptor)

    def _finish_montage(self, task, generated, failure):
        with self.publication_lock:
            resolved = self._resolve(task['download_id'])
            with self.db_lock, self.db() as conn:
                owned = conn.execute("SELECT 1 FROM generated_assets WHERE sequence=? AND token=? AND state='running'",
                                     (task['sequence'], task['token'])).fetchone()
                if not owned:
                    return
                if resolved is None or resolved[1] != task['source'] or task['version'] != self.versions['montage']:
                    self.maintenance.skip(conn, task['download_id'], resolved[1] if resolved else None)
                    conn.execute('DELETE FROM generated_assets WHERE sequence=?', (task['sequence'],))
                    return
                if self._shutdown:
                    return
            entry, source = resolved
            output = self.asset_path(entry, 'montage')
            try:
                valid = (generated and self.confined(output) and self.confined(task['temporary_path'])
                         and self.validate('montage', task['temporary_path']))
            except Exception:
                valid = False
            if valid:
                try:
                    self._sync_file(task['temporary_path'])
                except OSError:
                    valid = False
            if valid:
                if self._shutdown:
                    return
                file_identity = self._identity(task['temporary_path'])
                identity = uuid.uuid4().hex
                with self.db_lock, self.db() as conn:
                    conn.execute('INSERT OR REPLACE INTO preview_publications '
                                 '(sequence,token,download_id,source,version,path,file_identity,identity) VALUES (?,?,?,?,?,?,?,?)',
                                 (task['sequence'], task['token'], task['download_id'], source,
                                  task['version'], output, file_identity, identity))
                try:
                    os.replace(task['temporary_path'], output)
                except OSError:
                    valid = False
                else:
                    self._sync_directory(output)
                    with self.db_lock, self.db() as conn:
                        self._commit_publication(conn, task, entry, output, file_identity, identity)
            if not valid:
                exhausted = task['attempts'] >= 3
                delay = 0 if exhausted else self.RETRY_DELAYS[task['attempts'] - 1]
                with self.db_lock, self.db() as conn:
                    conn.execute('UPDATE generated_assets SET state=?,retry_at=?,failure=?,token=NULL,'
                                 'temporary_path=NULL WHERE sequence=? AND token=?',
                                 ('failed' if exhausted else 'queued', self.clock() + delay,
                                  'Preview extraction failed', task['sequence'], task['token']))
                    conn.execute('DELETE FROM preview_publications WHERE sequence=?', (task['sequence'],))
                    self.maintenance.attempted(conn, task)
                    if exhausted:
                        self.maintenance.outcome(conn, task, 'failed')
            self.maintenance.cleanup()
        try:
            self.notify([task['download_id']])
        except Exception:
            pass
        self._maintenance_hint()

    def _commit_publication(self, conn, task, entry, output, file_identity, identity):
        self.maintenance.add_delivery(conn, entry, task['source'], task['version'], output, file_identity, identity)
        conn.execute('UPDATE preview_deliveries SET selected=0,lease_until=MAX(lease_until,?) '
                     'WHERE download_id=? AND identity<>?',
                     (self.clock() + self.maintenance.LEASE_SECONDS, task['download_id'], identity))
        conn.execute("UPDATE generated_assets SET state='ready',retry_at=0,failure='',token=NULL,temporary_path=NULL "
                     'WHERE sequence=? AND token=?', (task['sequence'], task['token']))
        self.maintenance.attempted(conn, task)
        self.maintenance.outcome(conn, task, 'updated')
        conn.execute('DELETE FROM preview_publications WHERE sequence=?', (task['sequence'],))

    def _recover_publications(self):
        with self.db() as conn:
            rows = conn.execute('SELECT * FROM preview_publications ORDER BY sequence LIMIT ?', (self.BATCH_SIZE,)).fetchall()
        for record in rows:
            task = dict(record, kind='montage')
            resolved = self._resolve(task['download_id'])
            try:
                valid = (resolved is not None and resolved[1] == task['source']
                         and task['version'] == self.versions['montage'] and self.confined(task['path'])
                         and task['path'] == self.asset_path(resolved[0], 'montage')
                         and self._identity(task['path']) == task['file_identity']
                         and self.validate('montage', task['path']))
            except OSError:
                valid = False
            if valid:
                self._sync_file(task['path'])
                self._sync_directory(task['path'])
            with self.db_lock, self.db() as conn:
                owned = conn.execute("SELECT 1 FROM generated_assets WHERE sequence=? AND token=? AND state='running'",
                                     (task['sequence'], task['token'])).fetchone()
                if valid and owned:
                    self._commit_publication(conn, task, resolved[0], task['path'], task['file_identity'], task['identity'])
                else:
                    conn.execute('DELETE FROM preview_publications WHERE sequence=?', (task['sequence'],))
        if len(rows) == self.BATCH_SIZE:
            self._recover_publications()

    def _settle_deferred_failure(self):
        if self._deferred_failure is None:
            return
        task, failure, failed_at = self._deferred_failure
        if task['kind'] == 'montage':
            self._recover_publications()
            with self.db() as conn:
                row = conn.execute('SELECT state FROM generated_assets WHERE sequence=?', (task['sequence'],)).fetchone()
            if row is None or row['state'] == 'ready':
                self._deferred_failure = None
                return
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
            if changed and task['kind'] == 'montage':
                self.maintenance.attempted(conn, task)
                if exhausted:
                    self.maintenance.outcome(conn, task, 'failed')
        self._deferred_failure = None
        self._maintenance_hint()
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
            if self._shutdown:
                return False
            self._settle_deferred_failure()
            self.maintenance.cleanup()
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
                failure = 'Preview extraction failed'
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
            with self.db_lock, self.db() as conn:
                self.maintenance.discovery(conn, self._scan_cursor, complete=True)
            self._maintenance_hint()
            return False
        for row in rows:
            if self._stop.is_set():
                return False
            entry = self.get_entry(row['id'])
            if entry is not None:
                self.register(entry)
            self._scan_cursor = row['asset_rowid']
            with self.db_lock, self.db() as conn:
                self.maintenance.discovery(conn, self._scan_cursor)
            # A slow commit may consume the whole slice. Give queued foreground
            # work a turn before attempting another unrelated registration.
            if time.monotonic() >= deadline:
                break
        return True

    def _recover(self):
        self._recover_publications()
        with self.db_lock, self.db() as conn:
            self.maintenance.recover_campaign(conn)
        # Running attempts count even when the previous process died. Reclaim
        # them with their bounded budget instead of treating restarts as retries.
        with self.db() as conn:
            rows = conn.execute("SELECT * FROM generated_assets "
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
                for row in rows:
                    self.maintenance.attempted(conn, dict(row))
                    if row['attempts'] >= 3:
                        self.maintenance.outcome(conn, dict(row), 'failed')
            with self.db() as conn:
                rows = conn.execute("SELECT * FROM generated_assets WHERE state='running' "
                                    'ORDER BY sequence LIMIT ?', (self.BATCH_SIZE,)).fetchall()
        with self.db_lock, self.db() as conn:
            conn.execute('DELETE FROM asset_demand_tabs')
            self.maintenance.refresh(conn)
        self.maintenance.cleanup()
        self._maintenance_hint()

    def _run(self):
        recovered = False
        while not self._stop.is_set():
            try:
                if not recovered:
                    self._recover()
                    recovered = True
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
            self._shutdown = False
            self._stop.clear()
            self._scan_cursor, self._scan_done = 0, False
            self._thread = threading.Thread(target=self._run, name='vdl-assets', daemon=True)
            self._thread.start()
            return self._thread

    def stop(self):
        with self._service_lock:
            self._shutdown = True
            self._stop.set()
            self._wake.set()
            thread = self._thread
        with self.db() as conn:
            campaign = self.maintenance._campaign(conn)
        if campaign is not None and campaign['state'] == 'running':
            with self.db_lock, self.db() as conn:
                self.maintenance.pause(conn)
        self._maintenance_hint()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        return thread
