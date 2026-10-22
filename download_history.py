"""Durable acquisition attempts, independent of mutable Library items.

Callers hold their normal database write lock and pass the transaction that
changes the work item. This keeps publication and its attempt outcome atomic.
"""

import os
import re
import time
import unicodedata
import uuid
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ACTIVE = ('starting', 'downloading', 'paused')
TERMINAL = ('finished', 'error', 'cancelled', 'interrupted')


def safe_source(value, *, diagnostic=False):
    """Never copy embedded credentials or signed query parameters into the log."""
    try:
        parsed = urlsplit(value or '')
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            return ''
        host = parsed.hostname
        if ':' in host:
            host = f'[{host}]'
        if parsed.port:
            host += f':{parsed.port}'
        # Keep routing identifiers useful (notably YouTube's v/list), while
        # signed links and credentials are never duplicated in the attempt log.
        query = urlencode([(key, value if not diagnostic and key.casefold() in
                            {'v', 'list', 'index', 't', 'start', 'end', 'id', 'page'}
                            else '<redacted>') for key, value in parse_qsl(parsed.query, keep_blank_values=True)])
        return urlunsplit((parsed.scheme, host, parsed.path, query, ''))
    except ValueError:
        return ''


def _safe_error(value):
    value = re.sub(r'https?://[^\s<>]+', lambda match: safe_source(match[0], diagnostic=True), str(value or ''))
    value = re.sub(r'(?i)(cookie|authorization)\s*[:=][^\r\n]*', r'\1: <redacted>', value)
    return value[:16000]


