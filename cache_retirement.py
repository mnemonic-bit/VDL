"""Durable, conservative retirement of superseded static thumbnail sidecars."""
import json
import os
import stat


class CacheRetirement:
    RETRY_SECONDS = 30

    @staticmethod
    def init_schema(conn):
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS thumbnail_retirements (
                path TEXT PRIMARY KEY, download_id TEXT NOT NULL,
                source TEXT NOT NULL, version INTEGER NOT NULL,
                file_identity TEXT NOT NULL, current_path TEXT NOT NULL,
                retry_at REAL NOT NULL DEFAULT 0,
                blocked_reason TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS thumbnail_retirement_retry
                ON thumbnail_retirements(retry_at,path);
        """)

    def __init__(self, queue):
        self.q = queue

    def _safe(self, path, entry):
        if not path or not self.q.confined(path):
            return False
        directory = os.path.dirname(os.path.abspath(entry['filename']))
        if (os.path.dirname(os.path.abspath(path)) != directory
                or os.path.realpath(directory) != directory
                or os.path.islink(path)):
            return False
        try:
            info = os.lstat(path)
            source = os.stat(entry['filename'])
            return (stat.S_ISREG(info.st_mode)
                    and (info.st_dev, info.st_ino) != (source.st_dev, source.st_ino))
        except OSError:
            return False

    def discover(self, entry):
        """Checkpoint exact reserved legacy paths; never infer montage ownership."""
        with self.q.publication_lock:
            resolved = self.q._resolve(entry['id'])
            if resolved is None:
                return
            entry, source = resolved
            current = self.q.asset_path(entry, 'thumbnail')
            candidates = []
            for version in range(1, self.q.versions['thumbnail']):
                path = self.q.legacy_path(entry, 'thumbnail', version)
                if path != current and self._safe(path, entry):
                    try:
                        candidates.append((path, entry['id'], source, version,
                                           self.q._identity(path), current))
                    except OSError:
                        pass
            if candidates:
                with self.q.db_lock, self.q.db() as conn:
                    conn.executemany('INSERT OR IGNORE INTO thumbnail_retirements '
                                     '(path,download_id,source,version,file_identity,current_path) '
                                     'VALUES (?,?,?,?,?,?)', candidates)

    def _block(self, row, reason):
        with self.q.db_lock, self.q.db() as conn:
            conn.execute('UPDATE thumbnail_retirements SET retry_at=?,blocked_reason=? WHERE path=?',
                         (self.q.clock() + self.RETRY_SECONDS, reason, row['path']))

    def replacement_ready(self, entry):
        """Publication resolves a missing replacement without delaying retirement."""
        with self.q.publication_lock:
            resolved = self.q._resolve(entry['id'])
            if resolved is None:
                return
            with self.q.db_lock, self.q.db() as conn:
                conn.execute("UPDATE thumbnail_retirements SET retry_at=0,blocked_reason='' "
                             "WHERE download_id=? AND source=? AND blocked_reason='replacement_unavailable'",
                             (entry['id'], resolved[1]))
            self.cleanup()

    def _unlink(self, row, entry, current):
        # Pin the directory before the final identity checks. A rename or
        # symlink swap must never redirect the unlink to another directory.
        directory = os.path.dirname(row['path'])
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.stat(os.path.basename(row['path']), dir_fd=descriptor, follow_symlinks=False)
            replacement = os.stat(os.path.basename(current), dir_fd=descriptor, follow_symlinks=False)
            source = os.stat(os.path.basename(entry['filename']), dir_fd=descriptor, follow_symlinks=False)
            identity = json.dumps([info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns])
            if (identity != row['file_identity'] or not stat.S_ISREG(info.st_mode)
                    or not stat.S_ISREG(replacement.st_mode) or replacement.st_size <= 0
                    or not stat.S_ISREG(source.st_mode)
                    or (info.st_dev, info.st_ino) == (source.st_dev, source.st_ino)
                    or json.dumps([source.st_dev, source.st_ino, source.st_size, source.st_mtime_ns]) != row['source']):
                raise OSError('artifact identity changed')
            os.remove(os.path.basename(row['path']), dir_fd=descriptor)
        finally:
            os.close(descriptor)

    def cleanup(self):
        """A bounded retry pass; the replacement and both identities must agree."""
        with self.q.publication_lock:
            with self.q.db() as conn:
                rows = conn.execute('SELECT * FROM thumbnail_retirements WHERE retry_at<=? '
                                    'ORDER BY retry_at,path LIMIT ?',
                                    (self.q.clock(), self.q.BATCH_SIZE)).fetchall()
            for row in rows:
                resolved = self.q._resolve(row['download_id'])
                if resolved is None or resolved[1] != row['source']:
                    self._block(row, 'source_changed_or_missing')
                    continue
                entry, source = resolved
                current = self.q.asset_path(entry, 'thumbnail')
                expected = self.q.legacy_path(entry, 'thumbnail', row['version'])
                with self.q.db() as conn:
                    ready = conn.execute("SELECT 1 FROM generated_assets WHERE download_id=? "
                                         "AND kind='thumbnail' AND version=? AND source=? AND state='ready'",
                                         (entry['id'], self.q.versions['thumbnail'], source)).fetchone()
                    invalidated = conn.execute('SELECT 1 FROM asset_invalidations WHERE download_id=?',
                                               (entry['id'],)).fetchone()
                if (not ready or invalidated or current != row['current_path']
                        or not self._safe(current, entry) or not self.q._nonempty(current)):
                    self._block(row, 'replacement_unavailable')
                    continue
                if expected != row['path'] or current == row['path']:
                    self._block(row, 'path_changed')
                    continue
                try:
                    if os.path.lexists(row['path']):
                        if (not self._safe(row['path'], entry)
                                or self.q._identity(row['path']) != row['file_identity']):
                            self._block(row, 'identity_changed_or_unsafe')
                            continue
                        self._unlink(row, entry, current)
                except OSError:
                    self._block(row, 'unlink_failed')
                    continue
                with self.q.db_lock, self.q.db() as conn:
                    conn.execute('DELETE FROM thumbnail_retirements WHERE path=?', (row['path'],))
