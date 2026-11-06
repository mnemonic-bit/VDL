#!/usr/bin/env python3
"""Read-only, paged cache inventory; importing the application is unnecessary."""
import argparse
import heapq
import json
import os
import re
import sqlite3
import stat
import time
from pathlib import Path


SIDECAR = re.compile(r'^\.vdl_(.+)\.(thumbnail|preview)(?:-v([1-9][0-9]*))?\.(jpg|mp4)(.*)$')


def file_identity(info):
    return json.dumps([info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns])


def inventory(database, directories, *, limit=100, after='', now=None):
    """Return one page; repeat with next_after for a complete inventory.

    Directory names are explicit authorization boundaries, never recursive.
    Pagination is lexicographic and memory use is bounded by the page size.
    """
    limit = max(1, min(int(limit), 1000))
    now = time.time() if now is None else now
    roots = sorted({os.path.abspath(path) for path in directories})
    for root in roots:
        if os.path.realpath(root) != root or not os.path.isdir(root):
            raise ValueError('Inventory directories must be existing, direct paths without symlinks')
    errors = []
    def paths():
        for root in roots:
            try:
                with os.scandir(root) as entries:
                    for entry in entries:
                        if entry.path > after:
                            yield entry.path
            except OSError as error:
                errors.append({'directory': root, 'reason': type(error).__name__})
    page = heapq.nsmallest(limit + 1, paths())
    conn = sqlite3.connect(Path(database).absolute().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    items = []
    try:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for path in page[:limit]:
            try:
                info = os.lstat(path)
            except OSError as error:
                items.append(dict(path=path, bytes=0, family='unreadable', disposition=type(error).__name__))
                continue
            if stat.S_ISDIR(info.st_mode):
                continue
            item = dict(path=path, bytes=info.st_size, family='unrelated', disposition='retained')
            match = SIDECAR.fullmatch(os.path.basename(path))
            if match:
                download_id, kind, version, extension, tail = match.groups()
                version = int(version or 1)
                item.update(download_id=download_id, version=version)
                item['family'] = ('temporary' if tail else
                                  ('jpeg' if kind == 'thumbnail' and extension == 'jpg' else
                                   'montage' if kind == 'preview' and extension == 'mp4' else 'unknown_cache'))
                row = conn.execute('SELECT * FROM downloads WHERE id=?', (download_id,)).fetchone()
                if row is None:
                    item['disposition'] = 'orphan_without_live_row'
                elif not stat.S_ISREG(info.st_mode):
                    item['disposition'] = 'unsafe_nonregular'
                elif tail:
                    item['disposition'] = 'temporary_unverified'
                else:
                    entry = dict(row)
                    source_path = entry.get('filename')
                    if (not source_path or os.path.dirname(os.path.abspath(source_path)) != os.path.dirname(path)):
                        item['disposition'] = 'unknown_source_directory'
                    else:
                        try:
                            source_info = os.stat(source_path)
                            source = file_identity(source_info)
                        except OSError:
                            source = None
                            source_info = None
                        if source_info and (source_info.st_dev, source_info.st_ino) == (info.st_dev, info.st_ino):
                            item['disposition'] = 'source_media'
                        elif source is None:
                            item['disposition'] = 'source_missing'
                        elif item['family'] == 'jpeg':
                            item['disposition'] = 'current_unverified' if version == 2 else 'obsolete_unverified'
                            if version == 2 and 'generated_assets' in tables:
                                ready = conn.execute("SELECT 1 FROM generated_assets WHERE download_id=? AND kind='thumbnail' "
                                                     "AND version=? AND source=? AND state='ready'",
                                                     (download_id, version, source)).fetchone()
                                if ready:
                                    item['disposition'] = 'current'
                            if 'thumbnail_retirements' in tables:
                                retirement = conn.execute('SELECT * FROM thumbnail_retirements WHERE path=?', (path,)).fetchone()
                                if retirement is not None:
                                    matching = (retirement['source'] == source
                                                and retirement['file_identity'] == file_identity(info))
                                    item['disposition'] = ('obsolete_pending' if matching and not retirement['blocked_reason'] else 'cleanup_blocked')
                                    item['reason'] = retirement['blocked_reason'] if matching else 'identity_changed'
                            if version > 2:
                                item['disposition'] = 'unknown_future_version'
                        elif item['family'] == 'montage':
                            item['disposition'] = 'current_unverified' if version == 5 else 'obsolete_unattributable'
                            if 'preview_deliveries' in tables:
                                delivery = conn.execute('SELECT * FROM preview_deliveries WHERE path=? AND source=? AND file_identity=?',
                                                        (path, source, file_identity(info))).fetchone()
                                if delivery:
                                    item.update(lease_until=delivery['lease_until'], cleanup_failed=bool(delivery['cleanup_failed']))
                                    has_current = False
                                    current_path = os.path.join(os.path.dirname(path), f'.vdl_{download_id}.preview-v5.mp4')
                                    try:
                                        current_info = os.lstat(current_path)
                                        if stat.S_ISREG(current_info.st_mode) and current_info.st_size > 0:
                                            has_current = bool(conn.execute('SELECT 1 FROM preview_deliveries WHERE path=? '
                                                                           'AND source=? AND file_identity=? AND selected=1',
                                                                           (current_path, source, file_identity(current_info))).fetchone())
                                    except OSError:
                                        pass
                                    item['disposition'] = ('current' if version == 5 and delivery['selected'] else
                                                           'retained_fallback' if delivery['selected'] or not has_current else
                                                           'retained_reader_lease' if delivery['lease_until'] > now else
                                                           'cleanup_blocked' if delivery['cleanup_failed'] else 'obsolete_pending')
                                    if version < 5 and not has_current:
                                        item['reason'] = 'replacement_missing'
                            if version > 5:
                                item['disposition'] = 'unknown_future_version'
            items.append(item)
    finally:
        conn.close()
    families, dispositions, versions = {}, {}, {}
    for item in items:
        for counts, key in ((families, item['family']), (dispositions, item['disposition'])):
            count = counts.setdefault(key, {'count': 0, 'bytes': 0})
            count['count'] += 1
            count['bytes'] += item['bytes']
        if 'version' in item:
            count = versions.setdefault(f"{item['family']}-v{item['version']}", {'count': 0, 'bytes': 0})
            count['count'] += 1
            count['bytes'] += item['bytes']
    return dict(items=items, families=families, dispositions=dispositions, versions=versions, errors=errors,
                complete=len(page) <= limit, next_after=page[limit - 1] if len(page) > limit else None,
                scope='page', directories=roots)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--directory', action='append', required=True)
    parser.add_argument('--limit', type=int, default=100)
    parser.add_argument('--after', default='')
    args = parser.parse_args()
    try:
        result = inventory(args.database, args.directory, limit=args.limit, after=args.after)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f'Inventory failed: {error}\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