def initialize(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS download_attempts (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL,
            download_id TEXT REFERENCES downloads(id) ON DELETE SET NULL,
            owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            source_type TEXT NOT NULL,
            source_reference TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            filename TEXT NOT NULL DEFAULT '',
            started_at REAL NOT NULL,
            ended_at REAL,
            status TEXT NOT NULL,
            progress TEXT NOT NULL DEFAULT '0%',
            speed REAL,
            eta INTEGER,
            downloaded_bytes INTEGER,
            total_bytes INTEGER,
            filesize INTEGER,
            resolution TEXT,
            error_summary TEXT NOT NULL DEFAULT '',
            error_details TEXT NOT NULL DEFAULT '',
            legacy INTEGER NOT NULL DEFAULT 0,
            search_text TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS attempts_owner_started
            ON download_attempts(owner_user_id, started_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS attempts_work ON download_attempts(work_id);
    """)
    if conn.execute("SELECT 1 FROM app_config WHERE key = 'attempts_migrated'").fetchone() is None:
        for row in conn.execute('SELECT * FROM downloads').fetchall():
            record(conn, row['id'], legacy=True, create=True)
        conn.execute("INSERT INTO app_config(key, value) VALUES ('attempts_migrated', '1')")
    now = time.time()
    conn.execute(
        "UPDATE download_attempts SET status = 'interrupted', "
        "progress = 'Interrupted', ended_at = ? "
        "WHERE status IN ('starting', 'downloading', 'paused')", (now,),
    )


def record(conn, download_id, *, new=False, legacy=False, create=False):
    entry = conn.execute('SELECT * FROM downloads WHERE id = ?', (download_id,)).fetchone()
    if entry is None:
        return
    entry = dict(entry)
    previous = conn.execute(
        'SELECT id, status, started_at FROM download_attempts WHERE work_id = ? '
        'ORDER BY started_at DESC, id DESC LIMIT 1', (download_id,),
    ).fetchone()
    # A missing log may have been deliberately cleared or removed with its
    # owner's account. Only an explicit acceptance may create another record.
    if previous is None and not (new or legacy or create):
        return
    if previous and not new and previous['status'] not in ACTIVE:
        return
    attempt_id = previous['id'] if previous and not new else uuid.uuid4().hex
    source_type = ('mounted_import' if entry.get('ingest_source_path') else
                   'companion' if entry.get('browser_authenticated') else
                   'upload' if entry.get('source_type') == 'upload' else 'url')
    source = safe_source(entry.get('url')) if source_type in ('url', 'companion') else ''
    filename = os.path.basename(entry.get('display_filename') or entry.get('filename')
                                or entry.get('requested_filename') or '')
    details = _safe_error(entry['progress']) if entry['status'] == 'error' else ''
    summary = details.splitlines()[0][:300] if details else ''
    title = entry.get('title') or filename or (urlsplit(source).hostname if source else '') or 'Untitled attempt'
    snapshot = {
        'download_id': download_id, 'owner_user_id': entry.get('owner_user_id'),
        'source_type': source_type, 'source_reference': source, 'title': title,
        'filename': filename, 'status': entry['status'], 'progress': _safe_error(entry['progress']),
        'speed': entry.get('speed'), 'eta': entry.get('eta'),
        'downloaded_bytes': entry.get('downloaded_bytes'), 'total_bytes': entry.get('total_bytes'),
        'filesize': entry.get('filesize'), 'resolution': entry.get('resolution'),
        'ended_at': (entry.get('finished_at') or time.time()) if entry['status'] in TERMINAL else None,
        'error_summary': summary, 'error_details': details,
        'search_text': unicodedata.normalize('NFC', ' '.join((title, filename, source, source_type, source_type.replace('_', ' '), summary))).casefold(),
    }
    if previous and not new:
        conn.execute('UPDATE download_attempts SET ' + ', '.join(f'{key} = ?' for key in snapshot)
                     + ' WHERE id = ?', (*snapshot.values(), attempt_id))
    else:
        snapshot.update(id=attempt_id, work_id=download_id,
                        started_at=(entry['created_at'] if legacy or not new else
                                    max(time.time(), previous['started_at'] + 0.000001) if previous else time.time()),
                        legacy=int(legacy))
        conn.execute('INSERT INTO download_attempts (' + ', '.join(snapshot) + ') VALUES ('
                     + ', '.join('?' for _ in snapshot) + ')', tuple(snapshot.values()))


def start_mounted(conn, work_id, filename):
    now = time.time()
    conn.execute(
        "INSERT INTO download_attempts(id, work_id, source_type, title, filename, "
        "started_at, status, search_text) VALUES (?, ?, 'mounted_import', ?, ?, ?, 'starting', ?)",
        (uuid.uuid4().hex, work_id, os.path.splitext(filename)[0], filename, now,
         f'{filename} mounted_import'.casefold()),
    )


def fail_mounted(conn, work_id, error):
    details = _safe_error(error)
    summary = details.splitlines()[0][:300] if details else 'Import failed'
    conn.execute(
        "UPDATE download_attempts SET status = 'error', ended_at = ?, "
        "error_summary = ?, error_details = ?, search_text = search_text || ? "
        "WHERE work_id = ? AND status IN ('starting', 'downloading', 'paused')",
        (time.time(), summary, details, ' ' + summary.casefold(), work_id),
    )


def page(conn, user_id, is_admin, terms, requested_page, page_size):
    # Administrators additionally see ownerless system imports. Public media
    # visibility never grants access to another account's acquisition log.
    where = ['(owner_user_id = ? OR (owner_user_id IS NULL AND ?))']
    values = [user_id, int(is_admin)]
    for term in terms:
        term = unicodedata.normalize('NFC', term).casefold()
        if term.startswith('status:'):
            where.append('status = ?')
            values.append(term[7:])
        else:
            where.append('instr(search_text, ?) > 0')
            values.append(term)
    condition = ' AND '.join(where)
    total = conn.execute('SELECT COUNT(*) FROM download_attempts WHERE ' + condition, values).fetchone()[0]
    current_page = min(requested_page, max(1, (total + page_size - 1) // page_size))
    rows = conn.execute('SELECT * FROM download_attempts WHERE ' + condition
                        + ' ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?',
                        (*values, page_size, (current_page - 1) * page_size)).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item.pop('work_id')
        item.pop('search_text')
        item.pop('owner_user_id')
        item['legacy'] = bool(item['legacy'])
        items.append(item)
    return dict(items=items, total=total, page=current_page, page_size=page_size)
