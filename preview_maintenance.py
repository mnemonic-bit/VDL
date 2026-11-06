"""Durable preview provenance, publication journal, and aggregate maintenance log."""
import json
import hashlib
import os
from datetime import datetime, timezone


class PreviewMaintenance:
    COOLDOWN = 30
    LEASE_SECONDS = 120

    @staticmethod
    def init_schema(conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS preview_deliveries (
                identity TEXT PRIMARY KEY, download_id TEXT NOT NULL, source TEXT NOT NULL,
                version INTEGER NOT NULL, path TEXT NOT NULL, file_identity TEXT NOT NULL,
                selected INTEGER NOT NULL DEFAULT 1, lease_until REAL NOT NULL DEFAULT 0,
                cleanup_failed INTEGER NOT NULL DEFAULT 0, cleanup_retry_at REAL NOT NULL DEFAULT 0,
                UNIQUE(download_id,source,version,path)
            );
            CREATE INDEX IF NOT EXISTS preview_delivery_selection
                ON preview_deliveries(download_id,source,selected,version);
            CREATE INDEX IF NOT EXISTS preview_delivery_cleanup
                ON preview_deliveries(selected,lease_until,identity);
            CREATE TABLE IF NOT EXISTS preview_publications (
                sequence INTEGER PRIMARY KEY, token TEXT NOT NULL, download_id TEXT NOT NULL,
                source TEXT NOT NULL, version INTEGER NOT NULL, path TEXT NOT NULL,
                file_identity TEXT NOT NULL, identity TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS preview_campaigns (
                id INTEGER PRIMARY KEY AUTOINCREMENT, target INTEGER NOT NULL UNIQUE,
                started REAL NOT NULL, state TEXT NOT NULL DEFAULT 'running',
                discovery_complete INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
                next_at REAL NOT NULL, updated INTEGER NOT NULL DEFAULT 0,
                left_count INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
                skipped INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
                last_log REAL NOT NULL DEFAULT 0, last_progress TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS preview_members (
                campaign_id INTEGER NOT NULL REFERENCES preview_campaigns(id),
                download_id TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'left',
                PRIMARY KEY(campaign_id,download_id,source)
            );
            CREATE INDEX IF NOT EXISTS preview_member_download ON preview_members(download_id,source,state,campaign_id);
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                severity TEXT NOT NULL, event_type TEXT NOT NULL, component TEXT NOT NULL,
                campaign_id INTEGER, target INTEGER, lifecycle_state TEXT NOT NULL,
                message TEXT NOT NULL, data TEXT NOT NULL, counters TEXT NOT NULL
            );
        """)
        if 'cleanup_retry_at' not in {row[1] for row in conn.execute('PRAGMA table_info(preview_deliveries)')}:
            conn.execute('ALTER TABLE preview_deliveries ADD COLUMN cleanup_retry_at REAL NOT NULL DEFAULT 0')
        conn.execute('CREATE INDEX IF NOT EXISTS preview_cleanup_retry ON preview_deliveries(selected,cleanup_retry_at,lease_until)')

    def __init__(self, queue):
        self.q = queue
        self.started_at = queue.clock()
        self.recovered = False

    def _campaign(self, conn):
        return conn.execute('SELECT * FROM preview_campaigns WHERE target=?',
                            (self.q.versions['montage'],)).fetchone()

    @staticmethod
    def _counts(row):
        return {name: row['left_count' if name == 'left' else name]
                for name in ('updated', 'left', 'failed', 'skipped', 'total')}

    def _event(self, conn, row, kind, prefix, severity='info'):
        counts = self._counts(row)
        message = f"{prefix}: {counts['updated']:,} updated, {counts['left']:,} left"
        if counts['failed']:
            message += f", {counts['failed']:,} failed"
        if counts['skipped']:
            message += f", {counts['skipped']:,} skipped"
        if not row['discovery_complete']:
            message += '. Scanning Library; total not yet known'
        message += '.'
        timestamp = datetime.fromtimestamp(self.q.clock(), timezone.utc).isoformat().replace('+00:00', 'Z')
        self.q._maintenance_changed = True
        conn.execute('INSERT INTO system_logs(timestamp,severity,event_type,component,campaign_id,'
                     'target,lifecycle_state,message,data,counters) VALUES (?,?,?,?,?,?,?,?,?,?)',
                     (timestamp, severity, kind, 'Preview cache', row['id'], row['target'], row['state'],
                      message, json.dumps({'discovery_complete': bool(row['discovery_complete'])}),
                      json.dumps(counts)))
        conn.execute('UPDATE preview_campaigns SET last_log=?,last_progress=? WHERE id=?',
                     (self.q.clock(), json.dumps(counts, sort_keys=True), row['id']))

    def refresh(self, conn, *, immediate=False):
        row = self._campaign(conn)
        if row is None:
            return
        counts = {record['state']: record['n'] for record in conn.execute(
            'SELECT state,COUNT(*) n FROM preview_members WHERE campaign_id=? GROUP BY state', (row['id'],))}
        values = tuple(counts.get(name, 0) for name in ('updated', 'left', 'failed', 'skipped'))
        if (*values, sum(values)) != tuple(row[key] for key in ('updated','left_count','failed','skipped','total')):
            conn.execute('UPDATE preview_campaigns SET updated=?,left_count=?,failed=?,skipped=?,total=? WHERE id=?',
                         (*values, sum(values), row['id']))
        row = self._campaign(conn)
        if row['state'] in ('paused', 'superseded'):
            return
        if row['discovery_complete'] and row['left_count'] == 0:
            state = 'completed_with_warnings' if row['failed'] or row['skipped'] else 'completed'
            if row['state'] != state:
                conn.execute('UPDATE preview_campaigns SET state=? WHERE id=?', (state, row['id']))
                row = self._campaign(conn)
                self._event(conn, row, 'finished',
                            'Cached preview update pass finished with warnings' if state.endswith('warnings')
                            else 'Finished updating cached preview sequences',
                            'warning' if state.endswith('warnings') else 'info')
        elif (immediate or (self.q.clock() - row['last_log'] >= 30
                            and json.dumps(self._counts(row), sort_keys=True) != row['last_progress'])):
            self._event(conn, row, 'progress', 'Updating cached preview sequences')

    def member(self, conn, download_id, source):
        row = self._campaign(conn)
        created = row is None
        if created:
            conn.execute('INSERT INTO preview_campaigns(target,started,next_at,last_log) VALUES (?,?,?,?)',
                         (self.q.versions['montage'], self.q.clock(), self.started_at + self.COOLDOWN, self.q.clock()))
            row = self._campaign(conn)
        inserted = conn.execute('INSERT OR IGNORE INTO preview_members(campaign_id,download_id,source) VALUES (?,?,?)',
                                (row['id'], download_id, source)).rowcount
        if inserted:
            if row['state'].startswith('completed'):
                conn.execute("UPDATE preview_campaigns SET state='running' WHERE id=?", (row['id'],))
            self.refresh(conn)
            if created:
                self._event(conn, self._campaign(conn), 'started', 'Started updating cached preview sequences')

    def outcome(self, conn, task, state):
        row = self._campaign(conn)
        if row is None or task.get('kind') != 'montage':
            return
        changed = conn.execute("UPDATE preview_members SET state=? WHERE campaign_id=? AND download_id=? "
                               "AND source=? AND state='left'", (state, row['id'], task['download_id'],
                                                               task['source'])).rowcount
        if changed and state == 'failed':
            self.refresh(conn)
            self._event(conn, self._campaign(conn), 'upgrade_failed',
                        'Preview upgrade retry budget exhausted; existing previews remain available', 'error')
        self.refresh(conn)

    def skip(self, conn, download_id, source=None):
        sql = "UPDATE preview_members SET state='skipped' WHERE download_id=? AND state='left'"
        args = [download_id]
        if source is not None:
            sql += ' AND source<>?'
            args.append(source)
        exists = conn.execute(sql.replace("UPDATE preview_members SET state='skipped'", "SELECT 1 FROM preview_members") + " LIMIT 1", args).fetchone()
        if exists:
            conn.execute(sql, args)
            self.refresh(conn)

    def attempted(self, conn, task):
        if task['kind'] != 'montage':
            return
        row = self._campaign(conn)
        if row is not None and conn.execute('SELECT 1 FROM preview_members WHERE campaign_id=? AND download_id=? '
                                             'AND source=?', (row['id'], task['download_id'], task['source'])).fetchone():
            conn.execute('UPDATE preview_campaigns SET next_at=? WHERE id=?',
                         (self.q.clock() + self.COOLDOWN, row['id']))

    def due(self, conn, task):
        if task['kind'] != 'montage':
            return True
        row = self._campaign(conn)
        if row is None:
            return True
        member = conn.execute("SELECT 1 FROM preview_members WHERE campaign_id=? AND download_id=? AND source=? "
                              "AND state='left'", (row['id'], task['download_id'], task['source'])).fetchone()
        return not member or self.q.clock() >= row['next_at']

    def discovery(self, conn, cursor, complete=False):
        row = self._campaign(conn)
        if row is not None and not row['discovery_complete'] and (row['cursor'] < cursor or complete):
            conn.execute('UPDATE preview_campaigns SET cursor=?,discovery_complete=? WHERE id=?',
                         (max(cursor, row['cursor']), int(complete), row['id']))
            self.refresh(conn)

    def recover_campaign(self, conn):
        if self.recovered:
            return
        for row in conn.execute("SELECT * FROM preview_campaigns WHERE target<>? AND state IN ('running','paused')",
                                (self.q.versions['montage'],)).fetchall():
            conn.execute("UPDATE preview_campaigns SET state='superseded' WHERE id=?", (row['id'],))
            self._event(conn, dict(row) | {'state': 'superseded'}, 'superseded',
                        'Cached preview update run superseded by a newer recipe', 'warning')
        row = self._campaign(conn)
        if row is not None and row['state'] in ('running', 'paused'):
            paused = row['state'] == 'paused'
            conn.execute("UPDATE preview_campaigns SET state='running' WHERE id=?", (row['id'],))
            row = self._campaign(conn)
            self._event(conn, row, 'resuming' if paused else 'interrupted',
                        'Resuming cached preview updates' if paused else
                        'Previous preview update run was interrupted; resuming',
                        'info' if paused else 'warning')
        self.recovered = True

    def pause(self, conn):
        row = self._campaign(conn)
        if row is not None and row['state'] == 'running':
            conn.execute("UPDATE preview_campaigns SET state='paused' WHERE id=?", (row['id'],))
            self._event(conn, self._campaign(conn), 'paused', 'Pausing cached preview updates for shutdown')

    def add_delivery(self, conn, entry, source, version, path, file_identity=None, identity=None):
        if file_identity is None:
            if not self.q.confined(path) or not self.q._nonempty(path):
                return None
            file_identity = self.q._identity(path)
        row = conn.execute('SELECT * FROM preview_deliveries WHERE download_id=? AND source=? AND version=? AND path=?',
                            (entry['id'], source, version, path)).fetchone()
        if row and row['file_identity'] == file_identity:
            return row['identity']
        if row:
            conn.execute('DELETE FROM preview_deliveries WHERE identity=?', (row['identity'],))
        identity = identity or self.asset_identity(entry['id'], source, version, path, file_identity)
        conn.execute('INSERT INTO preview_deliveries(identity,download_id,source,version,path,file_identity) VALUES (?,?,?,?,?,?)',
                     (identity, entry['id'], source, version, path, file_identity))
        return identity

    @staticmethod
    def asset_identity(download_id, source, version, path, file_identity):
        return hashlib.sha256(json.dumps([download_id, source, version, path, file_identity]).encode()).hexdigest()[:32]

    def delivery_metadata(self, entry, source, records, deliveries):
        """Resolve a read snapshot without registering work or opening connections."""
        empty = {'available': False, 'current': False, 'identity': None}
        current_version = self.q.versions['montage']
        usable = []
        for row in deliveries:
            if row['source'] != source:
                continue
            try:
                if self.q.confined(row['path']) and self.q._identity(row['path']) == row['file_identity']:
                    usable.append(dict(row))
            except OSError:
                pass
        # Startup readers may precede adoption. The same deterministic identity
        # will be persisted when the serving request registers this provenance.
        for version in sorted({current_version, *(row['version'] for row in records if row['kind'] == 'montage')}, reverse=True):
            if version > current_version or any(row['version'] == version for row in usable):
                continue
            record = next((row for row in records if row['kind'] == 'montage' and row['version'] == version), None)
            if record is not None and (record['source'] != source or record['state'] not in ('ready', 'queued')
                                        or (record['state'] == 'queued' and record['attempts'] != 0)):
                continue
            if version != current_version and (record is None or record['state'] != 'ready'):
                continue
            path = self.q.asset_path(entry, 'montage') if version == current_version else self.q.legacy_path(entry, 'montage', version)
            try:
                if not path or not self.q.confined(path) or not self.q._nonempty(path):
                    continue
                file_identity = self.q._identity(path)
            except OSError:
                continue
            usable.append(dict(version=version, path=path, selected=1,
                               identity=self.asset_identity(entry['id'], source, version, path, file_identity)))
        has_current = any(row['selected'] and row['version'] == current_version for row in usable)
        for row in sorted(usable, key=lambda item: item['version'], reverse=True):
            if has_current and not row['selected']:
                continue
            return dict(available=True, current=row['version'] == current_version,
                        identity=row['identity'], path=row['path'])
        return empty

    def delivery(self, entry, identity=None, lease=False):
        empty = {'available': False, 'current': False, 'identity': None}
        resolved = self.q._resolve(entry['id'])
        if resolved is None:
            return empty
        _current, source = resolved
        with self.q.db() as conn:
            if conn.execute('SELECT 1 FROM asset_invalidations WHERE download_id=?', (entry['id'],)).fetchone():
                return empty
            rows = conn.execute('SELECT * FROM preview_deliveries WHERE download_id=? AND source=? ORDER BY version DESC',
                                (entry['id'], source)).fetchall()
        usable = []
        for row in rows:
            try:
                if self.q.confined(row['path']) and self.q._identity(row['path']) == row['file_identity']:
                    usable.append(row)
            except OSError:
                pass
        has_current = any(row['selected'] and row['version'] == self.q.versions['montage'] for row in usable)
        for row in usable:
            if identity is not None:
                if row['identity'] != identity:
                    continue
                if not row['selected'] and row['lease_until'] <= self.q.clock() and has_current:
                    continue
            elif has_current and not row['selected']:
                continue
            if lease:
                with self.q.db_lock, self.q.db() as conn:
                    conn.execute('UPDATE preview_deliveries SET lease_until=? WHERE identity=?',
                                 (self.q.clock() + self.LEASE_SECONDS, row['identity']))
            return {'available': True, 'current': row['version'] == self.q.versions['montage'],
                    'identity': row['identity'], 'path': row['path']}
        return empty

    def cleanup(self):
        self.q.cache_retirement.cleanup()
        with self.q.publication_lock:
            with self.q.db() as conn:
                rows = conn.execute('SELECT * FROM preview_deliveries WHERE selected=0 AND lease_until<=? '
                                    'AND cleanup_retry_at<=? ORDER BY cleanup_retry_at,identity LIMIT ?', (self.q.clock(), self.q.clock(), self.q.BATCH_SIZE)).fetchall()
            for row in rows:
                entry = self.q.get_entry(row['download_id'])
                replacement = self.delivery(entry) if entry else {'available': False}
                if not replacement['available'] or not replacement['current']:
                    self._defer_cleanup(row)
                    continue
                expected = self.q.legacy_path(entry, 'montage', row['version']) if entry else None
                if (row['path'] == replacement['path'] or not self.q.confined(row['path'])
                        or row['path'] != expected
                        or os.path.realpath(row['path']) == os.path.realpath(entry['filename'])):
                    self._defer_cleanup(row)
                    continue
                try:
                    # A reused filename is no longer the artifact we own.
                    if os.path.exists(row['path']) and self.q._identity(row['path']) != row['file_identity']:
                        self._defer_cleanup(row)
                        continue
                    os.remove(row['path'])
                except FileNotFoundError:
                    pass
                except OSError:
                    self._defer_cleanup(row)
                    if not row['cleanup_failed']:
                        with self.q.db_lock, self.q.db() as conn:
                            conn.execute('UPDATE preview_deliveries SET cleanup_failed=1 WHERE identity=?', (row['identity'],))
                            campaign = self._campaign(conn)
                            if campaign is not None:
                                self._event(conn, campaign, 'cleanup_failed',
                                            'Preview replacement is available; obsolete preview cleanup will be retried', 'warning')
                    continue
                with self.q.db_lock, self.q.db() as conn:
                    conn.execute('DELETE FROM preview_deliveries WHERE identity=?', (row['identity'],))

    def _defer_cleanup(self, row):
        with self.q.db_lock, self.q.db() as conn:
            conn.execute('UPDATE preview_deliveries SET cleanup_retry_at=? WHERE identity=?',
                         (self.q.clock() + self.COOLDOWN, row['identity']))

    def status(self):
        with self.q.db() as conn:
            row = self._campaign(conn)
            if row is None:
                return dict(state='idle', discovery_complete=True, updated=0, left=0, failed=0, skipped=0, total=0)
            return dict(self._counts(row), state=row['state'], discovery_complete=bool(row['discovery_complete']),
                        campaign_id=row['id'], target=row['target'], started=row['started'], next_at=row['next_at'])

    def logs(self, *, page=1, page_size=50, text='', severity='', snapshot_id=None):
        page_size = max(1, min(int(page_size), 100))
        page = max(1, int(page))
        with self.q.db() as conn:
            snapshot_id = int(snapshot_id) if snapshot_id is not None else conn.execute('SELECT COALESCE(MAX(id),0) FROM system_logs').fetchone()[0]
            where, args = 'id<=?', [snapshot_id]
            if text:
                where += ' AND instr(lower(message),lower(?))>0'
                args.append(text[:500])
            if severity:
                where += ' AND severity=?'
                args.append(severity)
            total = conn.execute('SELECT COUNT(*) FROM system_logs WHERE ' + where, args).fetchone()[0]
            pages = max(1, (total + page_size - 1) // page_size)
            page = min(page, pages)
            rows = conn.execute('SELECT * FROM system_logs WHERE ' + where + ' ORDER BY timestamp DESC,id DESC LIMIT ? OFFSET ?',
                                (*args, page_size, (page - 1) * page_size)).fetchall()
            items = []
            for row in rows:
                item = dict(row)
                item['data'] = json.loads(item['data'])
                item['counters'] = json.loads(item['counters'])
                items.append(item)
        return dict(items=items, page=page, page_size=page_size, total=total, pages=pages, snapshot_id=snapshot_id)

