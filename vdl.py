import argparse
import base64
import gc
import hashlib
import hmac
import io
import ipaddress

from flask import (
    Flask, Response, abort, g, has_request_context, jsonify, redirect, render_template, request,
    send_file, session, stream_with_context, url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash
import yt_dlp
import threading
import queue
import json
import uuid
import sqlite3
import os
import re
import math
import time
import subprocess
import mimetypes
import copy
import ctypes
import errno
import secrets
import signal
import stat
import sys
import tempfile
import unicodedata
import zipfile
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

import download_history
from asset_generation import AssetQueue

from download_bandwidth import SharedBandwidth, govern_download, canonical_mbps


SEMVER_PATTERN = re.compile(
    r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
    r'(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
    r'(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?'
    r'(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'
)


def _load_app_version(version_path=None):
    """Load and validate the release identifier before the app can start."""
    path = Path(version_path) if version_path is not None else Path(__file__).resolve().with_name('VERSION')
    try:
        version = path.read_text(encoding='utf-8').rstrip()
    except OSError as exc:
        raise RuntimeError(
            f'Unable to read VERSION file at {path}; expected a SemVer value '
            f'in MAJOR.MINOR.PATCH form: {exc}'
        ) from exc

    if not version or not SEMVER_PATTERN.fullmatch(version):
        raise RuntimeError(
            f'Invalid VERSION file at {path}: expected a SemVer value in '
            'MAJOR.MINOR.PATCH form, with optional prerelease or build metadata'
        )
    return version


# Loading once keeps health checks cheap and makes a missing or malformed
# release declaration a startup failure instead of an ambiguous runtime state.
APP_VERSION = _load_app_version()
# A monotonic clock measures process lifetime without wall-clock corrections
# making the displayed uptime jump backwards or forwards.
APP_STARTED_AT = time.monotonic()
COMPANION_PROTOCOL = 1
COMPANION_PROTOCOLS = (COMPANION_PROTOCOL,)
COMPANION_PACKAGE_VERSION = '1.0.3'
COMPANION_PAIRING_CODE_FORMAT = 2
COMPANION_XPI_NAME = 'vdl-companion-firefox.xpi'
COMPANION_XPI_PATH = (
    Path(__file__).resolve().parent / 'browser-extension' / 'dist'
    / COMPANION_XPI_NAME
)
COMPANION_XPI_CHECKSUM_PATH = COMPANION_XPI_PATH.with_suffix('.xpi.sha256')
COMPANION_ENDPOINTS = {
    'extension_pair', 'extension_status', 'extension_downloads',
    'extension_token', 'extension_preflight',
}
EXTENSION_NO_STORE_ENDPOINTS = COMPANION_ENDPOINTS | {
    'extension_pairing_codes', 'extension_current_pairing_code',
    'extension_connections', 'extension_connection',
}

# Pairing codes deliberately disappear on restart. The bounded rate windows
# have the same process lifetime and never retain request bodies or credentials.
_pairing_codes = {}
_pairing_lock = threading.Lock()
_companion_rate_lock = threading.Lock()
_failed_pair_rates = {}
_failed_pair_global = []
_token_download_rates = {}


def _validated_companion_http_networks(value):
    """Return explicit local IPv4 networks allowed to pair over HTTP."""
    networks = [ipaddress.ip_network('127.0.0.0/8')]
    local_ranges = tuple(ipaddress.ip_network(item) for item in (
        '10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12',
        '192.168.0.0/16',
    ))
    for raw in (value or '').split(','):
        raw = raw.strip()
        if not raw:
            continue
        try:
            network = ipaddress.ip_network(raw, strict=True)
        except ValueError as exc:
            raise RuntimeError(
                'VDL_COMPANION_HTTP_CIDRS must contain comma-separated '
                'canonical IPv4 CIDRs'
            ) from exc
        if network.version != 4 or not any(
                network.subnet_of(parent) for parent in local_ranges):
            raise RuntimeError(
                'VDL_COMPANION_HTTP_CIDRS permits only private or shared '
                'local IPv4 networks'
            )
        if network not in networks:
            networks.append(network)
    return tuple(networks)


COMPANION_HTTP_NETWORKS = _validated_companion_http_networks(
    os.environ.get('VDL_COMPANION_HTTP_CIDRS')
)


def _companion_http_host_allowed(hostname):
    hostname = (hostname or '').rstrip('.').lower()
    if hostname == 'localhost' or hostname.endswith('.localhost'):
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return address.is_loopback or (
        address.version == 4 and any(
            address in network for network in COMPANION_HTTP_NETWORKS
        )
    )


def _get_uptime_seconds():
    """Return the number of complete seconds this application has been running."""
    return max(0, int(time.monotonic() - APP_STARTED_AT))


def _validated_pot_provider_url(value):
    """Return a normalized HTTP provider URL, or None when it is disabled."""
    value = (value or '').strip()
    if not value:
        return None

    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError(
            'VDL_POT_PROVIDER_URL contains an invalid port'
        ) from exc
    if (
        parsed.scheme not in ('http', 'https')
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise RuntimeError(
            'VDL_POT_PROVIDER_URL must be an HTTP(S) base URL without '
            'credentials, a query, or a fragment'
        )
    return value.rstrip('/')


# The provider is deployment-wide, so validate it once before any worker can
# start. The container bootstrap separately disables plugin discovery when the
# variable is empty; native installs without the plugin keep working as before.
POT_PROVIDER_URL = _validated_pot_provider_url(
    os.environ.get('VDL_POT_PROVIDER_URL')
)


def yt_dlp_options(options):
    """Merge deployment-wide yt-dlp settings into one invocation's options."""
    merged = copy.deepcopy(options)
    if not POT_PROVIDER_URL:
        return merged

    extractor_args = merged.setdefault('extractor_args', {})
    provider_args = extractor_args.setdefault('youtubepot-bgutilhttp', {})
    # yt-dlp's parsed extractor arguments are lists even for single values.
    # Replacing only base_url leaves unrelated extractor/provider arguments
    # intact while making the environment setting authoritative.
    provider_args['base_url'] = [POT_PROVIDER_URL]
    return merged

app = Flask(__name__)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
)


def _normalized_http_origin(value):
    """Return a comparable HTTP origin tuple, or None for invalid input."""
    if not value:
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() not in ('http', 'https')
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ('', '/')
        or parsed.query
        or parsed.fragment
    ):
        return None
    if port is None:
        port = 443 if parsed.scheme.lower() == 'https' else 80
    return parsed.scheme.lower(), parsed.hostname.lower(), port


def _companion_management_origin():
    origin = _normalized_http_origin(
        request.headers.get('Origin') or request.host_url
    )
    if origin is None or not (
            origin[0] == 'https'
            or (origin[0] == 'http' and _companion_http_host_allowed(origin[1]))):
        return None
    scheme, hostname, port = origin
    display_host = f'[{hostname}]' if ':' in hostname else hostname
    default_port = 443 if scheme == 'https' else 80
    return f'{scheme}://{display_host}' + (
        f':{port}' if port != default_port else ''
    )


def _is_extension_origin(value):
    """Accept only Firefox's opaque per-install extension origin."""
    if not value:
        return False
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == 'moz-extension'
        and bool(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
        and port is None
        and parsed.path in ('', '/')
        and not parsed.query
        and not parsed.fragment
    )


@app.before_request
def reject_cross_origin_api_mutation():
    """Keep browser form submissions from mutating the service."""
    if request.endpoint in COMPANION_ENDPOINTS:
        origin = request.headers.get('Origin')
        if origin is not None and not _is_extension_origin(origin):
            return _companion_error(
                400, 'invalid_request', 'Invalid extension origin'
            )
        return None
    if request.method not in ('POST', 'PUT', 'PATCH', 'DELETE'):
        return None

    origin = request.headers.get('Origin')
    if origin is not None:
        supplied_origin = _normalized_http_origin(origin)
        service_origin = _normalized_http_origin(request.host_url)
        if supplied_origin is None or supplied_origin != service_origin:
            return jsonify({"error": "Cross-origin request denied"}), 403

    # Fetch Metadata covers clients that suppress Origin. Browsers control
    # this header, so an attacking page cannot make a cross-site request look
    # same-origin; non-browser API clients remain compatible without it.
    if request.headers.get('Sec-Fetch-Site', '').lower() == 'cross-site':
        return jsonify({"error": "Cross-origin request denied"}), 403
    return None


@app.before_request
def require_authenticated_user():
    """Resolve the signed session before any private UI or API is served."""
    # Static styling is needed by the sign-in page, and the data-free health
    # probe must remain available to container runtimes before anyone signs in.
    if request.endpoint in (
            'static', 'login', 'health', 'browser_extension_package',
            *COMPANION_ENDPOINTS):
        return None
    if request.path.startswith('/browser-extension/'):
        abort(404)

    user_id = session.get('user_id')
    user = db_get_user_by_id(user_id) if user_id is not None else None
    if (user is not None
            and not user['suspended']
            and user['password_hash'] is not None
            and session.get('session_version') == user['session_version']):
        g.current_user = user
        return None

    session.clear()
    if request.path.startswith('/api/'):
        return jsonify({"error": "Authentication required"}), 401
    return redirect(url_for('login'))


@app.after_request
def companion_response_headers(response):
    """Apply the narrow CORS and cache boundary to companion responses."""
    if request.endpoint in ('library_storage', 'client_capabilities',
                            'editable_download_state', 'mutation_receipt', 'download_tags',
                            'set_download_favorite', 'preferences', 'start_video_upload', 'upload_status', 'cancel_video_upload', 'receive_video_upload'):
        response.headers['Cache-Control'] = 'no-store'
    if request.endpoint not in EXTENSION_NO_STORE_ENDPOINTS:
        return response
    response.headers['Cache-Control'] = 'no-store'
    if request.endpoint not in COMPANION_ENDPOINTS:
        return response
    origin = request.headers.get('Origin')
    if origin and _is_extension_origin(origin):
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers.add('Vary', 'Origin')
    return response


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'admin' not in g.current_user['roles']:
            return jsonify({"error": "Administrator access required"}), 403
        return view(*args, **kwargs)
    return wrapped


def _start_user_session(user):
    session.clear()
    session['user_id'] = user['id']
    session['session_version'] = user['session_version']
    session['asset_session_id'] = secrets.token_hex(16)

# ---------------------------------------------------------------------------
# Event bus (server -> browser push)
# ---------------------------------------------------------------------------
#
# A tiny in-process pub/sub. Each connected SSE client owns one bounded
# queue.Queue; producers (DB writers) call `event_bus.publish('change')` after
# a successful commit, and the SSE generator drains its queue and ships the
# event to the browser. No external broker needed -- the app is single-process.

class EventBus:
    def __init__(self):
        self._subs = {}
        self._lock = threading.Lock()

    def subscribe(self, user_id=None):
        # maxsize keeps a stuck/disconnected client from ballooning memory.
        # If full, we drop the oldest event for that subscriber -- stale clients
        # always reconcile by refetching their visible collections on the next event.
        q = queue.Queue(maxsize=64)
        with self._lock:
            self._subs[q] = user_id
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.pop(q, None)

    def publish(self, kind, payload=None, owner_user_id=None):
        msg = (kind, payload)
        with self._lock:
            subs = list(self._subs.items())
        for q, subscriber_user_id in subs:
            if (owner_user_id is not None
                    and subscriber_user_id != owner_user_id):
                continue
            if kind == 'change' and (payload or {}).get('reason') == 'library_rotation':
                with q.mutex:
                    if any(item[0] == 'change' and (item[1] or {}).get('reason')
                           == 'library_rotation' for item in q.queue):
                        continue
            if kind in ('assets', 'maintenance', 'library_storage'):
                # A slow client needs one bounded reconciliation hint, even
                # when the worker finishes several cached assets in a burst.
                with q.mutex:
                    pending = next((i for i, item in enumerate(q.queue)
                                    if item[0] == kind), None)
                    if pending is not None:
                        if kind in ('maintenance', 'library_storage'):
                            continue
                        previous = q.queue[pending][1] or {}
                        merged = list(dict.fromkeys(
                            previous.get('ids', []) + (payload or {}).get('ids', [])
                        ))[-200:]
                        q.queue[pending] = ('assets', {'ids': merged})
                        continue
            try:
                q.put_nowait(msg)
            except queue.Full:
                # Drop the head, push the new event. Subscribers only need the
                # *latest* signal to trigger a reconcile; missed intermediate
                # events are harmless because they'd cause the same refetch.
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    pass


event_bus = EventBus()


# ---------------------------------------------------------------------------
# Persistence layer
# ---------------------------------------------------------------------------

# DB_PATH is overridable via the DOWNLOADS_DB env var so the container can
# point it at a mounted volume (e.g. /data/downloads.db). Falls back to a
# file living next to app.py for plain `python app.py` runs.
DB_PATH = os.environ.get(
    "DOWNLOADS_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads.db"),
)

# Default download directory used when the preferences row doesn't exist yet.
# Configurable so the Docker image can ship a sensible writable default
# (/downloads) without forcing the user to set it on first run.
DEFAULT_DOWNLOAD_DIR = os.environ.get("DOWNLOADS_DIR", ".")
HISTORY_STATUSES = ('finished', 'error')
TERMINAL_STATUSES = HISTORY_STATUSES + ('cancelled', 'interrupted')

PLAYBACK_SESSION_TTL_SECONDS = 30 * 60
PLAYBACK_SESSION_MAX_PER_USER = 8
PLAYBACK_SESSION_MAX_FILTER_LENGTH = 256
PLAYBACK_SESSION_MAX_PAGE_SIZE = 100
PLAYBACK_SESSION_MAX_COORDINATE = 1_000_000
PLAYBACK_SESSION_ORDERINGS = ('newest', 'favorites_first')
SHUFFLE_MIN_HEIGHTS = (0, 360, 480, 720, 1080, 1440, 2160, 4320)
PLAYLIST_MAX_ITEMS = 10_000
PLAYLIST_MAX_POSITION_SECONDS = 31 * 24 * 60 * 60
BROWSER_VIDEO_EXTENSIONS = {
    '.mp4', '.m4v', '.webm', '.mkv', '.ogg', '.ogv', '.mov', '.avi',
}

# A single lock serialises writes from background threads. SQLite itself is
# safe for concurrent reads, but multiple writers across threads on the same
# connection cause "database is locked" errors. We open a fresh connection
# per operation and guard writes with this lock.
_db_lock = threading.Lock()
# File operations take this before database serialization; aliases share it.
_file_operation_lock = threading.RLock()
_rotation_lock = threading.RLock()
_rotation_timer = None
_rotation_timer_db = None
_upload_lock = threading.RLock()
# One queue instance belongs to one database and one serving process.
_asset_queue = None
_asset_queue_db = None
_asset_queue_lock = threading.Lock()
_NO_UPDATE = object()

# Endless playback is disposable navigation state. Keeping it outside SQLite
# makes process restarts an explicit lease boundary and avoids leaving behind
# playlist-shaped records for a feature that deliberately resolves live data.
_playback_sessions = {}
_playback_sessions_lock = threading.Lock()

# Upload and download completion keep their long-standing inspection helpers
# patchable for callers while sharing one ffprobe invocation in production.
# Results are consumed immediately by the publishing worker and keyed by the
# unique temporary/final path so concurrent completions cannot cross wires.
_media_probe_cache = {}
_media_probe_cache_lock = threading.Lock()

# Waiting jobs are data, not sleeping threads. Reserve both limits under one
# lock; skip blocked hosts while retaining FIFO order within each hostname.
_worker_condition = threading.Condition()
_worker_queue = []
_active_worker_count = 0
_worker_hosts = {}
# Terminal status is visible before a worker has necessarily unwound its
# yt-dlp stack. Keep that resource-ownership lifetime separate from the slot
# counter so removal cannot unlink a file the worker still has open.
_live_worker_ids = set()


DB_BUSY_TIMEOUT_SECONDS = 1.0
DB_SLOW_TRANSACTION_SECONDS = 0.25


def _is_database_busy(error):
    code = getattr(error, 'sqlite_errorcode', None)
    if code is not None:
        # Extended result codes retain the primary result in the low byte.
        return code & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)
    return str(error).lower() in ('database is locked', 'database table is locked')


@app.errorhandler(sqlite3.OperationalError)
def database_operation_failed(error):
    if not _is_database_busy(error):
        raise error
    # In particular, an unavailable account lookup is not an invalid session.
    # Leave the cookie intact, but never authorize from cached account state.
    response = jsonify(error='Database is busy; please retry shortly',
                       code='database_busy', retryable=True)
    response.status_code = 503
    response.headers['Retry-After'] = '1'
    response.headers['Cache-Control'] = 'no-store'
    return response


@contextmanager
def db():
    """Bound lock waits and atomically commit or roll back each operation."""
    # Capture only the caller's function name, never SQL, parameters, or locals.
    operation = sys._getframe(2).f_code.co_name
    started = time.perf_counter()
    execution_seconds = commit_seconds = 0.0
    phase = 'execution'
    failure = None
    conn = None
    try:
        conn = sqlite3.connect(DB_PATH, timeout=DB_BUSY_TIMEOUT_SECONDS)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        yield conn
        execution_seconds = time.perf_counter() - started
        phase = 'commit'
        started = time.perf_counter()
        conn.commit()
        commit_seconds = time.perf_counter() - started
    except BaseException as error:
        failure = error
        if conn is not None:
            conn.rollback()
        raise
    finally:
        elapsed = time.perf_counter() - started
        if phase == 'execution':
            execution_seconds = elapsed
        else:
            commit_seconds = elapsed
        if conn is not None:
            conn.close()
        busy = isinstance(failure, sqlite3.Error) and _is_database_busy(failure)
        if (busy or execution_seconds >= DB_SLOW_TRANSACTION_SECONDS
                or commit_seconds >= DB_SLOW_TRANSACTION_SECONDS):
            app.logger.warning(
                'sqlite timestamp=%s operation=%s thread=%s thread_name=%s phase=%s '
                'execution_seconds=%.3f commit_seconds=%.3f result=%s code=%s',
                time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                operation, threading.get_ident(), threading.current_thread().name, phase,
                execution_seconds, commit_seconds,
                getattr(failure, 'sqlite_errorname', 'busy' if busy else
                        'error' if failure is not None else 'ok'),
                getattr(failure, 'sqlite_errorcode', None),
            )


def init_db():
    with db() as conn:
        try:
            mode = conn.execute('PRAGMA journal_mode = WAL').fetchone()[0]
        except sqlite3.Error as error:
            raise RuntimeError(
                'Unable to enable SQLite WAL; use writable local storage '
                'that supports WAL shared memory and stop competing database users'
            ) from error
        if mode.lower() != 'wal':
            raise RuntimeError(
                'SQLite WAL is required; use writable local storage '
                'that supports WAL shared memory'
            )
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS downloads (
                id           TEXT PRIMARY KEY,
                url          TEXT NOT NULL,
                status       TEXT NOT NULL,
                progress     TEXT NOT NULL DEFAULT '0%',
                created_at   REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS preferences (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_rotation (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                generation_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                expires_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_rotation_members (
                download_id TEXT PRIMARY KEY,
                position INTEGER NOT NULL UNIQUE CHECK (position >= 0)
            );
            CREATE TABLE IF NOT EXISTS app_config (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS roles (
                id   INTEGER PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE
            );
            CREATE TABLE IF NOT EXISTS users (
                id              INTEGER PRIMARY KEY,
                username        TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash   TEXT,
                suspended       INTEGER NOT NULL DEFAULT 0
                                CHECK (suspended IN (0, 1)),
                session_version INTEGER NOT NULL DEFAULT 0,
                created_at      REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_roles (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, role_id)
            );
            CREATE TABLE IF NOT EXISTS tags (
                id              INTEGER PRIMARY KEY,
                name            TEXT NOT NULL,
                normalized_name TEXT NOT NULL UNIQUE,
                created_at      REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS download_tags (
                download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
                tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                created_at  REAL NOT NULL,
                PRIMARY KEY (download_id, tag_id)
            );
            CREATE TABLE IF NOT EXISTS playlists (
                id                 TEXT PRIMARY KEY,
                owner_user_id      INTEGER NOT NULL
                                         REFERENCES users(id) ON DELETE CASCADE,
                name               TEXT NOT NULL,
                revision           INTEGER NOT NULL DEFAULT 1,
                created_at         REAL NOT NULL,
                content_updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlist_items (
                playlist_id TEXT NOT NULL
                                 REFERENCES playlists(id) ON DELETE CASCADE,
                download_id TEXT NOT NULL
                                 REFERENCES downloads(id) ON DELETE CASCADE,
                position    INTEGER NOT NULL CHECK (position >= 0),
                added_at    REAL NOT NULL,
                PRIMARY KEY (playlist_id, download_id),
                UNIQUE (playlist_id, position)
            );
            CREATE TABLE IF NOT EXISTS playlist_progress (
                playlist_id     TEXT PRIMARY KEY
                                     REFERENCES playlists(id) ON DELETE CASCADE,
                download_id     TEXT REFERENCES downloads(id) ON DELETE SET NULL,
                position_seconds REAL NOT NULL DEFAULT 0,
                completed       INTEGER NOT NULL DEFAULT 0
                                      CHECK (completed IN (0, 1)),
                write_sequence  INTEGER NOT NULL DEFAULT 0,
                updated_at      REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS playlists_owner_updated
                ON playlists(owner_user_id, content_updated_at DESC, id);
            CREATE INDEX IF NOT EXISTS playlist_items_download
                ON playlist_items(download_id);
            CREATE TABLE IF NOT EXISTS ingest_receipts (
                source_path TEXT PRIMARY KEY,
                device      INTEGER NOT NULL,
                inode       INTEGER NOT NULL,
                filesize    INTEGER NOT NULL,
                mtime_ns    INTEGER NOT NULL,
                download_id TEXT NOT NULL,
                ingested_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS media_hashes (
                download_id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
                algorithm TEXT NOT NULL DEFAULT 'sha256',
                digest TEXT,
                byte_size INTEGER,
                device INTEGER,
                inode INTEGER,
                mtime_ns INTEGER,
                state TEXT NOT NULL DEFAULT 'pending'
            );
            CREATE INDEX IF NOT EXISTS media_hashes_match
                ON media_hashes(byte_size, digest);
            CREATE TABLE IF NOT EXISTS extension_tokens (
                id                     TEXT PRIMARY KEY,
                user_id                INTEGER NOT NULL
                                           REFERENCES users(id) ON DELETE CASCADE,
                token_verifier         BLOB NOT NULL,
                device_label           TEXT NOT NULL,
                extension_version      TEXT NOT NULL,
                protocol_version       INTEGER NOT NULL,
                paired_session_version INTEGER NOT NULL,
                created_at             REAL NOT NULL,
                last_used_at           REAL
            );
            CREATE INDEX IF NOT EXISTS extension_tokens_user_id
                ON extension_tokens(user_id);
            CREATE INDEX IF NOT EXISTS download_tags_tag_id
                ON download_tags(tag_id);
            CREATE TRIGGER IF NOT EXISTS delete_unused_tag
            AFTER DELETE ON download_tags
            BEGIN
                DELETE FROM tags
                WHERE id = OLD.tag_id
                  AND NOT EXISTS (
                      SELECT 1 FROM download_tags WHERE tag_id = OLD.tag_id
                  );
            END;
        """)
        # New tables are additive, so retained database volumes need no rebuild.
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS library_storage_snapshot (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                measured_at REAL,
                next_refresh_at REAL,
                retry_at REAL,
                failed INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO library_storage_snapshot(singleton) VALUES (1);
            CREATE TABLE IF NOT EXISTS library_storage_members (
                download_id TEXT PRIMARY KEY,
                entry_created_at REAL NOT NULL,
                device TEXT NOT NULL,
                inode TEXT NOT NULL,
                byte_size INTEGER NOT NULL CHECK (byte_size >= 0)
            );
            CREATE TABLE IF NOT EXISTS library_storage_roots (
                path TEXT PRIMARY KEY,
                device TEXT NOT NULL,
                inode TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS library_storage_staging_roots (
                generation TEXT NOT NULL,
                path TEXT NOT NULL,
                device TEXT NOT NULL,
                inode TEXT NOT NULL,
                PRIMARY KEY (generation, path)
            );
            CREATE TABLE IF NOT EXISTS library_storage_staging (
                generation TEXT NOT NULL,
                download_id TEXT NOT NULL,
                entry_created_at REAL NOT NULL,
                filename TEXT NOT NULL,
                output_dir TEXT,
                device TEXT NOT NULL,
                inode TEXT NOT NULL,
                byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
                mtime_ns INTEGER NOT NULL,
                PRIMARY KEY (generation, download_id)
            );
        """)
        # --- lightweight migrations: add new columns if missing ---
        existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(downloads)")}
        for col, ddl in [
            ("filename",   "ALTER TABLE downloads ADD COLUMN filename TEXT"),
            ("resolution", "ALTER TABLE downloads ADD COLUMN resolution TEXT"),
            ("filesize",   "ALTER TABLE downloads ADD COLUMN filesize INTEGER"),
            ("speed",      "ALTER TABLE downloads ADD COLUMN speed REAL"),
            ("eta",        "ALTER TABLE downloads ADD COLUMN eta INTEGER"),
            ("title",      "ALTER TABLE downloads ADD COLUMN title TEXT"),
            ("finished_at", "ALTER TABLE downloads ADD COLUMN finished_at REAL"),
            # 'formats' stores a JSON array of available format descriptors
            # captured from yt_dlp.extract_info() before the actual download
            # starts, so the UI can show alternatives when the requested
            # format is unavailable.
            ("formats",    "ALTER TABLE downloads ADD COLUMN formats TEXT"),
            # The yt-dlp 'format' selector string that was used to start
            # this download (e.g. 'bestvideo+bestaudio/best'). Persisted so
            # the History tab can explain *why* a 'Requested format is not
            # available' error happened.
            ("requested_format", "ALTER TABLE downloads ADD COLUMN requested_format TEXT"),
            # Snapshot the directory used by this worker. Preferences can
            # change before a cancelled entry is removed, and early partials
            # may exist before yt-dlp reports a filename.
            ("output_dir", "ALTER TABLE downloads ADD COLUMN output_dir TEXT"),
            # Keep the user's basename separate from yt-dlp's reported path.
            # Resumed workers need the same template to find existing parts.
            ("requested_filename", "ALTER TABLE downloads ADD COLUMN requested_filename TEXT"),
            # Progress percentages are presentation data. Keep the underlying
            # byte counts so every client can aggregate jobs without losing
            # precision or giving small and large downloads equal weight.
            ("downloaded_bytes", "ALTER TABLE downloads ADD COLUMN downloaded_bytes INTEGER"),
            ("total_bytes", "ALTER TABLE downloads ADD COLUMN total_bytes INTEGER"),
            # Existing libraries start unstarred; favorites are an explicit
            # user choice rather than something inferred during migration.
            ("favorite", "ALTER TABLE downloads ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0"),
            ("favorite_revision", "ALTER TABLE downloads ADD COLUMN favorite_revision INTEGER NOT NULL DEFAULT 0"),
            ("tags_revision", "ALTER TABLE downloads ADD COLUMN tags_revision INTEGER NOT NULL DEFAULT 0"),
            ("rename_revision", "ALTER TABLE downloads ADD COLUMN rename_revision INTEGER NOT NULL DEFAULT 0"),
            ("command_revision", "ALTER TABLE downloads ADD COLUMN command_revision INTEGER NOT NULL DEFAULT 0"),
            ("removal_revision", "ALTER TABLE downloads ADD COLUMN removal_revision INTEGER NOT NULL DEFAULT 0"),
            # A view is an explicit preview activation. Keeping the counter
            # independent of media requests avoids counting range fetches,
            # downloads, and generated hover previews as watches.
            ("view_count", "ALTER TABLE downloads ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0"),
            # URL downloads and local uploads share the library, but upload
            # rows have no remote source or requested yt-dlp format.
            ("source_type", "ALTER TABLE downloads ADD COLUMN source_type TEXT NOT NULL DEFAULT 'download'"),
            # Keep both the stable account identity and a display-name
            # snapshot. The snapshot still identifies the downloader after an
            # administrator removes that account; the join below reflects
            # account renames while it exists.
            ("owner_user_id", "ALTER TABLE downloads ADD COLUMN owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL"),
            ("owner_username", "ALTER TABLE downloads ADD COLUMN owner_username TEXT"),
            # Existing shared libraries must remain visible after upgrading.
            ("visibility", "ALTER TABLE downloads ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private'))"),
            # Browser credentials remain process-only; these fields record only
            # the download's resume policy and idempotency key.
            ("browser_authenticated", "ALTER TABLE downloads ADD COLUMN browser_authenticated INTEGER NOT NULL DEFAULT 0"),
            ("extension_request_id", "ALTER TABLE downloads ADD COLUMN extension_request_id TEXT"),
            # Final-container metadata is probed after publishing decisions,
            # never inferred from a source stream that may later be remuxed.
            ("duration_seconds", "ALTER TABLE downloads ADD COLUMN duration_seconds REAL"),
            ("media_metadata_probed", "ALTER TABLE downloads ADD COLUMN media_metadata_probed INTEGER NOT NULL DEFAULT 0"),
            ("display_filename", "ALTER TABLE downloads ADD COLUMN display_filename TEXT"),
            # Receipts can move to a later import of the same source path;
            # each History row still needs its own permanent origin.
            ("ingest_source_path", "ALTER TABLE downloads ADD COLUMN ingest_source_path TEXT"),
        ]:
            if col not in existing_cols:
                conn.execute(ddl)
        # Triggers include legacy clients, imports and cleanup writers, so each
        # metadata revision stays independent of progress and other domains.
        conn.executescript("""
            CREATE TRIGGER IF NOT EXISTS download_rename_revision
            AFTER UPDATE OF filename, display_filename ON downloads
            WHEN NEW.filename IS NOT OLD.filename OR NEW.display_filename IS NOT OLD.display_filename BEGIN
                UPDATE downloads SET rename_revision = OLD.rename_revision + 1
                WHERE id = NEW.id;
            END;
            CREATE TRIGGER IF NOT EXISTS download_removal_revision
            AFTER UPDATE OF filename, display_filename, status, command_revision, output_dir, source_type, owner_user_id, visibility ON downloads
            WHEN NEW.filename IS NOT OLD.filename OR NEW.display_filename IS NOT OLD.display_filename
              OR NEW.status IS NOT OLD.status OR NEW.command_revision IS NOT OLD.command_revision
              OR NEW.output_dir IS NOT OLD.output_dir OR NEW.source_type IS NOT OLD.source_type
              OR NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.visibility IS NOT OLD.visibility BEGIN
                UPDATE downloads SET removal_revision = removal_revision + 1 WHERE id = NEW.id;
            END;
            CREATE TABLE IF NOT EXISTS removal_operations (
                actor_id INTEGER NOT NULL,
                mutation_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                actor_session_version INTEGER NOT NULL,
                expected_revision TEXT NOT NULL,
                scope TEXT NOT NULL,
                artifacts TEXT NOT NULL,
                phase TEXT NOT NULL,
                recorded_at REAL NOT NULL,
                PRIMARY KEY(actor_id, mutation_id)
            );
            CREATE INDEX IF NOT EXISTS removal_operations_target ON removal_operations(target_id, phase);
            CREATE TABLE IF NOT EXISTS bulk_clear_scopes (
                id TEXT PRIMARY KEY,
                actor_id INTEGER NOT NULL,
                actor_session_version INTEGER NOT NULL,
                kind TEXT NOT NULL,
                mutation_id TEXT,
                fingerprint TEXT,
                revision INTEGER NOT NULL DEFAULT 0,
                phase TEXT NOT NULL DEFAULT 'preview',
                created_at REAL NOT NULL,
                recorded_at REAL NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS bulk_clear_mutation
                ON bulk_clear_scopes(actor_id, mutation_id);
            CREATE INDEX IF NOT EXISTS bulk_clear_actor_phase
                ON bulk_clear_scopes(actor_id, phase);
            CREATE TABLE IF NOT EXISTS bulk_clear_targets (
                scope_id TEXT NOT NULL REFERENCES bulk_clear_scopes(id) ON DELETE CASCADE,
                target_id TEXT NOT NULL,
                expected_revision TEXT NOT NULL,
                child_mutation_id TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'pending',
                files_deleted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(scope_id, target_id)
            );
            CREATE INDEX IF NOT EXISTS bulk_clear_child
                ON bulk_clear_targets(child_mutation_id, scope_id);
            CREATE TABLE IF NOT EXISTS rename_operations (
                actor_id INTEGER NOT NULL,
                mutation_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                actor_session_version INTEGER NOT NULL,
                expected_revision TEXT NOT NULL,
                source TEXT NOT NULL,
                destination TEXT NOT NULL,
                anchor TEXT NOT NULL,
                identity TEXT NOT NULL,
                display_name TEXT,
                phase TEXT NOT NULL,
                recorded_at REAL NOT NULL,
                PRIMARY KEY(actor_id, mutation_id)
            );
            CREATE INDEX IF NOT EXISTS rename_operations_target ON rename_operations(target_id, phase);
            CREATE TRIGGER IF NOT EXISTS download_favorite_revision
            AFTER UPDATE OF favorite ON downloads WHEN NEW.favorite != OLD.favorite BEGIN
                UPDATE downloads SET favorite_revision = OLD.favorite_revision + 1
                WHERE id = NEW.id;
            END;
            CREATE TRIGGER IF NOT EXISTS download_tag_insert_revision
            AFTER INSERT ON download_tags BEGIN
                UPDATE downloads SET tags_revision = tags_revision + 1
                WHERE id = NEW.download_id;
            END;
            CREATE TRIGGER IF NOT EXISTS download_tag_delete_revision
            AFTER DELETE ON download_tags BEGIN
                UPDATE downloads SET tags_revision = tags_revision + 1
                WHERE id = OLD.download_id;
            END;
            CREATE TABLE IF NOT EXISTS retired_download_ids (
                id TEXT PRIMARY KEY
            );
            CREATE TRIGGER IF NOT EXISTS retire_download_identity
            AFTER DELETE ON downloads BEGIN
                INSERT OR IGNORE INTO retired_download_ids(id) VALUES (OLD.id);
            END;
            CREATE TRIGGER IF NOT EXISTS reject_retired_download_identity
            BEFORE INSERT ON downloads WHEN EXISTS (
                SELECT 1 FROM retired_download_ids WHERE id = NEW.id
            ) BEGIN
                SELECT RAISE(ABORT, 'Download identities cannot be reused');
            END;
            CREATE TABLE IF NOT EXISTS mutation_receipts (
                actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                mutation_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                status INTEGER NOT NULL,
                response TEXT NOT NULL,
                recorded_at REAL NOT NULL,
                PRIMARY KEY(actor_id, mutation_id)
            );
            CREATE INDEX IF NOT EXISTS mutation_receipts_retention
                ON mutation_receipts(recorded_at);
            CREATE INDEX IF NOT EXISTS mutation_receipts_admission
                ON mutation_receipts(actor_id, recorded_at);
        """)
        conn.execute(
            "UPDATE downloads SET ingest_source_path = ("
            "SELECT source_path FROM ingest_receipts "
            "WHERE ingest_receipts.download_id = downloads.id) "
            "WHERE ingest_source_path IS NULL AND EXISTS ("
            "SELECT 1 FROM ingest_receipts "
            "WHERE ingest_receipts.download_id = downloads.id)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS downloads_extension_request "
            "ON downloads(owner_user_id, extension_request_id) "
            "WHERE extension_request_id IS NOT NULL"
        )

        existing_user_cols = {
            row["name"] for row in conn.execute("PRAGMA table_info(users)")
        }
        for col, ddl in [
            # Login names remain stable account identifiers while this field
            # gives the administration UI a human-readable label.
            ("name", "ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT ''"),
        ]:
            if col not in existing_user_cols:
                conn.execute(ddl)
        conn.execute(
            "UPDATE users SET name = username WHERE name = ''"
        )

        existing_progress_cols = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(playlist_progress)")
        }
        if "write_sequence" not in existing_progress_cols:
            conn.execute(
                "ALTER TABLE playlist_progress ADD COLUMN "
                "write_sequence INTEGER NOT NULL DEFAULT 0"
            )

        # Roles are rows rather than a users-table enum so deployments can add
        # role names later without another schema migration. The join table is
        # intentionally many-to-many even though today's UI assigns one role.
        for role_name in ('normal', 'admin'):
            conn.execute(
                "INSERT OR IGNORE INTO roles(name) VALUES (?)",
                (role_name,),
            )
        bootstrap_created = conn.execute(
            "SELECT 1 FROM app_config WHERE key = 'bootstrap_admin_created'"
        ).fetchone()
        if bootstrap_created is None:
            conn.execute(
                "INSERT OR IGNORE INTO users(username, name, password_hash, created_at) "
                "VALUES ('admin', 'admin', NULL, ?)",
                (time.time(),),
            )
            conn.execute(
                "INSERT OR IGNORE INTO user_roles(user_id, role_id) "
                "SELECT users.id, roles.id FROM users, roles "
                "WHERE users.username = 'admin' AND roles.name = 'admin'"
            )
            # The marker, rather than the username, records bootstrap. An
            # administrator may rename the account without init_db recreating
            # a new passwordless account named "admin" on the next restart.
            conn.execute(
                "INSERT INTO app_config(key, value) VALUES (?, ?)",
                ('bootstrap_admin_created', '1'),
            )

        # Persisting the signing key keeps browser sessions valid across clean
        # restarts without asking operators to manage another required secret.
        conn.execute(
            "INSERT OR IGNORE INTO app_config(key, value) VALUES (?, ?)",
            ('session_secret', secrets.token_hex(32)),
        )
        app.secret_key = conn.execute(
            "SELECT value FROM app_config WHERE key = 'session_secret'"
        ).fetchone()['value']
        # Seed defaults only if missing.
        defaults = {
            "download_dir": DEFAULT_DOWNLOAD_DIR,
            "format": "best",
            "history_page_size": "10",
            "max_concurrent": "3",
            "max_concurrent_per_host": "2",
            "max_total_download_mbps": "0",
            "player_mode": "overlay",
            "start_fullscreen": "false",
            "skip_video_edges": "false",
            "shuffle_min_height": "0",
            "shuffle_min_duration_minutes": "0",
            "library_rotation_enabled": "false",
            "library_rotation_hours": "24",
            "theme": "system",
        }
        for k, v in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO preferences(key, value) VALUES (?, ?)",
                (k, v),
            )

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS preference_state (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                revision INTEGER NOT NULL DEFAULT 0,
                runtime_pending INTEGER NOT NULL DEFAULT 1
            );
            INSERT OR IGNORE INTO preference_state(singleton) VALUES (1);
            UPDATE preference_state SET runtime_pending = 1;
            CREATE TRIGGER IF NOT EXISTS preference_insert_revision
            AFTER INSERT ON preferences BEGIN
                UPDATE preference_state SET revision = revision + 1, runtime_pending = 1;
            END;
            CREATE TRIGGER IF NOT EXISTS preference_update_revision
            AFTER UPDATE ON preferences WHEN NEW.key IS NOT OLD.key OR NEW.value IS NOT OLD.value BEGIN
                UPDATE preference_state SET revision = revision + 1, runtime_pending = 1;
            END;
            CREATE TRIGGER IF NOT EXISTS preference_delete_revision
            AFTER DELETE ON preferences BEGIN
                UPDATE preference_state SET revision = revision + 1, runtime_pending = 1;
            END;
        """)

        # Tags have no independent lifecycle. This also repairs orphan rows
        # left by an interrupted migration or a manually edited database.
        conn.execute(
            "DELETE FROM tags WHERE NOT EXISTS ("
            "SELECT 1 FROM download_tags WHERE tag_id = tags.id)"
        )

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS download_commands (
                id TEXT PRIMARY KEY,
                actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                mutation_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                actor_session_version INTEGER NOT NULL,
                action TEXT NOT NULL,
                source_attempt_id TEXT,
                attempt_id TEXT,
                phase TEXT NOT NULL,
                recorded_at REAL NOT NULL,
                UNIQUE(actor_id, mutation_id)
            );
            CREATE INDEX IF NOT EXISTS download_commands_target ON download_commands(target_id, phase);
            CREATE INDEX IF NOT EXISTS download_commands_attempt ON download_commands(attempt_id, recorded_at, id);
        """)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS upload_operations (
                id TEXT PRIMARY KEY REFERENCES downloads(id) ON DELETE CASCADE,
                actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                actor_session_version INTEGER NOT NULL,
                mutation_id TEXT,
                fingerprint TEXT NOT NULL,
                attempt_id TEXT,
                phase TEXT NOT NULL DEFAULT 'registered',
                revision INTEGER NOT NULL DEFAULT 1,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                temporary_path TEXT,
                final_path TEXT,
                device TEXT,
                inode TEXT,
                cleanup_pending INTEGER NOT NULL DEFAULT 0,
                retired_paths TEXT NOT NULL DEFAULT '[]',
                recorded_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS upload_operations_actor
                ON upload_operations(actor_id, phase, recorded_at);
        """)
        download_history.initialize(conn)
        conn.executescript("""
            CREATE TRIGGER IF NOT EXISTS download_attempt_delete_command_revision
            AFTER DELETE ON download_attempts BEGIN
                UPDATE downloads SET command_revision = command_revision + 1 WHERE id = OLD.work_id;
            END;
            CREATE TRIGGER IF NOT EXISTS download_attempt_command_revision
            AFTER INSERT ON download_attempts BEGIN
                UPDATE downloads SET command_revision = command_revision + 1 WHERE id = NEW.work_id;
            END;
        """)
        # No previous-process thread survives. An accepted but undispatched job
        # is interrupted too; restarting must never repeat filesystem effects.
        conn.execute("UPDATE download_commands SET phase = 'interrupted' "
                     "WHERE phase IN ('accepted', 'dispatching', 'dispatched')")
        AssetQueue.init_schema(conn)

        # Any download that was active when the app died is now orphaned.
        # 'paused' counts as active for this purpose -- the worker thread
        # was holding the connection open and is gone now.
        conn.execute(
            "UPDATE downloads SET status = 'interrupted', progress = 'Interrupted' "
            "WHERE status IN ('starting', 'downloading', 'paused')"
        )
    _recover_upload_operations()
    _recover_rename_operations()
    _recover_removal_operations()
    _recover_bulk_clear_operations()
    _reconcile_preference_runtime(restore_rotation=False)
    # The debug reloader's parent must not renew the shared deck alongside
    # its serving child. Ordinary WSGI imports still own their deadline timer.
    if (__name__ != '__main__'
            or os.environ.get('FLASK_DEBUG', '1') != '1'
            or os.environ.get('WERKZEUG_RUN_MAIN') == 'true'):
        _restore_rotation_timer()
    if ((__name__ != '__main__' and os.environ.get('FLASK_RUN_FROM_CLI') != 'true')
            or os.environ.get('FLASK_DEBUG', '1') != '1'
            or os.environ.get('WERKZEUG_RUN_MAIN') == 'true'):
        start_library_storage()


def db_insert_download(download_id, url, owner_user_id=None,
                       owner_username=None):
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO downloads(id, url, status, progress, created_at, "
            "owner_user_id, owner_username) "
            "VALUES (?, ?, 'starting', '0%', ?, ?, ?)",
            (
                download_id, url, time.time(), owner_user_id,
                owner_username,
            ),
        )
        download_history.record(conn, download_id, create=True)
    event_bus.publish('change', {'reason': 'insert', 'id': download_id})


def db_insert_upload(download_id, upload_name, title, filesize, output_dir,
                     owner_user_id=None, owner_username=None):
    """Register a local upload before the browser starts transferring it."""
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO downloads("
            "id, url, status, progress, created_at, filesize, title, "
            "output_dir, requested_filename, downloaded_bytes, total_bytes, "
            "source_type, owner_user_id, owner_username"
            ") VALUES (?, '', 'starting', '0%', ?, ?, ?, ?, ?, 0, ?, "
            "'upload', ?, ?)",
            (
                download_id, time.time(), filesize, title, output_dir,
                upload_name, filesize, owner_user_id, owner_username,
            ),
        )
        download_history.record(conn, download_id, create=True)
    event_bus.publish('change', {'reason': 'insert', 'id': download_id})


def db_insert_ingested_video(download_id, source_path, source_signature,
                             upload_name, title, filesize, output_dir,
                             filename, resolution, duration_seconds=None,
                             content_hash=None, folder_tags=()):
    """Atomically register a mounted video, receipt, tags, and final hash."""
    now = time.time()
    device, inode, _signature_size, mtime_ns = source_signature
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO downloads("
            "id, url, status, progress, created_at, filename, resolution, "
            "duration_seconds, media_metadata_probed, "
            "filesize, speed, eta, title, finished_at, output_dir, "
            "requested_filename, display_filename, ingest_source_path, "
            "downloaded_bytes, total_bytes, source_type"
            ") VALUES (?, '', 'finished', '100%', ?, ?, ?, ?, 1, ?, 0, 0, ?, ?, "
            "?, ?, ?, ?, ?, ?, 'upload')",
            (
                download_id, now, filename, resolution, duration_seconds,
                filesize, title, now,
                output_dir, upload_name, upload_name, source_path,
                filesize, filesize,
            ),
        )
        conn.execute(
            "INSERT INTO ingest_receipts("
            "source_path, device, inode, filesize, mtime_ns, download_id, "
            "ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(source_path) DO UPDATE SET "
            "device = excluded.device, inode = excluded.inode, "
            "filesize = excluded.filesize, mtime_ns = excluded.mtime_ns, "
            "download_id = excluded.download_id, "
            "ingested_at = excluded.ingested_at",
            (
                source_path, device, inode, filesize, mtime_ns, download_id,
                now,
            ),
        )
        for tag_name in folder_tags:
            display_name, normalized_name = _validated_tag_name(tag_name)
            conn.execute(
                "INSERT OR IGNORE INTO tags(name, normalized_name, created_at) "
                "VALUES (?, ?, ?)",
                (display_name, normalized_name, now),
            )
            conn.execute(
                "INSERT OR IGNORE INTO download_tags(download_id, tag_id, created_at) "
                "SELECT ?, id, ? FROM tags WHERE normalized_name = ?",
                (download_id, now, normalized_name),
            )
        if content_hash is not None:
            digest, identity = content_hash
            conn.execute(
                "INSERT INTO media_hashes(download_id, algorithm, digest, "
                "byte_size, device, inode, mtime_ns, state) "
                "VALUES (?, 'sha256', ?, ?, ?, ?, ?, 'ready')",
                (download_id, digest, identity[2], identity[0],
                 identity[1], identity[3]),
            )
        download_history.record(conn, download_id, create=True)
    _register_media_assets(download_id)
    event_bus.publish('change', {'reason': 'insert', 'id': download_id})


def _path_is_below(path, directory):
    try:
        path = os.path.abspath(path)
        directory = os.path.abspath(directory)
        return path != directory and os.path.commonpath((path, directory)) == directory
    except (TypeError, ValueError):
        return False


def db_get_ingest_receipts(directory):
    """Return source signatures below this ingest root, including children."""
    directory = os.path.realpath(directory)
    with db() as conn:
        rows = conn.execute(
            "SELECT source_path, device, inode, filesize, mtime_ns "
            "FROM ingest_receipts"
        ).fetchall()
    return {
        row['source_path']: (
            row['device'], row['inode'], row['filesize'], row['mtime_ns'],
        )
        for row in rows
        if _path_is_below(row['source_path'], directory)
    }


def db_prune_ingest_receipts(directory, visible_paths):
    """Forget paths absent from a complete startup snapshot."""
    receipts = db_get_ingest_receipts(directory)
    missing = set(receipts).difference(visible_paths)
    if not missing:
        return
    with _db_lock, db() as conn:
        conn.executemany(
            "DELETE FROM ingest_receipts WHERE source_path = ?",
            ((path,) for path in missing),
        )


def db_update_download(download_id, *, status=None, progress=None,
                       filename=None, resolution=None, filesize=None,
                       speed=None, eta=None, title=None, finished_at=None,
                       formats=None, requested_format=None, output_dir=None,
                       requested_filename=None, display_filename=None,
                       downloaded_bytes=None,
                       total_bytes=_NO_UPDATE, duration_seconds=_NO_UPDATE,
                       media_metadata_probed=None):
    fields, values = [], []
    if status is not None:
        fields.append("status = ?"); values.append(status)
    if progress is not None:
        fields.append("progress = ?"); values.append(progress)
    if filename is not None:
        fields.append("filename = ?"); values.append(filename)
    if resolution is not None:
        fields.append("resolution = ?"); values.append(resolution)
    if filesize is not None:
        fields.append("filesize = ?"); values.append(filesize)
    if speed is not None:
        fields.append("speed = ?"); values.append(speed)
    if eta is not None:
        fields.append("eta = ?"); values.append(eta)
    if title is not None:
        fields.append("title = ?"); values.append(title)
    if finished_at is not None:
        fields.append("finished_at = ?"); values.append(finished_at)
    if formats is not None:
        fields.append("formats = ?"); values.append(formats)
    if requested_format is not None:
        fields.append("requested_format = ?"); values.append(requested_format)
    if output_dir is not None:
        fields.append("output_dir = ?"); values.append(output_dir)
    if requested_filename is not None:
        fields.append("requested_filename = ?"); values.append(requested_filename)
    if display_filename is not None:
        fields.append("display_filename = ?"); values.append(display_filename)
    if downloaded_bytes is not None:
        fields.append("downloaded_bytes = ?"); values.append(downloaded_bytes)
    if total_bytes is not _NO_UPDATE:
        fields.append("total_bytes = ?"); values.append(total_bytes)
    if duration_seconds is not _NO_UPDATE:
        fields.append("duration_seconds = ?"); values.append(duration_seconds)
    if media_metadata_probed is not None:
        fields.append("media_metadata_probed = ?")
        values.append(1 if media_metadata_probed else 0)
    if not fields:
        return
    values.append(download_id)
    with _db_lock, db() as conn:
        previous = conn.execute("SELECT status FROM downloads WHERE id = ?", (download_id,)).fetchone()
        conn.execute(
            f"UPDATE downloads SET {', '.join(fields)} WHERE id = ?",
            values,
        )
        if status == 'finished':
            conn.execute(
                "INSERT INTO media_hashes(download_id, state) "
                "VALUES (?, 'pending') ON CONFLICT(download_id) DO UPDATE "
                "SET state = 'pending', digest = NULL, byte_size = NULL "
                "WHERE media_hashes.state != 'ready' OR ? IS NOT NULL",
                (download_id, filename),
            )
        download_history.record(conn, download_id, new=bool(
            previous and previous['status'] in TERMINAL_STATUSES
            and status in download_history.ACTIVE))
    event_bus.publish('change', {'reason': 'update', 'id': download_id})
    if status == 'finished':
        _register_media_assets(download_id)
        _wake_duplicate_backfill()


def db_claim_download_for_resume(download_id):
    """Move one resumable row to starting, returning whether we won."""
    with _db_lock, db() as conn:
        cur = conn.execute(
            "UPDATE downloads SET status = 'starting', progress = '0%', finished_at = NULL "
            "WHERE id = ? AND status IN ('cancelled', 'interrupted')",
            (download_id,),
        )
        claimed = cur.rowcount == 1
        if claimed:
            download_history.record(conn, download_id, new=True)
    if claimed:
        event_bus.publish('change', {'reason': 'update', 'id': download_id})
    return claimed


def _db_download_tags(conn, download_id):
    return [
        tag["name"] for tag in conn.execute(
            "SELECT tags.name FROM tags "
            "JOIN download_tags ON download_tags.tag_id = tags.id "
            "WHERE download_tags.download_id = ? "
            "ORDER BY tags.name COLLATE NOCASE, tags.name",
            (download_id,),
        )
    ]


def db_get_download(download_id):
    with db() as conn:
        conn.execute("BEGIN")
        row = conn.execute(
            "SELECT downloads.*, "
            "COALESCE(users.username, downloads.owner_username) "
            "AS downloaded_by "
            "FROM downloads "
            "LEFT JOIN users ON users.id = downloads.owner_user_id "
            "WHERE downloads.id = ?",
            (download_id,),
        ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result.update(_favorite_snapshot(conn, download_id, row))
        result.update(_rename_snapshot(conn, download_id, row))
        result.update(_download_command_snapshot(conn, download_id, row))
        result["removal_revision"] = str(row["removal_revision"])
        if row['source_type'] == 'upload':
            result['upload'] = _upload_snapshot(conn, download_id)
        result["quality"] = classify_video_quality(result["resolution"])
        result.update(_tag_snapshot(conn, download_id, row))
        return result


def db_set_download_visibility(download_id, visibility):
    """Persist public/private visibility and report whether it changed."""
    if visibility not in ('public', 'private'):
        raise ValueError('Visibility must be public or private')
    with _db_lock, db() as conn:
        row = conn.execute(
            "SELECT visibility FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        if row is None:
            return None
        changed = row['visibility'] != visibility
        if changed:
            conn.execute(
                "UPDATE downloads SET visibility = ? WHERE id = ?",
                (visibility, download_id),
            )
    if changed:
        event_bus.publish(
            'change', {'reason': 'visibility', 'id': download_id}
        )
    return changed


def db_set_download_favorite(download_id, favorite):
    """Persist one explicit favorite state and report whether it changed."""
    with _db_lock, db() as conn:
        row = conn.execute(
            "SELECT favorite FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        if row is None:
            return None
        changed = bool(row["favorite"]) != favorite
        if changed:
            conn.execute(
                "UPDATE downloads SET favorite = ? WHERE id = ?",
                (int(favorite), download_id),
            )
    if changed:
        _publish_metadata_change('favorite')
    return changed


def db_increment_view_count(download_id):
    """Atomically record one explicit playback activation."""
    with _db_lock, db() as conn:
        cursor = conn.execute(
            "UPDATE downloads SET view_count = view_count + 1 "
            "WHERE id = ? AND status = 'finished'",
            (download_id,),
        )
        if cursor.rowcount != 1:
            return None
        view_count = conn.execute(
            "SELECT view_count FROM downloads WHERE id = ?",
            (download_id,),
        ).fetchone()["view_count"]
    event_bus.publish("change", {"reason": "view", "id": download_id})
    return view_count


def classify_video_quality(resolution):
    """Return a compact display tier for a stored video resolution."""
    value = str(resolution or '').strip().lower()
    aliases = {
        '8k': '8k',
        '4k': '4k',
        'uhd': '4k',
        '2k': '2k',
        'qhd': '2k',
    }
    if value in aliases:
        return aliases[value]

    dimensions = re.fullmatch(r'(\d+)\s*[x×]\s*(\d+)', value)
    vertical = re.fullmatch(r'(\d+)\s*p?', value)
    if dimensions:
        height = int(dimensions.group(2))
    elif vertical:
        height = int(vertical.group(1))
    else:
        return None

    for minimum, label in (
        (4320, '8k'),
        (2160, '4k'),
        (1440, '2k'),
        (1080, '1080p'),
        (720, '720p'),
        (480, '480p'),
        (360, '360p'),
    ):
        if height >= minimum:
            return label
    return str(height) if height > 0 else None


TAG_MAX_LENGTH = 64
TAG_IDENTITY_VERSION = 'python-casefold-' + unicodedata.unidata_version + '-v1'
MUTATION_REPLAY_SECONDS = 24 * 60 * 60
MUTATION_RETENTION_SECONDS = 48 * 60 * 60
MUTATION_ACTOR_RECEIPT_LIMIT = 10000
MUTATION_ACTOR_MINUTE_LIMIT = 120
MUTATION_ID_PATTERN = re.compile(r'([0-9]{10,16})-([0-9a-f]{32})\Z')


def _tag_snapshot(conn, download_id, row=None):
    """Serialize values and their revision from the caller's transaction."""
    if row is None:
        row = conn.execute(
            "SELECT tags_revision FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
    if row is None:
        return None
    items = [dict(tag) for tag in conn.execute(
        "SELECT normalized_name AS key, name FROM tags "
        "JOIN download_tags ON download_tags.tag_id = tags.id "
        "WHERE download_tags.download_id = ? "
        "ORDER BY name COLLATE NOCASE, name", (download_id,),
    )]
    return _serialize_tag_state(download_id, items, row['tags_revision'])


def _serialize_tag_state(download_id, items, revision):
    return {
        'id': download_id, 'tags': [item['name'] for item in items],
        'tag_items': items, 'tags_revision': str(revision),
        'tag_identity_version': TAG_IDENTITY_VERSION,
    }


def _tag_actor(conn):
    # Resolve current security state after entering the write serialization seam.
    user = _db_user(conn, 'id = ?', (session.get('user_id'),))
    if (user is None or user['suspended'] or user['password_hash'] is None
            or user['session_version'] != session.get('session_version')):
        return None
    return user


def _tag_visible_row(conn, download_id, actor):
    row = conn.execute(
        "SELECT * "
        "FROM downloads WHERE id = ?", (download_id,),
    ).fetchone()
    if row is not None and (row['visibility'] == 'public'
            or row['owner_user_id'] == actor['id'] or 'admin' in actor['roles']):
        return row
    return None


def _tag_vocabulary(conn, actor):
    return [row['name'] for row in conn.execute(
        "SELECT DISTINCT tags.name FROM tags "
        "JOIN download_tags ON download_tags.tag_id = tags.id "
        "JOIN downloads ON downloads.id = download_tags.download_id "
        "WHERE ? OR downloads.visibility = 'public' OR downloads.owner_user_id = ? "
        "ORDER BY tags.name COLLATE NOCASE, tags.name",
        ('admin' in actor['roles'], actor['id']),
    )]


def _apply_tag(conn, download_id, name, key, method):
    if method == 'POST':
        conn.execute(
            "INSERT OR IGNORE INTO tags(name, normalized_name, created_at) "
            "VALUES (?, ?, ?)", (name, key, time.time()),
        )
        cursor = conn.execute(
            "INSERT OR IGNORE INTO download_tags(download_id, tag_id, created_at) "
            "SELECT ?, id, ? FROM tags WHERE normalized_name = ?",
            (download_id, time.time(), key),
        )
    else:
        cursor = conn.execute(
            "DELETE FROM download_tags WHERE download_id = ? AND tag_id = "
            "(SELECT id FROM tags WHERE normalized_name = ?)",
            (download_id, key),
        )
    return cursor.rowcount == 1


def _favorite_snapshot(conn, download_id, row=None):
    if row is None:
        row = conn.execute(
            'SELECT favorite, favorite_revision FROM downloads WHERE id = ?',
            (download_id,),
        ).fetchone()
    if row is None:
        return None
    return _serialize_favorite_state(download_id, row['favorite'], row['favorite_revision'])


def _serialize_favorite_state(download_id, favorite, revision):
    return {'id': download_id, 'favorite': bool(favorite), 'favorite_revision': str(revision)}


def _publish_metadata_change(domain):
    # Private identities stay on authorized responses. Publication cannot undo
    # the already committed mutation and receipt.
    try:
        event_bus.publish('change', {'reason': 'tag' if domain == 'tags' else domain})
    except Exception:
        app.logger.warning('mutation action=%s outcome=committed publish=failed', domain)


def _publish_tag_change():
    _publish_metadata_change('tags')


def _execute_tag_mutation(download_id, payload, method):
    return _execute_metadata_mutation(download_id, payload, method, 'tags')


def _execute_favorite_mutation(download_id, payload):
    return _execute_metadata_mutation(download_id, payload, 'POST', 'favorite')


def _execute_metadata_mutation(download_id, payload, method, domain):
    # Only the route's trusted adapter selects a domain; all database-backed
    # metadata shares authorization, admission, receipt and commit ordering.
    is_tag = domain == 'tags'
    snapshot = _tag_snapshot if is_tag else _favorite_snapshot
    action = ('tag.add' if method == 'POST' else 'tag.remove') if is_tag else 'favorite.set'
    revision_field = 'tags_revision' if is_tag else 'favorite_revision'
    protocol = 'client_mutation_id' in payload or 'expected_revision' in payload
    mutation_id = payload.get('client_mutation_id')
    changed = False
    with _db_lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        actor = _tag_actor(conn)
        if actor is None:
            return {'error': 'Authentication required'}, 401
        row = _tag_visible_row(conn, download_id, actor)
        if row is None:
            return {'error': 'Unknown download id'}, 404
        state = snapshot(conn, download_id, row)
        error = None
        name = key = submitted_before = None
        if is_tag:
            try:
                name, key = _validated_tag_name(payload.get('tag'))
            except ValueError as exc:
                error = str(exc)
            value = key if key is not None else payload.get('tag')
            submitted_before = next((item for item in state['tag_items'] if item['key'] == key), None)
        else:
            value = payload.get('favorite')
            if not isinstance(value, bool):
                error = 'Favorite must be true or false'

        def apply():
            if is_tag:
                return _apply_tag(conn, download_id, name, key, method)
            if state['favorite'] == value:
                return False
            conn.execute('UPDATE downloads SET favorite = ? WHERE id = ?', (int(value), download_id))
            return True

        if not protocol:
            if error:
                return {'error': error}, 400
            changed = apply()
            result = snapshot(conn, download_id)
            result['changed'] = changed
            if is_tag:
                result['available_tags'] = _tag_vocabulary(conn, actor)
            status = 200
        else:
            match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
            if match is None:
                return {'error': 'Invalid mutation identifier'}, 400
            expected = payload.get('expected_revision')
            fingerprint = hashlib.sha256(json.dumps(
                [method, action, download_id, value, expected],
                sort_keys=True, ensure_ascii=True, separators=(',', ':'),
            ).encode()).hexdigest()
            receipt = conn.execute(
                'SELECT fingerprint, status, response FROM mutation_receipts '
                'WHERE actor_id = ? AND mutation_id = ?', (actor['id'], mutation_id),
            ).fetchone()
            if receipt is not None:
                if receipt['fingerprint'] != fingerprint:
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                result = json.loads(receipt['response'])
                if is_tag:
                    result['available_tags'] = _tag_vocabulary(conn, actor)
                return result, receipt['status']
            if conn.execute('SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ? AND phase != ?',
                            (actor['id'], mutation_id, 'done')).fetchone():
                return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
            now = time.time()
            created = int(match.group(1)) / 1000
            _prune_mutation_receipts(conn, now)
            counts = conn.execute(
                'SELECT COUNT(*) AS total, '
                'COALESCE(SUM(recorded_at > ?), 0) AS recent FROM mutation_receipts '
                'WHERE actor_id = ?', (now - 60, actor['id']),
            ).fetchone()
            active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS (SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
            if (counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT
                    or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT):
                return {'error': 'Too many mutations; wait before submitting more',
                        'code': 'mutation_limit'}, 429
            status, outcome = 200, 'committed'
            if created < now - MUTATION_REPLAY_SECONDS or created > now + 300:
                error, status, outcome = 'Mutation identifier expired or clock is incorrect', 400, 'rejected'
            elif not isinstance(expected, str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', expected):
                error, status, outcome = 'Expected revision must be a decimal string', 400, 'rejected'
            elif error:
                status, outcome = 400, 'rejected'
            elif expected != state[revision_field]:
                error, status, outcome = 'Editable state changed; review the current state', 409, 'conflicted'
            else:
                changed = apply()
                state = snapshot(conn, download_id)
            result = dict(state)
            result.update({
                'changed': changed,
                'mutation': {'id': mutation_id, 'outcome': outcome, 'domain': domain,
                             'revision': state[revision_field]},
                'server_time': int(now * 1000),
            })
            if is_tag:
                canonical = next((item for item in state['tag_items'] if item['key'] == key), submitted_before)
                result.update(available_tags=_tag_vocabulary(conn, actor),
                              submitted_tag=canonical or ({'key': key, 'name': name} if key else None))
            if error:
                result['error'] = error
            conn.execute(
                'INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, '
                'fingerprint, status, response, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (actor['id'], mutation_id, download_id, fingerprint, status,
                 json.dumps({key: value for key, value in result.items()
                             if key != 'available_tags'}, separators=(',', ':')), now),
            )
    if changed:
        if is_tag:
            _publish_tag_change()
        else:
            _publish_metadata_change(domain)
    return result, status


def _rename_snapshot(conn, download_id, row=None):
    if row is None:
        row = conn.execute('SELECT filename, display_filename, rename_revision, removal_revision FROM downloads WHERE id = ?', (download_id,)).fetchone()
    if row is None:
        return None
    return {'id': download_id, 'filename': row['filename'],
            'display_filename': row['display_filename'],
            'rename_revision': str(row['rename_revision']), 'removal_revision': str(row['removal_revision'])}


def _rename_checkpoint(phase, operation):
    """Crash-injection seam; callers have already persisted each boundary."""


def _rename_identity(path):
    # An anchor pins this inode across moves; a hash also detects changed bytes.
    with open(path, 'rb') as media:
        before = os.fstat(media.fileno())
        if not stat.S_ISREG(before.st_mode) or os.path.islink(path):
            raise OSError('Unsupported file identity')
        digest = hashlib.file_digest(media, 'sha256').hexdigest()
        after = os.fstat(media.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise OSError('File changed during rename')
    return {'device': before.st_dev, 'inode': before.st_ino,
            'size': before.st_size, 'mtime': before.st_mtime_ns,
            'ctime': before.st_ctime_ns, 'digest': digest}


def _rename_matches(path, identity, *, pristine=False):
    try:
        current = _rename_identity(path)
    except OSError:
        return False
    keys = ('device', 'inode', 'size', 'mtime', 'digest')
    if pristine:
        keys += ('ctime',)
    return all(current[key] == identity[key] for key in keys)


def _rename_noreplace(source, destination):
    # Source retirement must be atomic: checking then unlinking source can
    # delete an unrelated file installed between those two operations.
    if os.name == 'nt':
        os.rename(source, destination)
        return
    library = ctypes.CDLL(None, use_errno=True)
    rename = getattr(library, 'renameat2', None)
    if rename is None:
        raise OSError(errno.ENOTSUP, 'Safe source retirement unavailable')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def _rename_sync(directory):
    fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _rename_phase(operation, phase):
    with _db_lock, db() as conn:
        conn.execute('UPDATE rename_operations SET phase = ? WHERE actor_id = ? AND mutation_id = ?',
                     (phase, operation['actor_id'], operation['mutation_id']))
    operation['phase'] = phase
    _rename_checkpoint(phase, operation)


def _rename_authorized(conn, operation, request_actor):
    actor = (_tag_actor(conn) if request_actor else
             _db_user(conn, 'id = ?', (operation['actor_id'],)))
    if (actor is None or actor['suspended'] or actor['password_hash'] is None
            or actor['session_version'] != operation['actor_session_version']):
        return None, None, 401
    row = _tag_visible_row(conn, operation['target_id'], actor)
    return actor, row, 200 if row is not None else 404


def _rename_unresolved():
    # Recovery paths and filesystem exception text are intentionally private.
    return {'error': 'Rename not confirmed. File recovery requires intervention.',
            'code': 'rename_recovery_required'}, 503


def _assert_no_pending_rename(entry, exclude=None):
    with db() as conn:
        operations = conn.execute('SELECT * FROM rename_operations').fetchall()
        removals = conn.execute("SELECT * FROM removal_operations WHERE phase NOT IN ('done', 'cleaned')").fetchall()
        upload = conn.execute('SELECT cleanup_pending FROM upload_operations WHERE id=?', (entry['id'],)).fetchone()
        if upload and upload['cleanup_pending']:
            raise OSError('Upload recovery requires intervention before another file operation')
    path = entry.get('filename')
    real = os.path.realpath(path) if path else None
    for removal in removals:
        if entry['id'] == removal['target_id'] or any(real == os.path.realpath(item['source'])
                for item in json.loads(removal['artifacts'])):
            raise OSError('Removal recovery requires intervention before another file operation')
    for operation in operations:
        if exclude == (operation['actor_id'], operation['mutation_id']):
            continue
        identity = json.loads(operation['identity'])
        same_file = False
        if path:
            try:
                info = os.stat(path)
                same_file = (info.st_dev, info.st_ino) == (identity.get('device'), identity.get('inode'))
            except OSError:
                pass
        if (entry['id'] == operation['target_id'] or same_file or
                real in (operation['source'], operation['destination'])):
            raise OSError('Rename recovery requires intervention before another file operation')


def _rename_aliases_authorized(conn, operation, actor):
    if operation['display_name'] is not None:
        return True
    aliases = conn.execute('SELECT id, filename, status FROM downloads WHERE filename IS NOT NULL').fetchall()
    return all(alias['status'] not in ('starting', 'downloading', 'paused')
               and alias['id'] not in _live_worker_ids
               and _tag_visible_row(conn, alias['id'], actor) is not None
               for alias in aliases if os.path.abspath(alias['filename']) == operation['source'])


def _retire_rename_source(operation):
    source, anchor = operation['source'], operation['anchor']
    directory = os.path.dirname(source)
    identity = json.loads(operation['identity'])
    retired = anchor + '.retired'
    if os.path.lexists(retired) and not _rename_matches(retired, identity):
        if not os.path.lexists(source):
            _rename_noreplace(retired, source)
            _rename_sync(directory)
        return False
    if os.path.lexists(source) and _rename_matches(source, identity):
        if os.path.lexists(retired):
            os.unlink(retired)
            _rename_sync(directory)
        _rename_noreplace(source, retired)
        _rename_sync(directory)
        _rename_checkpoint('source_retired', operation)
        if not _rename_matches(retired, identity):
            if not os.path.lexists(source):
                _rename_noreplace(retired, source)
                _rename_sync(directory)
            return False
    # A replacement at the old name belongs to somebody else. The pinned
    # inode at destination remains the admitted file identity.
    return True


class _RenameRecoveryRequired(OSError):
    pass


def _rename_done_superseded(operation, entry):
    if entry is None:
        return True
    path = os.path.abspath(entry['filename']) if entry['filename'] else None
    if path not in (operation['source'], operation['destination']):
        return True
    published = json.loads(operation['identity']).get('published_revisions', {})
    revision = published.get(entry['id'])
    return revision is not None and str(entry['rename_revision']) != revision


def _finish_rename_cleanup(operation):
    identity = json.loads(operation['identity'])
    with db() as conn:
        current = conn.execute('SELECT id, filename, rename_revision FROM downloads WHERE id = ?', (operation['target_id'],)).fetchone()
    superseded = _rename_done_superseded(operation, current)
    if not superseded and operation['display_name'] is None and not _rename_matches(operation['destination'], identity):
        _restore_rename_source(operation)
        raise _RenameRecoveryRequired('File recovery requires intervention')
    if not superseded and operation['display_name'] is None and operation['source'] != operation['destination']:
        if not _retire_rename_source(operation):
            raise _RenameRecoveryRequired('File recovery requires intervention')
    retired = operation['anchor'] + '.retired'
    if os.path.lexists(retired) and _rename_matches(retired, identity):
        os.unlink(retired)
        _rename_sync(os.path.dirname(operation['source']))
    if os.path.lexists(operation['anchor']) and _rename_matches(operation['anchor'], identity):
        os.unlink(operation['anchor'])
        _rename_sync(os.path.dirname(operation['source']))
    with _db_lock, db() as conn:
        conn.execute("DELETE FROM rename_operations WHERE actor_id = ? AND mutation_id = ? AND phase = 'done'",
                     (operation['actor_id'], operation['mutation_id']))


class _RenameAuthorizationLost(Exception):
    def __init__(self, status):
        self.status = status


def _restore_rename_source(operation):
    # Compensation repairs the already-confirmed reference without granting a
    # revoked actor a new rename, and never overwrites a replacement pathname.
    if operation['display_name'] is not None or operation['source'] == operation['destination']:
        return
    identity = json.loads(operation['identity'])
    try:
        if not os.path.lexists(operation['source']) and _rename_matches(operation['anchor'], identity):
            os.link(operation['anchor'], operation['source'], follow_symlinks=False)
            _rename_sync(os.path.dirname(operation['source']))
    except OSError:
        app.logger.warning('rename recovery outcome=intervention-required')


def _recover_rename_operation(operation, request_actor=False):
    """Resume the admitted operation, never a newly inferred rename."""
    if operation['phase'] == 'done':
        with _db_lock, db() as conn:
            actor, row, status = _rename_authorized(conn, operation, request_actor)
            if status != 200:
                return {'error': 'Authentication required' if status == 401 else 'Unknown download id'}, status
            receipt = conn.execute('SELECT response, status FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?',
                                   (operation['actor_id'], operation['mutation_id'])).fetchone()
        try:
            _finish_rename_cleanup(operation)
        except _RenameRecoveryRequired:
            return _rename_unresolved()
        except OSError:
            app.logger.warning('rename recovery outcome=cleanup-required')
        return (json.loads(receipt['response']), receipt['status']) if receipt else _rename_unresolved()
    with _db_lock, db() as conn:
        actor, row, status = _rename_authorized(conn, operation, request_actor)
        denied = status != 200
        invalid = not denied and (str(row['rename_revision']) != operation['expected_revision']
                                  or row['status'] != 'finished'
                                  or not _rename_aliases_authorized(conn, operation, actor))
    if denied:
        _restore_rename_source(operation)
        return {'error': 'Authentication required' if status == 401 else 'Unknown download id'}, status
    if invalid:
        _restore_rename_source(operation)
        return _rename_unresolved()
    source, destination, anchor = (operation[key] for key in ('source', 'destination', 'anchor'))
    identity = json.loads(operation['identity'])
    directory = os.path.dirname(source)
    try:
        if operation['display_name'] is None and source != destination:
            if not os.path.lexists(anchor):
                if operation['phase'] != 'prepared' or not _rename_matches(source, identity, pristine=True):
                    return _rename_unresolved()
                os.link(source, anchor, follow_symlinks=False)
                _rename_sync(directory)
                _rename_checkpoint('anchor_created', operation)
            if not _rename_matches(anchor, identity):
                return _rename_unresolved()
            if operation['phase'] == 'prepared':
                _rename_phase(operation, 'anchored')
            if not os.path.lexists(destination):
                # An exclusive hardlink makes destination creation no-clobber,
                # including a file created externally after collision checking.
                os.link(anchor, destination, follow_symlinks=False)
                _rename_sync(directory)
                _rename_checkpoint('destination_created', operation)
            if not _rename_matches(destination, identity):
                if not os.path.lexists(source):
                    os.link(anchor, source, follow_symlinks=False)
                    _rename_sync(directory)
                return _rename_unresolved()
            if operation['phase'] in ('prepared', 'anchored'):
                _rename_phase(operation, 'linked')
            if not _retire_rename_source(operation):
                return _rename_unresolved()
            _rename_checkpoint('source_removed', operation)
            _rename_phase(operation, 'moved')
        else:
            if not _rename_matches(source, identity, pristine=True):
                return _rename_unresolved()
        if operation['display_name'] is None and source != destination:
            if not _rename_matches(anchor, identity) or not _rename_matches(destination, identity):
                _restore_rename_source(operation)
                return _rename_unresolved()
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor, row, status = _rename_authorized(conn, operation, request_actor)
            if status != 200:
                raise _RenameAuthorizationLost(status)
            if str(row['rename_revision']) != operation['expected_revision']:
                raise _RenameRecoveryRequired('Editable state changed during recovery')
            if not _rename_aliases_authorized(conn, operation, actor):
                raise _RenameRecoveryRequired('File authorization changed during recovery')
            before = _rename_snapshot(conn, row['id'], row)
            affected_ids = [row['id']]
            if operation['display_name'] is not None:
                conn.execute('UPDATE downloads SET display_filename = ? WHERE id = ?',
                             (operation['display_name'], row['id']))
            elif source != destination:
                # Multiple rows may name the very same directory entry. Keep
                # each reference valid; separate hardlink aliases stay put.
                aliases = conn.execute('SELECT id, filename FROM downloads WHERE filename IS NOT NULL').fetchall()
                for alias in aliases:
                    if os.path.abspath(alias['filename']) == source:
                        conn.execute('UPDATE downloads SET filename = ? WHERE id = ?', (destination, alias['id']))
                        affected_ids.append(alias['id'])
            state = _rename_snapshot(conn, row['id'])
            changed = before != state
            result = dict(state, changed=changed, server_time=int(time.time() * 1000),
                          mutation={'id': operation['mutation_id'], 'domain': 'rename',
                                    'outcome': 'committed', 'revision': state['rename_revision']})
            conn.execute('INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, fingerprint, status, response, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                         (operation['actor_id'], operation['mutation_id'], row['id'], operation['fingerprint'], 200, json.dumps(result), time.time()))
            identity['published_revisions'] = {target_id: str(conn.execute('SELECT rename_revision FROM downloads WHERE id = ?', (target_id,)).fetchone()[0]) for target_id in set(affected_ids)}
            operation['identity'] = json.dumps(identity)
            conn.execute("UPDATE rename_operations SET phase = 'done', identity = ? WHERE actor_id = ? AND mutation_id = ?",
                         (operation['identity'], operation['actor_id'], operation['mutation_id']))
        _rename_checkpoint('committed', operation)
        try:
            _finish_rename_cleanup(operation)
        except _RenameRecoveryRequired:
            return _rename_unresolved()
        except OSError:
            app.logger.warning('rename recovery outcome=cleanup-required')
        _rename_checkpoint('cleaned', operation)
        if changed:
            _publish_metadata_change('rename')
        return result, 200
    except _RenameAuthorizationLost as denied:
        _restore_rename_source(operation)
        return {'error': 'Authentication required' if denied.status == 401 else 'Unknown download id'}, denied.status
    except OSError:
        _restore_rename_source(operation)
        return _rename_unresolved()


def _recover_rename_operations():
    with _file_operation_lock:
        with db() as conn:
            operations = [dict(row) for row in conn.execute('SELECT * FROM rename_operations')]
        for operation in operations:
            if operation['phase'] == 'done':
                try:
                    _finish_rename_cleanup(operation)
                except OSError:
                    app.logger.warning('rename recovery outcome=cleanup-required')
            else:
                _recover_rename_operation(operation)


def _record_rename_rejection(conn, actor, row, mutation_id, fingerprint, error, status, outcome='rejected'):
    state = _rename_snapshot(conn, row['id'], row)
    result = dict(state, error=error, changed=False, server_time=int(time.time() * 1000),
                  mutation={'id': mutation_id, 'domain': 'rename', 'outcome': outcome, 'revision': state['rename_revision']})
    conn.execute('INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, fingerprint, status, response, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                 (actor['id'], mutation_id, row['id'], fingerprint, status, json.dumps(result), time.time()))
    return result, status


def _rename_rejection(download_id, mutation_id, fingerprint, error, status, outcome='rejected'):
    with _db_lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        actor = _tag_actor(conn)
        row = _tag_visible_row(conn, download_id, actor) if actor else None
        if actor is None or row is None:
            return {'error': 'Authentication required' if actor is None else 'Unknown download id'}, 401 if actor is None else 404
        receipt = conn.execute('SELECT fingerprint, response, status FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?', (actor['id'], mutation_id)).fetchone()
        if receipt is not None:
            if receipt['fingerprint'] != fingerprint:
                return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
            return json.loads(receipt['response']), receipt['status']
        if conn.execute('SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ?', (actor['id'], mutation_id)).fetchone():
            return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
        now = time.time()
        counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent FROM mutation_receipts WHERE actor_id = ?', (now - 60, actor['id'])).fetchone()
        active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS (SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
        if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
            return {'error': 'Too many mutations; wait before submitting more', 'code': 'mutation_limit'}, 429
        return _record_rename_rejection(conn, actor, row, mutation_id, fingerprint, error, status, outcome)


def _execute_rename_mutation(download_id, payload):
    protocol = 'client_mutation_id' in payload or 'expected_revision' in payload
    with _file_operation_lock:
        # Authorization and journal/receipt replay precede inspecting old paths:
        # a completed move necessarily made that old source disappear.
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return {'error': 'Authentication required'}, 401
            row = _tag_visible_row(conn, download_id, actor)
            if row is None:
                return {'error': 'Unknown download id'}, 404
            row = dict(row)
            state = _rename_snapshot(conn, download_id, row)
            expected = payload.get('expected_revision') if protocol else state['rename_revision']
            mutation_id = payload.get('client_mutation_id') if protocol else str(int(time.time() * 1000)) + '-' + secrets.token_hex(16)
            match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
            if match is None:
                return {'error': 'Invalid mutation identifier'}, 400
            fingerprint = hashlib.sha256(json.dumps(['POST', 'rename.set', download_id, payload.get('filename'), expected],
                                                    ensure_ascii=True, separators=(',', ':'), sort_keys=True).encode()).hexdigest()
            receipt = conn.execute('SELECT fingerprint, status, response FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?', (actor['id'], mutation_id)).fetchone()
            operation = conn.execute('SELECT * FROM rename_operations WHERE actor_id = ? AND mutation_id = ?', (actor['id'], mutation_id)).fetchone()
            if receipt is not None or operation is not None:
                recorded = receipt if receipt is not None else operation
                if recorded['fingerprint'] != fingerprint:
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                if receipt is not None:
                    result, status = json.loads(receipt['response']), receipt['status']
                else:
                    result = status = None
                operation = dict(operation) if operation is not None else None
            else:
                operation = None
                now = time.time()
                _prune_mutation_receipts(conn, now)
                counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent FROM mutation_receipts WHERE actor_id = ?', (now - 60, actor['id'])).fetchone()
                active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS (SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
                if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
                    return {'error': 'Too many mutations; wait before submitting more', 'code': 'mutation_limit'}, 429
                error, status, outcome = None, 200, 'committed'
                value = payload.get('filename')
                if int(match.group(1)) / 1000 < now - MUTATION_REPLAY_SECONDS or int(match.group(1)) / 1000 > now + 300:
                    error, status = 'Mutation identifier expired or clock is incorrect', 400
                elif not isinstance(expected, str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', expected):
                    error, status = 'Expected revision must be a decimal string', 400
                elif not isinstance(value, str) or not value.strip():
                    error, status = 'Filename must not be empty', 400
                elif any(char in value for char in ('/', '\\', '\x00')) or value.strip() in ('.', '..'):
                    error, status = 'Filename must not contain path separators', 400
                elif row['status'] != 'finished':
                    error, status = 'Only finished downloads can be renamed', 409
                elif expected != state['rename_revision']:
                    error, status, outcome = 'Editable state changed; review the current state', 409, 'conflicted'
                if error is not None:
                    if outcome != 'conflicted':
                        outcome = 'rejected'
                    result = dict(state, error=error, changed=False, server_time=int(now * 1000),
                                  mutation={'id': mutation_id, 'domain': 'rename', 'outcome': outcome, 'revision': state['rename_revision']})
                    conn.execute('INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, fingerprint, status, response, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                 (actor['id'], mutation_id, download_id, fingerprint, status, json.dumps(result), now))
                else:
                    result = status = None
        if result is not None and operation is not None and operation['phase'] == 'done':
            try:
                _finish_rename_cleanup(operation)
            except _RenameRecoveryRequired:
                return _rename_unresolved()
            except OSError:
                app.logger.warning('rename recovery outcome=cleanup-required')
        if result is None and operation is None:
            try:
                _assert_no_pending_rename(row)
                old_path = row.get('filename')
                if not old_path or not _is_allowed_download_path(old_path):
                    return _rename_rejection(download_id, mutation_id, fingerprint, 'Original file is missing on disk', 410)
                source = os.path.abspath(old_path)
                if os.path.realpath(source) != source:
                    return _rename_rejection(download_id, mutation_id, fingerprint, 'File location does not support safe rename', 409)
                identity = _rename_identity(source)
                old_ext = os.path.splitext(source)[1]
                base = os.path.splitext(payload['filename'].strip())[0]
                if not base:
                    return _rename_rejection(download_id, mutation_id, fingerprint, 'Filename must not be empty', 400)
                final_name = base + old_ext
                if len(os.fsencode(final_name)) > 255:
                    return _rename_rejection(download_id, mutation_id, fingerprint, 'Filename is too long', 400)
                display_name = final_name if row.get('display_filename') else None
                destination = source if display_name is not None else os.path.join(os.path.dirname(source), final_name)
                if destination != source and os.path.lexists(destination):
                    return _rename_rejection(download_id, mutation_id, fingerprint, 'A file with that name already exists', 409)
                operation = dict(actor_id=actor['id'], mutation_id=mutation_id, target_id=download_id,
                                 fingerprint=fingerprint, actor_session_version=actor['session_version'],
                                 expected_revision=expected, source=source, destination=destination,
                                 anchor=os.path.join(os.path.dirname(source), '.vdl-rename-' + secrets.token_hex(16) + '.source'),
                                 identity=json.dumps(identity), display_name=display_name, phase='prepared', recorded_at=time.time())
                with _db_lock, db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    current = _tag_actor(conn)
                    current_row = _tag_visible_row(conn, download_id, current) if current else None
                    if current is None:
                        return {'error': 'Authentication required'}, 401
                    if current_row is None:
                        return {'error': 'Unknown download id'}, 404
                    # Hashing is deliberately outside SQLite serialization;
                    # admission must therefore recheck namespace, budget, clock.
                    if (conn.execute('SELECT 1 FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?', (current['id'], mutation_id)).fetchone()
                            or conn.execute('SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ?', (current['id'], mutation_id)).fetchone()):
                        return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                    admitted_now = time.time()
                    counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent FROM mutation_receipts WHERE actor_id = ?', (admitted_now - 60, current['id'])).fetchone()
                    active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS (SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (current['id'],)).fetchone()[0]
                    if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
                        return {'error': 'Too many mutations; wait before submitting more', 'code': 'mutation_limit'}, 429
                    created = int(match.group(1)) / 1000
                    if created < admitted_now - MUTATION_REPLAY_SECONDS or created > admitted_now + 300:
                        return _record_rename_rejection(conn, current, current_row, mutation_id, fingerprint, 'Mutation identifier expired or clock is incorrect', 400)
                    if str(current_row['rename_revision']) != expected:
                        return _record_rename_rejection(conn, current, current_row, mutation_id, fingerprint, 'Editable state changed; review the current state', 409, 'conflicted')
                    if not _rename_aliases_authorized(conn, operation, current):
                        return _record_rename_rejection(conn, current, current_row, mutation_id, fingerprint, 'File location does not support safe rename', 409)
                    conn.execute('INSERT INTO rename_operations(' + ','.join(operation) + ') VALUES (' + ','.join('?' for _ in operation) + ')', tuple(operation.values()))
                _rename_checkpoint('prepared', operation)
            except FileNotFoundError:
                return _rename_rejection(download_id, mutation_id, fingerprint, 'Original file is missing on disk', 410)
            except OSError:
                return _rename_unresolved()
        if result is None:
            result, status = _recover_rename_operation(operation, request_actor=True)
        if not protocol and status == 200:
            return {'message': 'Renamed' if result['changed'] else 'Unchanged', 'id': download_id,
                    'filename': result['display_filename'] or os.path.basename(result['filename'])}, status
        return result, status


def _validated_tag_name(value):
    """Return display and identity forms for one user-entered tag."""
    if not isinstance(value, str):
        raise ValueError("Tag must be text")
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError("Tag must not contain control characters")

    # A token editor uses comma as its commit key, so accepting it inside a
    # name would make the same tag impossible to enter consistently. Collapse
    # whitespace to keep visually identical free-form names reusable.
    display_name = re.sub(r"\s+", " ", value).strip()
    if not display_name:
        raise ValueError("Tag must not be empty")
    if "," in display_name:
        raise ValueError("Tag must not contain commas")
    if len(display_name) > TAG_MAX_LENGTH:
        raise ValueError(
            f"Tag must be {TAG_MAX_LENGTH} characters or fewer"
        )
    return display_name, display_name.casefold()


def db_list_tags(user_id=None, is_admin=False):
    """Return every tag still attached to at least one download entry."""
    with db() as conn:
        visibility_sql = ""
        values = ()
        if user_id is not None and not is_admin:
            visibility_sql = (
                " JOIN download_tags ON download_tags.tag_id = tags.id "
                "JOIN downloads ON downloads.id = download_tags.download_id "
                "WHERE downloads.visibility = 'public' "
                "OR downloads.owner_user_id = ? "
            )
            values = (user_id,)
        return [
            row["name"] for row in conn.execute(
                "SELECT DISTINCT tags.name FROM tags " + visibility_sql
                + "ORDER BY tags.name COLLATE NOCASE, tags.name",
                values,
            )
        ]


def db_add_download_tag(download_id, value):
    """Attach a normalized tag, preserving its first-created display name."""
    display_name, normalized_name = _validated_tag_name(value)
    with _db_lock, db() as conn:
        if conn.execute(
            "SELECT 1 FROM downloads WHERE id = ?", (download_id,)
        ).fetchone() is None:
            return None, False
        now = time.time()
        conn.execute(
            "INSERT OR IGNORE INTO tags(name, normalized_name, created_at) "
            "VALUES (?, ?, ?)",
            (display_name, normalized_name, now),
        )
        tag = conn.execute(
            "SELECT id FROM tags WHERE normalized_name = ?",
            (normalized_name,),
        ).fetchone()
        cursor = conn.execute(
            "INSERT OR IGNORE INTO download_tags(download_id, tag_id, created_at) "
            "VALUES (?, ?, ?)",
            (download_id, tag["id"], now),
        )
        changed = cursor.rowcount == 1
        tags = _db_download_tags(conn, download_id)
    if changed:
        _publish_tag_change()
    return tags, changed


def db_remove_download_tag(download_id, value):
    """Detach one case-insensitive tag and discard it when no longer used."""
    _display_name, normalized_name = _validated_tag_name(value)
    with _db_lock, db() as conn:
        if conn.execute(
            "SELECT 1 FROM downloads WHERE id = ?", (download_id,)
        ).fetchone() is None:
            return None, False
        cursor = conn.execute(
            "DELETE FROM download_tags "
            "WHERE download_id = ? AND tag_id = ("
            "SELECT id FROM tags WHERE normalized_name = ?)",
            (download_id, normalized_name),
        )
        changed = cursor.rowcount == 1
        tags = _db_download_tags(conn, download_id)
    if changed:
        _publish_tag_change()
    return tags, changed


def _download_artifact_candidates(entry, fallback_dir=None, *, strict=False):
    """Capture the existing cleanup scope without applying effects."""
    candidates = set()
    filename = entry.get("filename")
    if filename:
        # Keep supporting renamed files, whose basename no longer carries the
        # generated download ID used to identify yt-dlp's temporary files.
        candidates.update((filename, filename + ".part", filename + ".ytdl"))

    for version in (1, _THUMBNAIL_CACHE_VERSION):
        thumbnail = _thumbnail_path(entry, fallback_dir, version=version)
        if thumbnail:
            candidates.add(thumbnail)
    if entry.get('output_dir'):
        # Earlier versions placed sidecars in output_dir even when the stored
        # media path later pointed elsewhere.
        candidates.add(os.path.join(
            os.path.abspath(entry['output_dir']),
            f".vdl_{entry['id']}.thumbnail.jpg",
        ))
    preview = _preview_path(entry, fallback_dir)
    if preview:
        candidates.add(preview)

    search_dirs = {entry.get("output_dir"), fallback_dir}
    if filename:
        search_dirs.add(os.path.dirname(os.path.abspath(filename)))

    # Every output template includes this random row ID. It remains present in
    # split-format, fragment, .part, and .ytdl names even when no filename was
    # recorded before cancellation.
    owned_name = re.compile(rf"^.*_{re.escape(str(entry['id']))}\..+$")
    for directory in filter(None, search_dirs):
        try:
            with os.scandir(os.path.abspath(directory)) as items:
                for item in items:
                    if (owned_name.fullmatch(item.name)
                            and (item.is_file(follow_symlinks=False)
                                 or item.is_symlink())):
                        candidates.add(item.path)
        except FileNotFoundError:
            pass
        except OSError:
            if strict:
                raise

    if filename:
        with db() as conn:
            references = conn.execute('SELECT id, filename FROM downloads WHERE id != ? AND filename IS NOT NULL', (entry['id'],)).fetchall()
        if any(os.path.abspath(reference['filename']) == os.path.abspath(filename)
               and reference['id'] not in entry.get('_removing_ids', ()) for reference in references):
            candidates.discard(filename)
    return candidates


def delete_download_artifacts(entry, fallback_dir=None):
    """Delete final and temporary files owned by one download row."""
    removed = 0
    for path in _download_artifact_candidates(entry, fallback_dir):
        try:
            os.remove(path)
            removed += 1
        except FileNotFoundError:
            # A postprocessor may already have consumed a temporary file.
            pass
    return removed


def _removal_checkpoint(phase, operation):
    """Crash-injection seam after durable ownership boundaries."""


def _removal_unresolved():
    return {'error': 'Removal not confirmed. File recovery requires intervention.',
            'code': 'removal_recovery_required'}, 503


def _removal_response(download_id, mutation_id, revision, scope, *, removed=False,
                      outcome='committed', error=None):
    result = {'id': download_id, 'scope': scope, 'removed': removed,
              'removal_revision': str(revision), 'server_time': int(time.time() * 1000),
              'mutation': {'id': mutation_id, 'domain': 'entry-removal', 'action': 'entry.remove',
                           'outcome': outcome, 'revision': str(revision)}}
    if error:
        result['error'] = error
    return result


def _removal_authorized(conn, operation, request_actor):
    actor = (_tag_actor(conn) if request_actor else
             _db_user(conn, 'id = ?', (operation['actor_id'],)))
    if (actor is None or actor['id'] != operation['actor_id'] or actor['suspended']
            or actor['password_hash'] is None
            or actor['session_version'] != operation['actor_session_version']):
        return None, None, 401
    parent = conn.execute('SELECT s.* FROM bulk_clear_scopes s JOIN bulk_clear_targets t ON t.scope_id = s.id '
                          'WHERE s.actor_id = ? AND t.child_mutation_id = ?',
                          (operation['actor_id'], operation['mutation_id'])).fetchone()
    if parent is not None:
        _actor, status = _bulk_clear_actor(conn, parent, request_actor)
        if status != 200:
            return None, None, status
    row = _tag_visible_row(conn, operation['target_id'], actor)
    if row is None and operation['phase'] not in ('done', 'cleaned'):
        return actor, None, 404
    # Once removed, the actor-bound operation is the minimal authority record;
    # it contains no former title, members, URL, or unrestricted client path.
    return actor, row, 200


def _removal_exists(path):
    # EACCES and I/O failure are uncertainty, never evidence of missing bytes.
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False


def _removal_identity(path):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        return {'device': info.st_dev, 'inode': info.st_ino, 'size': info.st_size,
                'mtime': info.st_mtime_ns, 'ctime': info.st_ctime_ns,
                'digest': hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest(), 'symlink': True}
    if not stat.S_ISREG(info.st_mode):
        raise OSError('Unsupported cleanup identity')
    return dict(_rename_identity(path), symlink=False)


def _removal_matches(path, identity, *, pristine=False):
    try:
        current = _removal_identity(path)
    except OSError:
        return False
    keys = ('device', 'inode', 'size', 'mtime', 'digest', 'symlink')
    if pristine:
        keys += ('ctime',)
    return all(current[key] == identity[key] for key in keys)


def _removal_phase(operation, phase):
    with _db_lock, db() as conn:
        conn.execute('UPDATE removal_operations SET phase = ? WHERE actor_id = ? AND mutation_id = ?',
                     (phase, operation['actor_id'], operation['mutation_id']))
    operation['phase'] = phase
    _removal_checkpoint(phase, operation)


def _restore_removal_sources(operation):
    # A revoked actor cannot finish a deletion. Restore only the admitted inode
    # to an empty name; replacements remain untouched and require intervention.
    for item in json.loads(operation['artifacts']):
        try:
            if _removal_exists(item['source']):
                continue
        except OSError:
            app.logger.warning('removal recovery outcome=intervention-required')
            continue
        for path in (item['anchor'], item['retired']):
            try:
                if _removal_matches(path, item['identity']):
                    os.link(path, item['source'], follow_symlinks=False)
                    _rename_sync(os.path.dirname(item['source']))
                    break
            except OSError:
                app.logger.warning('removal recovery outcome=intervention-required')


def _finish_removal_cleanup(operation):
    for item in json.loads(operation['artifacts']):
        for path in (item['retired'], item['anchor']):
            if not _removal_exists(path):
                continue
            if not _removal_matches(path, item['identity']):
                raise OSError('Cleanup identity changed')
            os.unlink(path)
            _rename_sync(os.path.dirname(path))
            _removal_checkpoint('retired_removed' if path == item['retired'] else 'anchor_removed', operation)
    _removal_phase(operation, 'cleaned')


def _recover_removal_operation(operation, request_actor=False):
    assets = _get_asset_queue()
    with _file_operation_lock, assets.publication_lock, _worker_condition:
        with db() as conn:
            actor, row, status = _removal_authorized(conn, operation, request_actor)
        if status != 200:
            if operation['phase'] not in ('done', 'cleaned'):
                _restore_removal_sources(operation)
            return {'error': 'Authentication required' if status == 401 else 'Unknown download id'}, status
        try:
            if operation['phase'] not in ('done', 'cleaned'):
                if (str(row['removal_revision']) != operation['expected_revision']
                        or row['status'] in download_history.ACTIVE
                        or row['id'] in _live_worker_ids or row['id'] in _worker_hosts
                        or any(job['id'] == row['id'] for job in _worker_queue)):
                    _restore_removal_sources(operation)
                    return _removal_unresolved()
                for item in json.loads(operation['artifacts']):
                    source, anchor, retired, identity = item['source'], item['anchor'], item['retired'], item['identity']
                    if not _removal_exists(anchor):
                        if not _removal_matches(source, identity, pristine=True):
                            return _removal_unresolved()
                        os.link(source, anchor, follow_symlinks=False)
                        _rename_sync(os.path.dirname(source))
                        _removal_checkpoint('anchor_created', operation)
                    if not _removal_matches(anchor, identity):
                        return _removal_unresolved()
                if operation['phase'] == 'prepared':
                    _removal_phase(operation, 'anchored')
                with _db_lock, db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    actor, row, status = _removal_authorized(conn, operation, request_actor)
                    if status != 200:
                        raise _RenameAuthorizationLost(status)
                    if str(row['removal_revision']) != operation['expected_revision']:
                        raise OSError('Resource changed during removal')
                    assets.invalidate([operation['target_id']], conn=conn)
                for item in json.loads(operation['artifacts']):
                    source, retired, identity = item['source'], item['retired'], item['identity']
                    if _removal_exists(retired):
                        if not _removal_matches(retired, identity):
                            # A crash may precede the post-move identity check.
                            # Put a raced replacement back at its empty name.
                            try:
                                _rename_noreplace(retired, source)
                                _rename_sync(os.path.dirname(source))
                            except OSError:
                                pass
                            return _removal_unresolved()
                    elif _removal_exists(source):
                        if not _removal_matches(source, identity):
                            return _removal_unresolved()
                        _removal_checkpoint('before_retire', dict(operation, source=source))
                        _rename_noreplace(source, retired)
                        _rename_sync(os.path.dirname(source))
                        _removal_checkpoint('source_retired', operation)
                        if not _removal_matches(retired, identity):
                            try:
                                _rename_noreplace(retired, source)
                                _rename_sync(os.path.dirname(source))
                            except OSError:
                                pass
                            return _removal_unresolved()
                    # Once retirement is durable, a newly installed source is
                    # an unrelated replacement and is never considered again.
                _removal_phase(operation, 'retired')
                with _db_lock, db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    actor, row, status = _removal_authorized(conn, operation, request_actor)
                    if status != 200:
                        raise _RenameAuthorizationLost(status)
                    if str(row['removal_revision']) != operation['expected_revision']:
                        raise OSError('Resource changed during removal')
                    result = _removal_response(operation['target_id'], operation['mutation_id'],
                                               int(operation['expected_revision']) + 1, operation['scope'], removed=True)
                    _db_remove_download_from_playlists(conn, operation['target_id'])
                    conn.execute('DELETE FROM downloads WHERE id = ?', (operation['target_id'],))
                    conn.execute('UPDATE mutation_receipts SET response = ?, status = 200, recorded_at = ? '
                                 'WHERE actor_id = ? AND mutation_id = ?',
                                 (json.dumps(result), time.time(), operation['actor_id'], operation['mutation_id']))
                    conn.execute("UPDATE removal_operations SET phase = 'done', recorded_at = ? WHERE actor_id = ? AND mutation_id = ?",
                                 (time.time(), operation['actor_id'], operation['mutation_id']))
                operation['phase'] = 'done'
                _removal_checkpoint('committed', operation)
            if operation['phase'] == 'done':
                _finish_removal_cleanup(operation)
            with db() as conn:
                actor, _row, status = _removal_authorized(conn, operation, request_actor)
                if status != 200:
                    return {'error': 'Authentication required'}, status
                receipt = conn.execute('SELECT response, status FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?',
                                       (operation['actor_id'], operation['mutation_id'])).fetchone()
            _publish_metadata_change('entry-removal')
            return json.loads(receipt['response']), receipt['status']
        except _RenameAuthorizationLost as denied:
            _restore_removal_sources(operation)
            return {'error': 'Authentication required' if denied.status == 401 else 'Unknown download id'}, denied.status
        except OSError:
            if operation['phase'] not in ('done', 'cleaned'):
                _restore_removal_sources(operation)
            return _removal_unresolved()


def _recover_removal_operations():
    with _file_operation_lock, db() as conn:
        operations = [dict(row) for row in conn.execute("SELECT * FROM removal_operations WHERE phase != 'cleaned'")]
    for operation in operations:
        if operation['phase'] == 'done':
            # Publication already removed the row. Cleanup owns only its pinned
            # hidden names, even if the original actor can no longer sign in.
            # Request recovery still authorizes before returning any receipt.
            try:
                with _file_operation_lock:
                    _finish_removal_cleanup(operation)
            except OSError:
                app.logger.warning('removal recovery outcome=cleanup-required')
        else:
            _recover_removal_operation(operation)


def _execute_removal_mutation(download_id, payload, *, _bulk=None):
    protocol = any(key in payload for key in ('client_mutation_id', 'expected_revision', 'scope'))
    if payload and not protocol:
        return {'error': 'Unsupported removal fields'}, 400
    mutation_id = payload.get('client_mutation_id') if protocol else str(int(time.time() * 1000)) + '-' + secrets.token_hex(16)
    match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
    if match is None:
        return {'error': 'Invalid mutation identifier'}, 400
    assets = _get_asset_queue()
    with _file_operation_lock, assets.publication_lock, _worker_condition:
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _bulk_clear_actor(conn, _bulk, has_request_context())[0] if _bulk else _tag_actor(conn)
            if actor is None:
                return {'error': 'Authentication required'}, 401
            operation = conn.execute('SELECT * FROM removal_operations WHERE actor_id = ? AND mutation_id = ?',
                                     (actor['id'], mutation_id)).fetchone()
            row = _tag_visible_row(conn, download_id, actor)
            if row is None and operation is None:
                return {'error': 'Unknown download id'}, 404
            expected = payload.get('expected_revision') if protocol else str(row['removal_revision'])
            scope = payload.get('scope') if protocol else 'entry-and-files'
            fingerprint = hashlib.sha256(json.dumps(['POST', 'entry.remove', download_id, payload if protocol else
                {'expected_revision': expected, 'scope': scope}], sort_keys=True,
                ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
            receipt = conn.execute('SELECT * FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?',
                                   (actor['id'], mutation_id)).fetchone()
            if receipt is not None:
                if receipt['fingerprint'] != fingerprint or receipt['target_id'] != download_id:
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                if operation is None:
                    return json.loads(receipt['response']), receipt['status']
                operation = dict(operation)
            else:
                if conn.execute('SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ?',
                                (actor['id'], mutation_id)).fetchone():
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                now = time.time()
                _prune_mutation_receipts(conn, now)
                counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent '
                                      'FROM mutation_receipts WHERE actor_id = ?', (now - 60, actor['id'])).fetchone()
                active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS "
                                      "(SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
                error, status, outcome = None, 200, 'rejected'
                if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
                    error, status = 'Too many mutations; wait before submitting more', 429
                elif not _bulk and (int(match.group(1)) / 1000 < now - MUTATION_REPLAY_SECONDS or int(match.group(1)) / 1000 > now + 300):
                    error, status = 'Mutation identifier expired or clock is incorrect', 400
                elif protocol and set(payload) != {'client_mutation_id', 'expected_revision', 'scope'}:
                    error, status = 'Unsupported removal fields', 400
                elif scope not in ('entry', 'entry-and-files'):
                    error, status = 'Removal scope must be explicit', 400
                elif not isinstance(expected, str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', expected):
                    error, status = 'Expected revision must be a decimal string', 400
                elif expected != str(row['removal_revision']):
                    error, status, outcome = 'Entry changed; review the current state', 409, 'conflicted'
                elif (row['status'] in download_history.ACTIVE or download_id in _live_worker_ids
                      or download_id in _worker_hosts or any(job['id'] == download_id for job in _worker_queue)):
                    error, status = 'Cannot remove a download until its worker has fully stopped.', 409
                elif conn.execute("SELECT 1 FROM removal_operations WHERE target_id = ? AND phase NOT IN ('done','cleaned')", (download_id,)).fetchone():
                    error, status = 'Resolve the pending removal first', 409
                if error is not None:
                    result = _removal_response(download_id, mutation_id, row['removal_revision'], scope,
                                               outcome=outcome, error=error)
                    if status != 429:
                        conn.execute('INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, fingerprint, status, response, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                                     (actor['id'], mutation_id, download_id, fingerprint, status, json.dumps(result), now))
                    return result, status
                row = dict(row)
                operation = None
        if operation is not None:
            return _recover_removal_operation(operation, request_actor=has_request_context())
        try:
            _assert_no_pending_rename(row)
            artifacts = []
            if scope == 'entry-and-files':
                for path in sorted(_download_artifact_candidates(row, row.get('output_dir') or DEFAULT_DOWNLOAD_DIR, strict=True)):
                    path = os.path.abspath(path)
                    # Symlinks themselves may be retired, never their targets.
                    if not _is_allowed_download_path(os.path.dirname(path)):
                        raise OSError('Cleanup directory is unavailable')
                    try:
                        identity = _removal_identity(path)
                    except FileNotFoundError:
                        continue
                    prefix = os.path.join(os.path.dirname(path), '.vdl-remove-' + secrets.token_hex(16))
                    artifacts.append({'source': path, 'anchor': prefix + '.anchor', 'retired': prefix + '.retired', 'identity': identity})
            operation = dict(actor_id=actor['id'], mutation_id=mutation_id, target_id=download_id,
                             fingerprint=fingerprint, actor_session_version=actor['session_version'],
                             expected_revision=expected, scope=scope, artifacts=json.dumps(artifacts),
                             phase='prepared', recorded_at=time.time())
            with _db_lock, db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                current = _bulk_clear_actor(conn, _bulk, has_request_context())[0] if _bulk else _tag_actor(conn)
                latest = _tag_visible_row(conn, download_id, current) if current else None
                if current is None:
                    return {'error': 'Authentication required'}, 401
                if latest is None:
                    return {'error': 'Unknown download id'}, 404
                # Filesystem discovery deliberately ran outside the write lock;
                # every admission condition is checked again at this boundary.
                counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent '
                                      'FROM mutation_receipts WHERE actor_id = ?', (time.time() - 60, current['id'])).fetchone()
                active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS "
                                      "(SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (current['id'],)).fetchone()[0]
                error, status, outcome = None, 200, 'rejected'
                if conn.execute('SELECT 1 FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?', (current['id'], mutation_id)).fetchone():
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
                    error, status = 'Too many mutations; wait before submitting more', 429
                elif not _bulk and (int(match.group(1)) / 1000 < time.time() - MUTATION_REPLAY_SECONDS or int(match.group(1)) / 1000 > time.time() + 300):
                    error, status = 'Mutation identifier expired or clock is incorrect', 400
                elif str(latest['removal_revision']) != expected:
                    error, status, outcome = 'Entry changed; review the current state', 409, 'conflicted'
                if error:
                    return _removal_response(download_id, mutation_id, latest['removal_revision'], scope, outcome=outcome, error=error), status
                conn.execute('INSERT INTO removal_operations(' + ','.join(operation) + ') VALUES (' + ','.join('?' for _ in operation) + ')', tuple(operation.values()))
                unknown, _status = _removal_unresolved()
                conn.execute('INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, fingerprint, status, response, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                             (actor['id'], mutation_id, download_id, fingerprint, 503, json.dumps(unknown), time.time()))
            _removal_checkpoint('prepared', operation)
            result, status = _recover_removal_operation(operation, request_actor=has_request_context())
            if not protocol and status == 200:
                return {'message': 'Removed', 'id': download_id}, status
            return result, status
        except OSError:
            return _removal_unresolved()


def _bulk_clear_checkpoint(phase, operation):
    """Crash-injection seam after durable bulk acceptance and target results."""


def _bulk_clear_actor(conn, operation=None, request_actor=True):
    actor = (_tag_actor(conn) if request_actor else
             _db_user(conn, 'id = ?', (operation['actor_id'],)))
    if (actor is None or actor['suspended'] or actor['password_hash'] is None
            or (operation is not None and (actor['id'] != operation['actor_id']
                or actor['session_version'] != operation['actor_session_version']))):
        return None, 401
    if 'admin' not in actor['roles']:
        return None, 403
    return actor, 200


def _bulk_clear_denied(status):
    return {'error': 'Authentication required' if status == 401 else 'Administrator access required'}, status


def _create_bulk_clear_scope(kind):
    with _db_lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        actor, status = _bulk_clear_actor(conn)
        if actor is None:
            return _bulk_clear_denied(status)
        now = time.time()
        conn.execute("DELETE FROM bulk_clear_scopes WHERE phase='preview' AND created_at < ?",
                     (now - MUTATION_REPLAY_SECONDS,))
        if kind == 'history':
            targets = conn.execute("SELECT id, '0' AS revision, 0 AS with_file FROM download_attempts "
                                   "WHERE status NOT IN ('starting','downloading','paused') ORDER BY id LIMIT 10001").fetchall()
        else:
            targets = conn.execute("SELECT id, removal_revision AS revision, filename IS NOT NULL AS with_file "
                                   "FROM downloads WHERE status IN ('finished','error') ORDER BY id LIMIT 10001").fetchall()
        if len(targets) > 10000:
            return {'error': 'Clear scope exceeds the 10000-record limit'}, 413
        previews = conn.execute("SELECT id FROM bulk_clear_scopes WHERE actor_id=? AND actor_session_version=? "
                                "AND kind=? AND phase='preview'", (actor['id'], actor['session_version'], kind)).fetchall()
        signature = [(row['id'], str(row['revision'])) for row in targets]
        for preview in previews:
            captured = [(row['target_id'], row['expected_revision']) for row in conn.execute(
                'SELECT target_id,expected_revision FROM bulk_clear_targets WHERE scope_id=? ORDER BY target_id', (preview['id'],))]
            if captured == signature:
                return {'scope_id': preview['id'], 'revision': '0', 'entries': len(targets),
                        'with_files': sum(row['with_file'] for row in targets)}, 200
        if conn.execute("SELECT COUNT(*) FROM bulk_clear_scopes WHERE actor_id=? AND phase='preview'",
                        (actor['id'],)).fetchone()[0] >= 16:
            return {'error': 'Too many unconfirmed clear previews; reuse a preview or wait'}, 429
        scope_id = secrets.token_hex(16)
        conn.execute('INSERT INTO bulk_clear_scopes(id,actor_id,actor_session_version,kind,created_at,recorded_at) '
                     'VALUES (?,?,?,?,?,?)', (scope_id, actor['id'], actor['session_version'], kind, now, now))
        conn.executemany('INSERT INTO bulk_clear_targets(scope_id,target_id,expected_revision,child_mutation_id) '
                         'VALUES (?,?,?,?)', [(scope_id, row['id'], str(row['revision']),
                             str(int(now * 1000)) + '-' + secrets.token_hex(16)) for row in targets])
        return {'scope_id': scope_id, 'revision': '0', 'entries': len(targets),
                'with_files': sum(row['with_file'] for row in targets)}, 200


def _bulk_clear_preview_response(kind):
    if request.args.get('include_scope') == 'true':
        result, status = _create_bulk_clear_scope(kind)
    else:
        with db() as conn:
            actor, status = _bulk_clear_actor(conn)
            if actor is None:
                result, status = _bulk_clear_denied(status)
            elif kind == 'history':
                count = conn.execute("SELECT COUNT(*) FROM download_attempts WHERE status NOT IN "
                                     "('starting','downloading','paused')").fetchone()[0]
                result = {'entries': count, 'with_files': 0}
            else:
                counts = conn.execute("SELECT COUNT(*), COUNT(filename) FROM downloads WHERE status IN ('finished','error')").fetchone()
                result = {'entries': counts[0], 'with_files': counts[1]}
    response = jsonify(result)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


def _bulk_clear_result(conn, operation, *, outcome=None, error=None):
    targets = conn.execute('SELECT target_id,state,files_deleted FROM bulk_clear_targets WHERE scope_id=? ORDER BY target_id',
                           (operation['id'],)).fetchall()
    counts = {state: sum(row['state'] == state for row in targets) for state in ('removed','retained','failed','pending')}
    revision = str(operation['revision'])
    result = {'scope': operation['kind'], 'scope_id': operation['id'], 'operation_id': operation['id'],
              'revision': revision, 'total': len(targets), **counts,
              'files_deleted': sum(row['files_deleted'] for row in targets),
              'removed_ids': [row['target_id'] for row in targets if row['state'] == 'removed'],
              'server_time': int(time.time() * 1000),
              'mutation': {'id': operation['mutation_id'], 'domain': 'bulk-clear',
                           'action': operation['kind'] + '.clear', 'entity_id': operation['kind'],
                           'revision': revision, 'outcome': outcome or ('accepted' if counts['pending'] else 'committed')}}
    if error:
        result['error'] = error
    return result


def _save_bulk_clear_result(conn, operation):
    operation = dict(operation)
    operation['revision'] += 1
    pending = conn.execute("SELECT 1 FROM bulk_clear_targets WHERE scope_id=? AND state='pending' LIMIT 1",
                           (operation['id'],)).fetchone()
    operation['phase'] = 'pending' if pending else 'completed'
    conn.execute('UPDATE bulk_clear_scopes SET revision=?,phase=?,recorded_at=? WHERE id=?',
                 (operation['revision'], operation['phase'], time.time(), operation['id']))
    result = _bulk_clear_result(conn, operation)
    conn.execute('UPDATE mutation_receipts SET response=?,status=200,recorded_at=? WHERE actor_id=? AND mutation_id=?',
                 (json.dumps(result), time.time(), operation['actor_id'], operation['mutation_id']))
    return operation, result


def _recover_bulk_clear_operation(operation, request_actor=True):
    # Match single-entry removal's file/scheduler boundary. SQLite transactions
    # only cover admission/results; discovery and all file effects run outside.
    with _file_operation_lock:
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            current = conn.execute('SELECT * FROM bulk_clear_scopes WHERE id=?', (operation['id'],)).fetchone()
            actor, status = _bulk_clear_actor(conn, operation, request_actor)
            if actor is None:
                return _bulk_clear_denied(status)
            if current is None:
                receipt = conn.execute('SELECT response,status FROM mutation_receipts WHERE actor_id=? AND mutation_id=?',
                                       (operation['actor_id'], operation['mutation_id'])).fetchone()
                if receipt is not None:
                    return json.loads(receipt['response']), receipt['status']
                match = MUTATION_ID_PATTERN.fullmatch(operation['mutation_id'])
                return {'error': 'Mutation unavailable', 'final': bool(match and int(match.group(1))/1000 < time.time()-MUTATION_REPLAY_SECONDS)}, 404
            operation = dict(current)
            actor, status = _bulk_clear_actor(conn, operation, request_actor)
            if actor is None:
                return _bulk_clear_denied(status)
            if operation['phase'] == 'completed':
                receipt = conn.execute('SELECT response,status FROM mutation_receipts WHERE actor_id=? AND mutation_id=?',
                                       (operation['actor_id'], operation['mutation_id'])).fetchone()
                return (json.loads(receipt['response']), receipt['status']) if receipt else (_bulk_clear_result(conn, operation), 200)
            targets = [dict(row) for row in conn.execute("SELECT * FROM bulk_clear_targets WHERE scope_id=? AND state='pending' ORDER BY target_id", (operation['id'],))]
        for target in targets:
            with db() as conn:
                actor, status = _bulk_clear_actor(conn, operation, request_actor)
                if actor is None:
                    return _bulk_clear_denied(status)
                child = conn.execute('SELECT * FROM removal_operations WHERE actor_id=? AND mutation_id=?',
                                     (actor['id'], target['child_mutation_id'])).fetchone()
                row = conn.execute('SELECT removal_revision,status FROM downloads WHERE id=?', (target['target_id'],)).fetchone()
            state, files_deleted = 'pending', 0
            if child is None and (row is None or str(row['removal_revision']) != target['expected_revision']
                                  or row['status'] not in HISTORY_STATUSES):
                state = 'retained'
            else:
                payload = {'client_mutation_id': target['child_mutation_id'],
                           'expected_revision': target['expected_revision'], 'scope': 'entry-and-files'}
                result, status = _execute_removal_mutation(target['target_id'], payload, _bulk=operation)
                if status in (401, 403):
                    return _bulk_clear_denied(status)
                if status == 429:
                    # The accepted set survives shared admission limits. A later
                    # deliberate check continues it without choosing new targets.
                    break
                if status == 200 and result.get('removed') is True:
                    state = 'removed'
                    with db() as conn:
                        child = conn.execute('SELECT artifacts FROM removal_operations WHERE actor_id=? AND mutation_id=?',
                                             (operation['actor_id'], target['child_mutation_id'])).fetchone()
                    files_deleted = len(json.loads(child['artifacts'])) if child else 0
                elif status in (400, 404, 409):
                    state = 'retained' if result.get('mutation', {}).get('outcome') == 'conflicted' else 'failed'
            if state != 'pending':
                with _db_lock, db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    actor, status = _bulk_clear_actor(conn, operation, request_actor)
                    if actor is None:
                        return _bulk_clear_denied(status)
                    conn.execute('UPDATE bulk_clear_targets SET state=?,files_deleted=? WHERE scope_id=? AND target_id=?',
                                 (state, files_deleted, operation['id'], target['target_id']))
                    operation['revision'] += 1
                    conn.execute('UPDATE bulk_clear_scopes SET revision=?,recorded_at=? WHERE id=?',
                                 (operation['revision'], time.time(), operation['id']))
                _bulk_clear_checkpoint('target_completed', operation)
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor, status = _bulk_clear_actor(conn, operation, request_actor)
            if actor is None:
                return _bulk_clear_denied(status)
            operation, result = _save_bulk_clear_result(conn, operation)
        _bulk_clear_checkpoint('completed' if operation['phase'] == 'completed' else 'pending', operation)
        _publish_metadata_change('bulk-clear')
        return result, 200


def _recover_bulk_clear_operations():
    with db() as conn:
        operations = [dict(row) for row in conn.execute("SELECT * FROM bulk_clear_scopes WHERE phase='pending'")]
    for operation in operations:
        _recover_bulk_clear_operation(operation, request_actor=False)


def _execute_bulk_clear(kind, payload):
    mutation_id = payload.get('client_mutation_id')
    match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
    if (set(payload) != {'client_mutation_id','scope_id','expected_revision'} or match is None
            or not isinstance(payload.get('scope_id'), str)
            or not re.fullmatch('[0-9a-f]{32}', payload['scope_id'])):
        return {'error': 'Invalid clear request; use a confirmed scope'}, 400
    fingerprint = hashlib.sha256(json.dumps([kind + '.clear', payload], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    with _file_operation_lock:
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor, status = _bulk_clear_actor(conn)
            if actor is None:
                return _bulk_clear_denied(status)
            receipt = conn.execute('SELECT * FROM mutation_receipts WHERE actor_id=? AND mutation_id=?',
                                   (actor['id'], mutation_id)).fetchone()
            if receipt is not None and receipt['fingerprint'] != fingerprint:
                return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
            operation = conn.execute('SELECT * FROM bulk_clear_scopes WHERE id=? AND actor_id=? AND kind=?',
                                     (payload['scope_id'], actor['id'], kind)).fetchone()
            if operation is None:
                return {'error': 'Clear scope unavailable; preview again'}, 409
            operation = dict(operation)
            actor, status = _bulk_clear_actor(conn, operation)
            if actor is None:
                return _bulk_clear_denied(status)
            if receipt is not None and not operation['mutation_id']:
                return json.loads(receipt['response']), receipt['status']
            if operation['mutation_id']:
                if operation['mutation_id'] != mutation_id or operation['fingerprint'] != fingerprint:
                    return {'error': 'Clear scope already accepted', 'code': 'mutation_id_conflict'}, 409
            else:
                now = time.time()
                _prune_mutation_receipts(conn, now)
                if conn.execute('SELECT 1 FROM rename_operations WHERE actor_id=? AND mutation_id=?', (actor['id'], mutation_id)).fetchone():
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                counts = conn.execute('SELECT COUNT(*), COALESCE(SUM(recorded_at > ?),0) FROM mutation_receipts WHERE actor_id=?',
                                      (now - 60, actor['id'])).fetchone()
                active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id=? AND (phase != 'done' OR NOT EXISTS "
                                      '(SELECT 1 FROM mutation_receipts r WHERE r.actor_id=rename_operations.actor_id AND r.mutation_id=rename_operations.mutation_id))', (actor['id'],)).fetchone()[0]
                required = 1 + (conn.execute('SELECT COUNT(*) FROM bulk_clear_targets WHERE scope_id=?', (operation['id'],)).fetchone()[0] if kind == 'library' else 0)
                reserved = conn.execute("SELECT COUNT(*) FROM bulk_clear_targets t JOIN bulk_clear_scopes s ON s.id=t.scope_id "
                                        "WHERE s.actor_id=? AND s.phase='pending' AND t.state='pending' AND NOT EXISTS "
                                        '(SELECT 1 FROM mutation_receipts r WHERE r.actor_id=s.actor_id AND r.mutation_id=t.child_mutation_id)',
                                        (actor['id'],)).fetchone()[0]
                if counts[0] + active + reserved + required > MUTATION_ACTOR_RECEIPT_LIMIT or counts[1] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
                    limited = dict(operation, mutation_id=mutation_id)
                    return _bulk_clear_result(conn, limited, outcome='rejected', error='Too many mutations; wait before submitting more'), 429
                outcome, error, status = None, None, 200
                if (int(match.group(1))/1000 < now - MUTATION_REPLAY_SECONDS or int(match.group(1))/1000 > now + 300
                        or operation['created_at'] < now - MUTATION_REPLAY_SECONDS):
                    outcome, error, status = 'rejected', 'Clear request expired; review a new preview', 400
                elif not isinstance(payload['expected_revision'], str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', payload['expected_revision']):
                    outcome, error, status = 'rejected', 'Expected revision must be a decimal string', 400
                elif payload['expected_revision'] != '0':
                    outcome, error, status = 'conflicted', 'Clear scope changed; review a new preview', 409
                if error:
                    operation.update(mutation_id=mutation_id, fingerprint=fingerprint, phase='completed')
                    conn.execute("UPDATE bulk_clear_scopes SET mutation_id=?,fingerprint=?,phase='completed',recorded_at=? WHERE id=?",
                                 (mutation_id, fingerprint, now, operation['id']))
                    result = _bulk_clear_result(conn, operation, outcome=outcome, error=error)
                    conn.execute('INSERT INTO mutation_receipts VALUES (?,?,?,?,?,?,?)',
                                 (actor['id'], mutation_id, 'bulk:' + kind, fingerprint, status, json.dumps(result), now))
                    return result, status
                operation.update(mutation_id=mutation_id, fingerprint=fingerprint, revision=1, phase='pending')
                conn.execute("UPDATE bulk_clear_scopes SET mutation_id=?,fingerprint=?,revision=1,phase='pending',recorded_at=? WHERE id=?",
                             (mutation_id, fingerprint, now, operation['id']))
                if kind == 'history':
                    targets = conn.execute('SELECT target_id FROM bulk_clear_targets WHERE scope_id=?', (operation['id'],)).fetchall()
                    for target in targets:
                        removed = conn.execute("DELETE FROM download_attempts WHERE id=? AND status NOT IN ('starting','downloading','paused')", (target['target_id'],)).rowcount
                        conn.execute('UPDATE bulk_clear_targets SET state=? WHERE scope_id=? AND target_id=?',
                                     ('removed' if removed else 'retained', operation['id'], target['target_id']))
                    operation['phase'] = 'completed'
                    conn.execute("UPDATE bulk_clear_scopes SET phase='completed' WHERE id=?", (operation['id'],))
                result = _bulk_clear_result(conn, operation)
                conn.execute('INSERT INTO mutation_receipts VALUES (?,?,?,?,?,?,?)',
                             (actor['id'], mutation_id, 'bulk:' + kind, fingerprint, 200, json.dumps(result), now))
        _bulk_clear_checkpoint('accepted', operation)
        if kind == 'history':
            _publish_metadata_change('bulk-clear')
        return _recover_bulk_clear_operation(operation)


def _bulk_clear_route(kind):
    if request.content_length:
        if not request.is_json:
            return jsonify({'error': 'Clear requires a JSON object'}), 400
        payload, error = _read_json_body(4096)
        if error is not None:
            return error
        legacy = False
    else:
        legacy = True
        preview, status = _create_bulk_clear_scope(kind)
        if status != 200:
            return jsonify(preview), status
        payload = {'scope_id': preview['scope_id'], 'expected_revision': preview['revision'],
                   'client_mutation_id': str(int(time.time() * 1000)) + '-' + secrets.token_hex(16)}
    result, status = _execute_bulk_clear(kind, payload)
    if legacy and status == 200:
        if result.get('pending') or result.get('failed'):
            result, status = {'error': 'Clear not confirmed; file recovery requires intervention'}, 500
        else:
            result = {'removed': result['removed'], 'files_deleted': result['files_deleted']}
            if kind == 'library':
                result['message'] = 'Cleared'
    response = jsonify(result)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


def _db_remove_download_from_playlists(conn, download_id):
    """Remove one membership everywhere and repair order/progress atomically."""
    affected = conn.execute(
        "SELECT playlist_items.playlist_id, playlist_items.position, "
        "playlist_progress.download_id AS progress_download_id "
        "FROM playlist_items "
        "LEFT JOIN playlist_progress "
        "ON playlist_progress.playlist_id = playlist_items.playlist_id "
        "WHERE playlist_items.download_id = ?",
        (download_id,),
    ).fetchall()
    now = time.time()
    for row in affected:
        playlist_id = row['playlist_id']
        removed_position = row['position']
        conn.execute(
            "DELETE FROM playlist_items "
            "WHERE playlist_id = ? AND download_id = ?",
            (playlist_id, download_id),
        )
        # The removed position is now free. Moving later rows in ascending
        # order keeps every intermediate state valid under the UNIQUE key.
        shifted = conn.execute(
            "SELECT download_id, position FROM playlist_items "
            "WHERE playlist_id = ? AND position > ? ORDER BY position",
            (playlist_id, removed_position),
        ).fetchall()
        for item in shifted:
            conn.execute(
                "UPDATE playlist_items SET position = ? "
                "WHERE playlist_id = ? AND download_id = ?",
                (item['position'] - 1, playlist_id, item['download_id']),
            )
        if row['progress_download_id'] == download_id:
            target = conn.execute(
                "SELECT download_id FROM playlist_items "
                "WHERE playlist_id = ? ORDER BY "
                "CASE WHEN position >= ? THEN 0 ELSE 1 END, "
                "CASE WHEN position >= ? THEN position ELSE -position END "
                "LIMIT 1",
                (playlist_id, removed_position, removed_position),
            ).fetchone()
            if target is None:
                conn.execute(
                    "DELETE FROM playlist_progress WHERE playlist_id = ?",
                    (playlist_id,),
                )
            else:
                conn.execute(
                    "UPDATE playlist_progress SET download_id = ?, "
                    "position_seconds = 0, completed = 0, "
                    "write_sequence = write_sequence + 1, updated_at = ? "
                    "WHERE playlist_id = ?",
                    (target['download_id'], now, playlist_id),
                )
        conn.execute(
            "UPDATE playlists SET revision = revision + 1, "
            "content_updated_at = ? WHERE id = ?",
            (now, playlist_id),
        )
    return len(affected)


def db_clear_library():
    with _file_operation_lock:
        placeholders = ','.join('?' for _ in HISTORY_STATUSES)
        fallback_dir = db_get_preferences().get('download_dir', '.')
        assets = _get_asset_queue()
        with assets.publication_lock, _worker_condition:
            with db() as conn:
                entries = [dict(row) for row in conn.execute(
                    f'SELECT * FROM downloads WHERE status IN ({placeholders})', HISTORY_STATUSES)]
            for entry in entries:
                _assert_no_pending_rename(entry)
            with _db_lock, db() as conn:
                assets.invalidate([entry['id'] for entry in entries], conn=conn)
            # A failed cleanup retains the rows, as before. The accepted set is
            # fixed so a newly finished download cannot be removed unexamined.
            removing_ids = {entry['id'] for entry in entries}
            for entry in entries:
                entry['_removing_ids'] = removing_ids
            files_deleted = sum(delete_download_artifacts(entry, fallback_dir) for entry in entries)
            rows = 0
            with _db_lock, db() as conn:
                for entry in entries:
                    current = conn.execute('SELECT status, filename FROM downloads WHERE id = ?', (entry['id'],)).fetchone()
                    if current is not None and current['status'] in HISTORY_STATUSES and current['filename'] == entry['filename']:
                        _db_remove_download_from_playlists(conn, entry['id'])
                        rows += conn.execute('DELETE FROM downloads WHERE id = ?', (entry['id'],)).rowcount
        if rows:
            event_bus.publish('change', {'reason': 'clear', 'count': rows})
        return rows, files_deleted


def db_list_downloads(user_id=None, is_admin=False, statuses=None):
    with db() as conn:
        conn.execute("BEGIN")
        conditions = []
        values = []
        if user_id is not None and not is_admin:
            conditions.append(
                "(downloads.visibility = 'public' OR downloads.owner_user_id = ?)"
            )
            values.append(user_id)
        if statuses is not None:
            conditions.append(
                "downloads.status IN (" + ",".join("?" for _ in statuses) + ")"
            )
            values.extend(statuses)
        visibility_sql = "WHERE " + " AND ".join(conditions) + " " if conditions else ""
        rows = conn.execute(
            "SELECT downloads.id, url, status, progress, "
            "downloads.created_at, "
            "filename, display_filename, resolution, filesize, speed, eta, title, finished_at, "
            "duration_seconds, media_metadata_probed, "
            "formats, requested_format, downloaded_bytes, total_bytes, favorite, "
            "view_count, tags_revision, favorite_revision, rename_revision, command_revision, removal_revision, "
            "source_type, owner_user_id, visibility, browser_authenticated, "
            "(downloads.ingest_source_path IS NOT NULL) AS mounted_import, "
            "COALESCE(users.username, downloads.owner_username) "
            "AS downloaded_by "
            "FROM downloads "
            "LEFT JOIN users ON users.id = downloads.owner_user_id "
            + visibility_sql
            + "ORDER BY downloads.created_at DESC",
            values,
        ).fetchall()
        downloads = [dict(r) for r in rows]
        tags_by_download = {}
        for row in conn.execute(
            "SELECT download_tags.download_id, tags.name, tags.normalized_name "
            "FROM download_tags "
            "JOIN tags ON tags.id = download_tags.tag_id "
            "JOIN downloads ON downloads.id = download_tags.download_id "
            + visibility_sql
            + "ORDER BY tags.name COLLATE NOCASE, tags.name",
            values,
        ):
            tags_by_download.setdefault(row["download_id"], []).append(
                {"key": row["normalized_name"], "name": row["name"]}
            )
        for download in downloads:
            download.update(_download_command_snapshot(conn, download["id"], download))
            if download["source_type"] == "upload":
                download["upload"] = _upload_snapshot(conn, download["id"])
                download["can_manage_upload"] = bool(user_id is not None and download["owner_user_id"] == user_id and conn.execute('SELECT 1 FROM upload_operations WHERE id=? AND actor_id=?', (download["id"], user_id)).fetchone())
            download["removal_revision"] = str(download["removal_revision"])
            download["rename_revision"] = str(download["rename_revision"])
            download.update(_serialize_favorite_state(
                download['id'], download['favorite'], download['favorite_revision'],
            ))
            download["browser_authenticated"] = bool(
                download["browser_authenticated"]
            )
            download["media_metadata_probed"] = bool(
                download["media_metadata_probed"]
            )
            download["mounted_import"] = bool(download["mounted_import"])
            download["quality"] = classify_video_quality(
                download["resolution"]
            )
            download.update(_serialize_tag_state(
                download['id'], tags_by_download.get(download['id'], []),
                download['tags_revision'],
            ))
            download["can_manage_visibility"] = (
                is_admin or download["owner_user_id"] == user_id
            )
            # The stable account id is an authorization detail; clients only
            # need the display name and this derived capability.
            download.pop("owner_user_id")
        return downloads


def _public_download_entry(entry):
    """Keep physical library paths out of ordinary browser responses."""
    public = dict(entry)
    stored = public.get('filename')
    public['filename'] = (
        public.get('display_filename') or os.path.basename(stored)
        if stored else None
    )
    if (entry['status'] in ('starting', 'downloading', 'paused')
            and is_cancel_requested(entry['id'])):
        public['progress'] = 'Stopping download; waiting for the source to respond'
    return public


def _hash_backfill_once():
    """Index finished library rows serially, including legacy unindexed rows."""
    with db() as conn:
        candidates = [dict(row) for row in conn.execute(
            "SELECT downloads.id, downloads.filename, media_hashes.state, "
            "media_hashes.device, media_hashes.inode, media_hashes.byte_size, "
            "media_hashes.mtime_ns FROM downloads "
            "LEFT JOIN media_hashes ON media_hashes.download_id = downloads.id "
            "WHERE downloads.status = 'finished' ORDER BY downloads.created_at"
        )]
    changed = False
    allowed_bases = _trusted_download_directories()
    for candidate in candidates:
        download_id, filename = candidate['id'], candidate['filename']
        identity = _current_file_identity(filename, allowed_bases)
        recorded = (
            candidate['device'], candidate['inode'],
            candidate['byte_size'], candidate['mtime_ns'],
        )
        if candidate['state'] == 'ready' and identity == recorded:
            continue
        if candidate['state'] == 'unavailable':
            continue
        try:
            if identity is None:
                raise OSError('Media is missing or outside the library')
            digest, hashed_identity = _hash_final_file(filename, allowed_bases)
            if _current_file_identity(filename, allowed_bases) != hashed_identity:
                raise OSError('Media changed while hashing')
        except (OSError, ValueError):
            state = 'unavailable'
        else:
            state = 'ready'
        with _db_lock, db() as conn:
            current = conn.execute(
                "SELECT filename FROM downloads "
                "WHERE id = ? AND status = 'finished'", (download_id,)
            ).fetchone()
            if current is None or current['filename'] != filename:
                continue
            if state == 'ready':
                conn.execute(
                    "INSERT INTO media_hashes(download_id, algorithm, digest, "
                    "byte_size, device, inode, mtime_ns, state) "
                    "VALUES (?, 'sha256', ?, ?, ?, ?, ?, 'ready') "
                    "ON CONFLICT(download_id) DO UPDATE SET "
                    "algorithm='sha256', digest=excluded.digest, "
                    "byte_size=excluded.byte_size, device=excluded.device, "
                    "inode=excluded.inode, mtime_ns=excluded.mtime_ns, "
                    "state='ready'",
                    (download_id, digest, hashed_identity[2],
                     hashed_identity[0], hashed_identity[1], hashed_identity[3]),
                )
            else:
                conn.execute(
                    "INSERT INTO media_hashes(download_id, state) "
                    "VALUES (?, 'unavailable') "
                    "ON CONFLICT(download_id) DO UPDATE SET "
                    "state='unavailable', digest=NULL, byte_size=NULL",
                    (download_id,),
                )
            changed = True
    if changed:
        event_bus.publish('change', {'reason': 'duplicates'})


def _mark_hash_state(download_id, state):
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO media_hashes(download_id, state) VALUES (?, ?) "
            "ON CONFLICT(download_id) DO UPDATE SET "
            "state=excluded.state, digest=NULL, byte_size=NULL",
            (download_id, state),
        )
    if state == 'pending':
        _wake_duplicate_backfill()


def _files_match(left, right, expected_size):
    """Confirm a digest match by comparing final bytes and file identities."""
    left_path, left_identity = left
    right_path, right_identity = right
    if (_current_file_identity(left_path) != left_identity
            or _current_file_identity(right_path) != right_identity):
        raise OSError('Media changed before comparison')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    left_fd = os.open(left_path, flags)
    try:
        right_fd = os.open(right_path, flags)
    except BaseException:
        os.close(left_fd)
        raise
    with os.fdopen(left_fd, 'rb') as first, os.fdopen(right_fd, 'rb') as second:
        if (_file_identity(os.fstat(first.fileno())) != left_identity
                or _file_identity(os.fstat(second.fileno())) != right_identity):
            raise OSError('Media changed before comparison')
        read_size = 0
        equal = True
        while True:
            a = first.read(1024 * 1024)
            b = second.read(1024 * 1024)
            if a != b:
                equal = False
                break
            if not a:
                break
            read_size += len(a)
        if (_file_identity(os.fstat(first.fileno())) != left_identity
                or _file_identity(os.fstat(second.fileno())) != right_identity
                or _current_file_identity(left_path) != left_identity
                or _current_file_identity(right_path) != right_identity):
            raise OSError('Media changed during comparison')
        return equal and read_size == expected_size


def _duplicate_groups(user_id, is_admin):
    entries = [entry for entry in db_list_downloads(user_id, is_admin)
               if entry['status'] == 'finished']
    with db() as conn:
        hashes = {row['download_id']: dict(row)
                  for row in conn.execute("SELECT * FROM media_hashes")}
    candidates = {}
    pending_count = unavailable_count = 0
    for entry in entries:
        record = hashes.get(entry['id'])
        identity = _current_file_identity(entry['filename'])
        if identity is None:
            unavailable_count += 1
            if record is not None and record['state'] != 'unavailable':
                _mark_hash_state(entry['id'], 'unavailable')
            continue
        if record is None or record['state'] == 'pending':
            pending_count += 1
            _wake_duplicate_backfill()
            continue
        if record['state'] == 'unavailable':
            unavailable_count += 1
            continue
        recorded = (record['device'], record['inode'],
                    record['byte_size'], record['mtime_ns'])
        if identity != recorded:
            pending_count += 1
            _mark_hash_state(entry['id'], 'pending')
            continue
        candidates.setdefault(
            (record['byte_size'], record['digest']), []
        ).append((entry, identity))

    groups = []
    for (byte_size, _digest), members in candidates.items():
        if len(members) < 2:
            continue
        confirmed = []
        for member in members:
            placed = False
            for group in confirmed:
                representative = group[0]
                try:
                    same = _files_match(
                        (member[0]['filename'], member[1]),
                        (representative[0]['filename'], representative[1]),
                        byte_size,
                    )
                except OSError:
                    pending_count += 1
                    _mark_hash_state(member[0]['id'], 'pending')
                    placed = True
                    break
                if same:
                    group.append(member)
                    placed = True
                    break
            if not placed:
                confirmed.append([member])
        for group in confirmed:
            if len(group) > 1:
                changed = []
                for entry, identity in group:
                    current_identity = _current_file_identity(entry['filename'])
                    if current_identity != identity:
                        changed.append((entry, current_identity))
                if changed:
                    for entry, current_identity in changed:
                        state = ('pending' if current_identity is not None
                                 else 'unavailable')
                        _mark_hash_state(entry['id'], state)
                        if state == 'pending':
                            pending_count += 1
                        else:
                            unavailable_count += 1
                    continue
                groups.append({
                    'byte_size': byte_size,
                    'item_count': len(group),
                    'items': [_public_download_entry(entry)
                              for entry, _identity in group],
                })
    groups.sort(key=lambda group: group['items'][0]['created_at'], reverse=True)
    return {
        'groups': groups,
        'pending_count': pending_count,
        'unavailable_count': unavailable_count,
    }


def _parse_history_filter(value):
    """Mirror the browser's quote-aware History tokenization."""
    terms = []
    draft = []
    quoted = False
    for character in value:
        if character == '"':
            quoted = not quoted
        elif character.isspace() and not quoted:
            if draft:
                terms.append(''.join(draft))
                draft = []
        else:
            draft.append(character)
    if draft:
        terms.append(''.join(draft))
    return [term.strip() for term in terms if term.strip()]


def _normalize_history_filter(value):
    if not isinstance(value, str):
        raise ValueError('Filter must be text')
    value = unicodedata.normalize('NFC', value).strip()
    if len(value) > PLAYBACK_SESSION_MAX_FILTER_LENGTH:
        raise ValueError(
            f'Filter must be at most {PLAYBACK_SESSION_MAX_FILTER_LENGTH} characters'
        )
    # Re-quoting whitespace-bearing terms preserves their token boundary when
    # the normalized value is parsed again on each live resolution.
    return ' '.join(
        f'"{term}"' if any(character.isspace() for character in term) else term
        for term in _parse_history_filter(value)
    )


def _history_search_key(value):
    return str(value or '').lower()


def _parse_duration_filter(terms):
    """Keep duration comparisons separate from text and repeated OR groups."""
    conditions = []
    error = 'Use duration:>10m or duration:>=1:30:00'
    number_pattern = r'[0-9]+(?:\.[0-9]+)?'
    for term in terms:
        key = _history_search_key(term)
        if not key.startswith('duration:'):
            continue
        comparison = re.fullmatch(r'duration:(>=|<=|>|<)(.+)', key)
        if comparison is None:
            raise ValueError(error)
        operator, value = comparison.groups()
        if re.fullmatch(number_pattern, value):
            seconds = float(value)
        elif re.fullmatch(r'[0-9]+:[0-5][0-9](?::[0-5][0-9])?', value):
            seconds = 0.0
            for part in value.split(':'):
                seconds = seconds * 60 + float(part)
        else:
            parts = list(re.finditer(f'({number_pattern})([hms])', value))
            if not parts or ''.join(part.group() for part in parts) != value:
                raise ValueError(error)
            previous = 3601
            seconds = 0.0
            for index, part in enumerate(parts):
                amount, unit = part.groups()
                factor = {'h': 3600, 'm': 60, 's': 1}[unit]
                if (factor >= previous
                        or ('.' in amount and index != len(parts) - 1)):
                    raise ValueError(error)
                seconds += float(amount) * factor
                previous = factor
        if not math.isfinite(seconds):
            raise ValueError(error)
        conditions.append((operator, seconds))
    return conditions


def _history_quality_height(value):
    key = _history_search_key(value)
    aliases = {
        '8k': 4320, '4k': 2160, 'uhd': 2160,
        '2k': 1440, 'qhd': 1440,
    }
    if key in aliases:
        return aliases[key]
    dimensions = re.fullmatch(r'(\d+)\s*[x×]\s*(\d+)', key)
    vertical = re.fullmatch(r'(\d+)\s*p?', key)
    height = int(dimensions.group(2)) if dimensions else (
        int(vertical.group(1)) if vertical else 0
    )
    return height if height > 0 else None


def _matches_history_filter(entry, normalized_filter, duration_conditions=None):
    terms = _parse_history_filter(normalized_filter)
    if not terms:
        return True

    if duration_conditions is None:
        try:
            duration_conditions = _parse_duration_filter(terms)
        except ValueError:
            return False
    if duration_conditions:
        duration = entry.get('duration_seconds')
        if (isinstance(duration, bool)
                or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or duration <= 0):
            return False
        for operator, seconds in duration_conditions:
            if not {
                    '>': duration > seconds, '>=': duration >= seconds,
                    '<': duration < seconds, '<=': duration <= seconds,
            }[operator]:
                return False

    title = _history_search_key(entry.get('title'))
    display_filename = _history_search_key(
        entry.get('display_filename')
        or os.path.basename(entry.get('filename') or '')
    )
    tags = {
        _history_search_key(tag) for tag in entry.get('tags', [])
    }
    user_terms = []
    quality_terms = []
    starred_terms = []
    view_terms = []
    playlist_terms = []
    content_terms = []
    for term in terms:
        key = _history_search_key(term)
        if key.startswith('duration:'):
            continue
        elif key.startswith('user:'):
            user_terms.append(key[len('user:'):].strip())
        elif key.startswith('quality:'):
            quality_terms.append(
                _history_quality_height(key[len('quality:'):].strip())
            )
        elif key.startswith('starred:'):
            starred_terms.append(key[len('starred:'):].strip())
        elif key.startswith('star:'):
            starred_terms.append(key[len('star:'):].strip())
        elif key.startswith('views:'):
            view_terms.append(key[len('views:'):].strip())
        elif key.startswith(('playlist:', 'playlists:')):
            playlist_terms.append(key.split(':', 1)[1].strip())
        else:
            content_terms.append(term)

    if user_terms:
        downloaded_by = _history_search_key(entry.get('downloaded_by'))
        if not any(term and term == downloaded_by for term in user_terms):
            return False
    if quality_terms:
        height = _history_quality_height(entry.get('resolution'))
        if height is None:
            height = _history_quality_height(entry.get('quality'))
        if not any(
                minimum is not None
                and height is not None
                and height >= minimum
                for minimum in quality_terms):
            return False
    if starred_terms:
        favorite = bool(entry.get('favorite'))
        if not any(
                (value == 'yes' and favorite)
                or (value == 'no' and not favorite)
                for value in starred_terms):
            return False
    if view_terms:
        try:
            view_count = max(0, int(entry.get('view_count') or 0))
        except (TypeError, ValueError):
            view_count = 0
        if not any(
                (value == 'new' and view_count == 0)
                or (value.isdigit() and view_count >= int(value))
                for value in view_terms):
            return False
    # Playback selection contains only videos, so the browser's playlist-only
    # result mode intentionally resolves to no candidates.
    if playlist_terms and 'no' not in playlist_terms:
        return False
    if not content_terms:
        return True
    return any(
        (_history_search_key(term) in title)
        or (_history_search_key(term) in display_filename)
        or (_history_search_key(term) in tags)
        for term in content_terms
    )


def _playable_library_entry(entry, allowed_bases=None):
    if entry.get('status') != 'finished':
        return False
    filename = entry.get('filename')
    if not filename or not os.path.isfile(filename):
        return False
    return _is_allowed_download_path(filename, allowed_bases)


# ---------------------------------------------------------------------------
# Durable daily video-storage observations
# ---------------------------------------------------------------------------

LIBRARY_STORAGE_INTERVAL = 86_400
LIBRARY_STORAGE_RETRY = 1_800
LIBRARY_STORAGE_BATCH = 200
_storage_lock = threading.RLock()
_storage_refresh_lock = threading.Lock()
_storage_timer = None
_storage_timer_db = None
_storage_retry_at = 0
_storage_epoch = 0
_storage_scan_owner = threading.local()


class _StorageInterrupted(Exception):
    pass


def _storage_check_owner():
    owner = getattr(_storage_scan_owner, 'value', None)
    if owner is not None and owner != (DB_PATH, _storage_epoch):
        raise _StorageInterrupted()


def _storage_now():
    return time.time()


def _storage_timestamp(value):
    return (datetime.fromtimestamp(value, timezone.utc).isoformat()
            if value is not None else None)


def _storage_deadline(snapshot):
    return max(snapshot['next_refresh_at'] or 0, snapshot['retry_at'] or 0)


def _storage_directory_available(path):
    path = os.path.abspath(path)
    info = os.stat(path)
    if not stat.S_ISDIR(info.st_mode) or not os.access(path, os.R_OK | os.X_OK):
        raise OSError('Video storage directory is unavailable')
    roots = getattr(_storage_scan_owner, 'roots', None)
    if roots is not None:
        identity = (str(info.st_dev), str(info.st_ino))
        expected = _storage_scan_owner.expected_roots.get(path, identity)
        # An unmounted volume can expose an accessible empty directory. Keep
        # the previous snapshot until the previously observed source returns.
        if identity != expected or identity != roots.get(path, identity):
            raise OSError('Video storage directory identity changed')
        roots[path] = identity


def _storage_file(entry, allowed_bases):
    filename = entry['filename']
    if (not filename or Path(filename).suffix.lower() not in BROWSER_VIDEO_EXTENSIONS
            or Path(os.path.realpath(filename)).suffix.lower() not in BROWSER_VIDEO_EXTENSIONS
            or not _is_allowed_download_path(filename, allowed_bases)):
        return None
    # Validate captured roots even when an unmount left a readable directory
    # behind; a missing individual file inside the original root is harmless.
    _storage_directory_available(entry['output_dir'] or os.path.dirname(filename) or '.')
    try:
        info = os.stat(filename)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return (str(info.st_dev), str(info.st_ino), info.st_size, info.st_mtime_ns)


def _measure_library_storage(generation):
    """Stage bounded observations without holding a writer lock over stat calls."""
    _storage_check_owner()
    with db() as conn:
        allowed_bases = _trusted_download_directories(conn)
        _storage_scan_owner.roots = {}
        _storage_scan_owner.expected_roots = {
            row['path']: (row['device'], row['inode'])
            for row in conn.execute('SELECT * FROM library_storage_roots')
        }
        preference = conn.execute(
            "SELECT value FROM preferences WHERE key = 'download_dir'"
        ).fetchone()
        maximum = conn.execute('SELECT MAX(rowid) FROM downloads').fetchone()[0] or 0
    _storage_directory_available(preference[0] if preference else DEFAULT_DOWNLOAD_DIR)
    configured_source = os.environ.get('VDL_INGEST_DIR', '').strip()
    if configured_source:
        _storage_directory_available(configured_source)
    after = 0
    while after < maximum:
        _storage_check_owner()
        with db() as conn:
            entries = conn.execute(
                "SELECT rowid AS scan_rowid, id, created_at, filename, output_dir "
                "FROM downloads WHERE status = 'finished' AND rowid > ? "
                "AND rowid <= ? ORDER BY rowid LIMIT ?",
                (after, maximum, LIBRARY_STORAGE_BATCH),
            ).fetchall()
        if not entries:
            break
        after = entries[-1]['scan_rowid']
        measurements = []
        for entry in entries:
            _storage_check_owner()
            info = _storage_file(entry, allowed_bases)
            if info is not None:
                measurements.append((generation, entry['id'], entry['created_at'],
                                     entry['filename'], entry['output_dir'], *info))
        _storage_check_owner()
        with _db_lock, db() as conn:
            _storage_check_owner()
            conn.executemany(
                'INSERT INTO library_storage_staging '
                '(generation, download_id, entry_created_at, filename, output_dir, '
                'device, inode, byte_size, mtime_ns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                measurements,
            )
    # Recheck file identity after discovery. A replacement or rename must not
    # attach the old file's size to a newly published Library record.
    after = 0
    while True:
        _storage_check_owner()
        with db() as conn:
            rows = conn.execute(
                'SELECT rowid AS scan_rowid, * FROM library_storage_staging '
                'WHERE generation = ? AND rowid > ? ORDER BY rowid LIMIT ?',
                (generation, after, LIBRARY_STORAGE_BATCH),
            ).fetchall()
        if not rows:
            break
        after = rows[-1]['scan_rowid']
        rejected = []
        for row in rows:
            _storage_check_owner()
            current = _storage_file(row, allowed_bases)
            if current != (row['device'], row['inode'], row['byte_size'], row['mtime_ns']):
                rejected.append((generation, row['download_id']))
        _storage_check_owner()
        with _db_lock, db() as conn:
            _storage_check_owner()
            conn.executemany(
                'DELETE FROM library_storage_staging WHERE generation = ? AND download_id = ?',
                rejected,
            )

    _storage_check_owner()
    for path in _storage_scan_owner.roots:
        _storage_directory_available(path)
    with _db_lock, db() as conn:
        _storage_check_owner()
        conn.executemany(
            'INSERT INTO library_storage_staging_roots '
            '(generation, path, device, inode) VALUES (?, ?, ?, ?)',
            ((generation, path, *identity)
             for path, identity in _storage_scan_owner.roots.items()),
        )


def _publish_library_storage(generation):
    _storage_check_owner()
    with _storage_lock, _db_lock, db() as conn:
        _storage_check_owner()
        conn.execute('DELETE FROM library_storage_members')
        conn.execute(
            'INSERT INTO library_storage_members '
            '(download_id, entry_created_at, device, inode, byte_size) '
            'SELECT s.download_id, s.entry_created_at, s.device, s.inode, s.byte_size '
            'FROM library_storage_staging s JOIN downloads d '
            'ON d.id = s.download_id AND d.created_at = s.entry_created_at '
            "AND d.status = 'finished' AND d.filename = s.filename "
            'AND d.output_dir IS s.output_dir WHERE s.generation = ?',
            (generation,),
        )
        conn.execute('DELETE FROM library_storage_roots')
        conn.execute(
            'INSERT INTO library_storage_roots(path, device, inode) '
            'SELECT path, device, inode FROM library_storage_staging_roots '
            'WHERE generation = ?', (generation,),
        )
        measured_at = _storage_now()
        conn.execute(
            'UPDATE library_storage_snapshot SET measured_at = ?, next_refresh_at = ?, '
            'retry_at = NULL, failed = 0 WHERE singleton = 1',
            (measured_at, measured_at + LIBRARY_STORAGE_INTERVAL),
        )
        conn.execute('DELETE FROM library_storage_staging')
        conn.execute('DELETE FROM library_storage_staging_roots')


def refresh_library_storage():
    """Run at most one due observation; requests only ever read saved results."""
    global _storage_retry_at
    if not _storage_refresh_lock.acquire(blocking=False):
        return False
    try:
        _storage_scan_owner.value = (DB_PATH, _storage_epoch)
        with db() as conn:
            snapshot = conn.execute('SELECT * FROM library_storage_snapshot').fetchone()
        if _storage_now() < max(_storage_deadline(snapshot), _storage_retry_at):
            return False
        generation = uuid.uuid4().hex
        _storage_check_owner()
        with _db_lock, db() as conn:
            _storage_check_owner()
            conn.execute('DELETE FROM library_storage_staging')
            conn.execute('DELETE FROM library_storage_staging_roots')
        _measure_library_storage(generation)
        _publish_library_storage(generation)
        _storage_retry_at = 0
        event_bus.publish('library_storage', {})
        return True
    except _StorageInterrupted:
        return False
    except Exception:
        if getattr(_storage_scan_owner, 'value', None) != (DB_PATH, _storage_epoch):
            return False
        # If SQLite itself is unavailable the in-process retry deadline still
        # prevents a hot loop; the last committed generation remains intact.
        _storage_retry_at = _storage_now() + LIBRARY_STORAGE_RETRY
        try:
            with _storage_lock, _db_lock, db() as conn:
                _storage_check_owner()
                conn.execute(
                    'UPDATE library_storage_snapshot SET failed = 1, retry_at = ? '
                    'WHERE singleton = 1', (_storage_retry_at,),
                )
        except (sqlite3.Error, _StorageInterrupted):
            pass
        app.logger.exception('Daily video-storage measurement failed')
        event_bus.publish('library_storage', {})
        return False
    finally:
        _storage_scan_owner.value = None
        _storage_scan_owner.roots = None
        _storage_scan_owner.expected_roots = None
        _storage_refresh_lock.release()


def stop_library_storage():
    global _storage_timer, _storage_timer_db, _storage_retry_at, _storage_epoch
    with _storage_lock:
        _storage_epoch += 1
        if _storage_timer is not None:
            _storage_timer.cancel()
        _storage_timer = None
        _storage_timer_db = None
        _storage_retry_at = 0


def start_library_storage():
    """Restore the saved deadline; the serving process owns one daemon timer."""
    global _storage_timer, _storage_timer_db
    with _storage_lock:
        if _storage_timer is not None and _storage_timer_db == DB_PATH:
            return
        if _storage_timer_db is not None and _storage_timer_db != DB_PATH:
            stop_library_storage()
        try:
            with db() as conn:
                snapshot = conn.execute('SELECT * FROM library_storage_snapshot').fetchone()
            deadline = max(_storage_deadline(snapshot), _storage_retry_at)
        except sqlite3.Error:
            deadline = max(_storage_retry_at, _storage_now() + LIBRARY_STORAGE_RETRY)
        database = DB_PATH

        def wake():
            global _storage_timer
            with _storage_lock:
                if _storage_timer is not timer or DB_PATH != database:
                    return
            refresh_library_storage()
            with _storage_lock:
                if _storage_timer is not timer or DB_PATH != database:
                    return
                _storage_timer = None
                start_library_storage()

        timer = threading.Timer(max(0, deadline - _storage_now()), wake)
        timer.daemon = True
        _storage_timer = timer
        _storage_timer_db = database
        timer.start()


@app.route('/api/library-storage')
def library_storage():
    with db() as conn:
        conn.execute('BEGIN')
        snapshot = conn.execute('SELECT * FROM library_storage_snapshot').fetchone()
        measured_at = snapshot['measured_at']
        total = None
        if measured_at is not None:
            is_admin = 'admin' in g.current_user['roles']
            # Authorize associations before collapsing aliases, so a private
            # alias cannot hide a shared file or expose its owner's collection.
            rows = conn.execute(
                'SELECT m.device, m.inode, MAX(m.byte_size) AS byte_size '
                'FROM library_storage_members m JOIN downloads d '
                'ON d.id = m.download_id AND d.created_at = m.entry_created_at '
                "WHERE d.status = 'finished' AND (? OR d.visibility = 'public' "
                'OR d.owner_user_id = ?) GROUP BY m.device, m.inode',
                (is_admin, g.current_user['id']),
            )
            total = sum(row['byte_size'] for row in rows)
        state = ('unavailable' if snapshot['failed'] or _storage_retry_at else 'calculating')
        if measured_at is not None:
            state = ('stale' if snapshot['failed'] or _storage_retry_at
                     or _storage_now() >= snapshot['next_refresh_at'] else 'ready')
        response = jsonify(
            total_bytes=total, measured_at=_storage_timestamp(measured_at),
            next_refresh_at=_storage_timestamp(snapshot['next_refresh_at']), state=state,
        )
    response.headers['Cache-Control'] = 'no-store'
    return response


class RotationRefreshError(Exception):
    pass


@app.errorhandler(RotationRefreshError)
def rotation_refresh_failed(_error):
    response = jsonify({
        'error': 'Library rotation could not be refreshed. Please retry refresh.',
        'code': 'rotation_refresh_failed', 'retryable': True,
    })
    response.status_code = 503
    response.headers['Cache-Control'] = 'no-store'
    return response


def _rotation_now():
    return time.time()


def _rotation_shuffle(ids):
    # Unbiased bounded choices give every complete permutation equal weight.
    for index in range(len(ids) - 1, 0, -1):
        other = secrets.randbelow(index + 1)
        ids[index], ids[other] = ids[other], ids[index]


def _cancel_rotation_timer():
    global _rotation_timer, _rotation_timer_db
    if _rotation_timer is not None:
        _rotation_timer.cancel()
    _rotation_timer = None
    _rotation_timer_db = None


def _schedule_rotation_timer(expires_at, retry=False):
    global _rotation_timer, _rotation_timer_db
    deadline = _rotation_now() + 30 if retry else expires_at
    if (_rotation_timer is not None and _rotation_timer_db == DB_PATH
            and getattr(_rotation_timer, 'rotation_deadline', None) == deadline):
        return
    _cancel_rotation_timer()
    database_path = DB_PATH

    def wake():
        global _rotation_timer
        with _rotation_lock:
            if DB_PATH != database_path or _rotation_timer is not timer:
                return
            _rotation_timer = None
            try:
                _current_library_rotation()
            except RotationRefreshError:
                # Keep the durable deadline intact; a read can retry immediately.
                _schedule_rotation_timer(expires_at, retry=True)
                event_bus.publish('change', {'reason': 'library_rotation'})

    timer = threading.Timer(max(0, deadline - _rotation_now()), wake)
    timer.daemon = True
    timer.rotation_deadline = deadline
    _rotation_timer = timer
    _rotation_timer_db = database_path
    timer.start()


def _restore_rotation_timer():
    with _rotation_lock:
        _cancel_rotation_timer()
        preferences = db_get_preferences()
        if preferences.get('library_rotation_enabled') == 'true':
            with db() as conn:
                row = conn.execute('SELECT expires_at FROM library_rotation').fetchone()
            _schedule_rotation_timer(row['expires_at'] if row else _rotation_now())


def _new_rotation_members():
    allowed_bases = _trusted_download_directories()
    ids = list(dict.fromkeys(
        str(entry['id']) for entry in db_list_downloads(statuses=('finished',))
        if _playable_library_entry(entry, allowed_bases)
    ))
    _rotation_shuffle(ids)
    return ids


def _write_library_rotation(conn, ids, hours):
    conn.execute('DELETE FROM library_rotation_members')
    conn.executemany(
        'INSERT INTO library_rotation_members(download_id, position) VALUES (?, ?)',
        ((download_id, position) for position, download_id in enumerate(ids)),
    )
    # Start the lifetime at publication, after the potentially large deck write.
    created_at = _rotation_now()
    order = {
        'kind': 'rotation', 'generation_id': secrets.token_urlsafe(24),
        'created_at': created_at, 'expires_at': created_at + int(hours) * 3600,
    }
    conn.execute(
        'INSERT INTO library_rotation(singleton, generation_id, created_at, expires_at) '
        'VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET '
        'generation_id = excluded.generation_id, created_at = excluded.created_at, '
        'expires_at = excluded.expires_at',
        (order['generation_id'], order['created_at'], order['expires_at']),
    )
    return order


def _current_library_rotation():
    """Read or publish one complete deck. Callers serialize on _rotation_lock."""
    try:
        with db() as conn:
            preferences = {row['key']: row['value'] for row in conn.execute(
                'SELECT key, value FROM preferences'
            )}
            if has_request_context():
                # Share the short read connection with the Library's root
                # snapshot so disabled rotation keeps its fixed query budget.
                _trusted_download_directories(conn)
        if preferences.get('library_rotation_enabled') != 'true':
            _cancel_rotation_timer()
            return {'kind': 'library', 'generation_id': None,
                    'created_at': None, 'expires_at': None}, {}
        with db() as conn:
            row = conn.execute('SELECT * FROM library_rotation').fetchone()
            members = dict(conn.execute(
                'SELECT download_id, position FROM library_rotation_members'
            ).fetchall())
        if row is not None and _rotation_now() < row['expires_at']:
            order = {'kind': 'rotation', **{key: row[key] for key in (
                'generation_id', 'created_at', 'expires_at')}}
        else:
            ids = _new_rotation_members()
            with _db_lock, db() as conn:
                order = _write_library_rotation(
                    conn, ids, preferences['library_rotation_hours']
                )
            members = {download_id: position for position, download_id in enumerate(ids)}
            event_bus.publish('change', {'reason': 'library_rotation'})
        _schedule_rotation_timer(order['expires_at'])
        return order, members
    except (OSError, sqlite3.Error) as exc:
        raise RotationRefreshError() from exc


def resolve_library_snapshot(user_id, is_admin, normalized_filter, ordering):
    """Keep public selection and metadata from the same current generation."""
    with _rotation_lock:
        while True:
            order, positions = _current_library_rotation()
            entries = _ordinary_library_selection(
                user_id, is_admin, normalized_filter, ordering
            )
            if order['kind'] == 'library':
                return entries, order, {}
            entries = [entry for entry in entries if str(entry['id']) in positions]
            entries.sort(key=lambda entry: positions[str(entry['id'])])
            if _rotation_now() < order['expires_at']:
                return entries, order, positions


def resolve_library_selection(user_id, is_admin, normalized_filter, ordering):
    return resolve_library_snapshot(
        user_id, is_admin, normalized_filter, ordering
    )[0]


def _ordinary_library_selection(user_id, is_admin, normalized_filter, ordering):
    """Return the current canonical, visible, browser-playable selection."""
    duration_conditions = _parse_duration_filter(
        _parse_history_filter(normalized_filter)
    )
    entries = [
        entry for entry in _visible_playable_library_entries(user_id, is_admin)
        if _matches_history_filter(entry, normalized_filter, duration_conditions)
    ]
    if ordering == 'favorites_first':
        entries.sort(
            key=lambda entry: (
                bool(entry.get('favorite')),
                float(entry.get('created_at') or 0),
                str(entry.get('id') or ''),
            ),
            reverse=True,
        )
    elif ordering == 'newest':
        entries.sort(
            key=lambda entry: (
                float(entry.get('created_at') or 0),
                str(entry.get('id') or ''),
            ),
            reverse=True,
        )
    return entries


def resolve_library_page(user_id, is_admin, normalized_filter, ordering,
                         page_size, page):
    """Resolve one deterministic page without retaining the result set."""
    selection = resolve_library_selection(
        user_id, is_admin, normalized_filter, ordering
    )
    start = page * page_size
    return selection[start:start + page_size], len(selection)


def _shuffle_preferences(preferences):
    """Validate persisted shuffle thresholds without silently repairing them."""
    raw_height = preferences.get('shuffle_min_height', '0')
    raw_minutes = preferences.get('shuffle_min_duration_minutes', '0')
    if (not isinstance(raw_height, str) or not raw_height.isascii()
            or not raw_height.isdigit()):
        raise ValueError('Stored Shuffle minimum quality is invalid')
    if (not isinstance(raw_minutes, str) or not raw_minutes.isascii()
            or not raw_minutes.isdigit()):
        raise ValueError('Stored Shuffle minimum length is invalid')
    height = int(raw_height, 10)
    minutes = int(raw_minutes, 10)
    if height not in SHUFFLE_MIN_HEIGHTS:
        raise ValueError('Stored Shuffle minimum quality is invalid')
    if not 0 <= minutes <= 1440:
        raise ValueError('Stored Shuffle minimum length is invalid')
    return height, minutes * 60


def resolve_shuffle_pool(user_id, is_admin, minimum_height,
                         minimum_duration_seconds):
    """Resolve the live authorized pool and whether legacy metadata blocks it."""
    candidates = []
    metadata_pending = False
    allowed_bases = _trusted_download_directories()
    for entry in db_list_downloads(user_id, is_admin=is_admin, statuses=('finished',)):
        if entry.get('status') != 'finished':
            continue
        filename = entry.get('filename')
        if not filename or not os.path.isfile(filename):
            continue
        if Path(filename).suffix.lower() not in BROWSER_VIDEO_EXTENSIONS:
            continue
        real_path = os.path.realpath(filename)
        if not _is_allowed_download_path(real_path, allowed_bases):
            continue

        height = _history_quality_height(entry.get('resolution'))
        probed = bool(entry.get('media_metadata_probed'))
        if height is None:
            if not probed:
                metadata_pending = True
            continue
        if minimum_height and height < minimum_height:
            continue

        duration = _finite_positive_number(entry.get('duration_seconds'))
        if minimum_duration_seconds and (
                duration is None or duration < minimum_duration_seconds):
            if duration is None and not probed:
                metadata_pending = True
            continue
        candidates.append(entry)
    return candidates, metadata_pending


def _shuffle_choice(candidates):
    """Choose uniformly without making a seeded sequence part of the API."""
    return candidates[secrets.randbelow(len(candidates))]


def _playback_item(entry, *, include_source_revision=False):
    filename = entry.get('filename') or ''
    title = entry.get('title') or Path(filename).stem or 'Untitled download'
    item = {
        'id': str(entry['id']),
        'title': title,
        'extension': Path(filename).suffix.lstrip('.').lower(),
    }
    if include_source_revision:
        # A row can keep its ID while its file changes. Keep paths private while
        # letting the browser reject a standby buffer from the previous source.
        try:
            canonical_path = os.path.realpath(filename)
            signature = _source_signature(canonical_path)
        except IngestSourceChanged:
            item['source_revision'] = None
        else:
            identity = json.dumps((canonical_path, *signature)).encode('utf-8')
            item['source_revision'] = hashlib.sha256(identity).hexdigest()
    return item


def _prune_playback_sessions_locked(now):
    expired = [
        session_id for session_id, state in _playback_sessions.items()
        if now - state['last_activity'] >= PLAYBACK_SESSION_TTL_SECONDS
    ]
    for session_id in expired:
        _playback_sessions.pop(session_id, None)


def _release_playback_sessions_for_user(user_id):
    if user_id is None:
        return
    with _playback_sessions_lock:
        owned = [
            session_id for session_id, state in _playback_sessions.items()
            if state['owner_user_id'] == user_id
        ]
        for session_id in owned:
            _playback_sessions.pop(session_id, None)


def _playback_session_response(state, entry):
    response = {
        'session_id': state['session_id'],
        'mode': state['mode'],
        'sequence': state['sequence'],
        'page': state.get('page'),
        'position': state.get('position'),
        'item': _playback_item(
            entry, include_source_revision=state['mode'] == 'shuffle_clips',
        ),
    }
    if state['mode'] == 'sequential':
        response['order'] = state['order']
    if state['mode'] == 'playlist':
        response.update({
            'playlist_id': state['playlist_id'],
            'playlist_revision': state['playlist_revision'],
            'queue_position': state['playlist_position'],
            'queue': state['playlist_queue'],
            'resume_seconds': state.get('resume_seconds', 0),
            'progress_sequence': state.get('progress_sequence', 0),
        })
    return response


class PlaylistNotFound(Exception):
    """Hide unknown and foreign playlist identifiers behind one response."""


class PlaylistRevisionConflict(Exception):
    """An editor or playback request used stale playlist state."""


def _validated_playlist_name(value):
    if not isinstance(value, str):
        raise ValueError('Playlist name is required')
    name = unicodedata.normalize('NFC', value).strip()
    if (not name or len(name) > 120
            or any(unicodedata.category(character).startswith('C')
                   for character in name)):
        raise ValueError(
            'Playlist name must be between 1 and 120 visible characters'
        )
    return name


def _validated_playlist_download_ids(value):
    if not isinstance(value, list):
        raise ValueError('download_ids must be an array')
    if len(value) > PLAYLIST_MAX_ITEMS:
        raise ValueError(
            f'A playlist may contain at most {PLAYLIST_MAX_ITEMS} videos'
        )
    if any(not isinstance(item, str) or not item or len(item) > 128
           for item in value):
        raise ValueError('Every download id must be a non-empty string')
    if len(set(value)) != len(value):
        raise ValueError('A video may occur only once in a playlist')
    return value


def _playlist_download_visible(entry, user_id, is_admin):
    return bool(entry) and (
        entry.get('visibility') == 'public'
        or entry.get('owner_user_id') == user_id
        or is_admin
    )


def _playlist_download_playable(entry, user_id, is_admin):
    if (not _playlist_download_visible(entry, user_id, is_admin)
            or entry.get('status') != 'finished'):
        return False
    filename = entry.get('filename')
    if (not filename or Path(filename).suffix.lower()
            not in BROWSER_VIDEO_EXTENSIONS or not os.path.isfile(filename)):
        return False
    return _is_allowed_download_path(os.path.realpath(filename))


def _playlist_download_row(conn, download_id):
    row = conn.execute(
        "SELECT id, status, filename, title, duration_seconds, visibility, "
        "owner_user_id FROM downloads WHERE id = ?",
        (download_id,),
    ).fetchone()
    return dict(row) if row is not None else None


def _playlist_item(entry, position):
    if entry is None:
        return {
            'id': None,
            'position': position,
            'unavailable': True,
            'title': 'Unavailable video',
            'extension': '',
            'duration_seconds': None,
        }
    item = _playback_item(entry)
    item.update({
        'position': position,
        'unavailable': False,
        'duration_seconds': _finite_positive_number(
            entry.get('duration_seconds')
        ),
        'thumbnail_url': f"/api/thumbnail/{entry['id']}?v={_THUMBNAIL_CACHE_VERSION}",
    })
    return item


def _playlist_current_actor(conn, user_id, is_admin):
    if has_request_context():
        actor = _tag_actor(conn)
        if actor is None or actor['id'] != user_id:
            abort(401)
        return actor['id'], 'admin' in actor['roles']
    return user_id, is_admin


class PlaylistService:
    """Own playlist authorization, validation, repair, and transactions."""

    @staticmethod
    def _owned(conn, playlist_id, user_id):
        row = conn.execute(
            "SELECT id, owner_user_id, name, revision, created_at, "
            "content_updated_at FROM playlists "
            "WHERE id = ? AND owner_user_id = ?",
            (playlist_id, user_id),
        ).fetchone()
        if row is None:
            raise PlaylistNotFound()
        return dict(row)

    @staticmethod
    def _members(conn, playlist_id):
        return conn.execute(
            "SELECT playlist_items.download_id, downloads.id AS id, "
            "playlist_items.position, "
            "playlist_items.added_at, downloads.status, downloads.filename, "
            "downloads.title, downloads.duration_seconds, "
            "downloads.visibility, downloads.owner_user_id "
            "FROM playlist_items "
            "LEFT JOIN downloads ON downloads.id = playlist_items.download_id "
            "WHERE playlist_items.playlist_id = ? "
            "ORDER BY playlist_items.position",
            (playlist_id,),
        ).fetchall()

    @staticmethod
    def _progress(conn, playlist_id):
        row = conn.execute(
            "SELECT playlist_id, download_id, position_seconds, completed, "
            "write_sequence, updated_at FROM playlist_progress "
            "WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchone()
        if row is None:
            return None
        progress = dict(row)
        progress['completed'] = bool(progress['completed'])
        return progress

    def _validated_downloads(self, conn, download_ids, user_id, is_admin):
        entries = []
        for download_id in _validated_playlist_download_ids(download_ids):
            entry = _playlist_download_row(conn, download_id)
            if not _playlist_download_playable(entry, user_id, is_admin):
                raise ValueError(
                    'Every playlist video must be visible, finished, present, '
                    'safe, and browser-playable'
                )
            entries.append(entry)
        return entries

    def _repair_progress(self, conn, playlist_id, members, old_position=None):
        progress = self._progress(conn, playlist_id)
        if not members:
            conn.execute(
                "DELETE FROM playlist_progress WHERE playlist_id = ?",
                (playlist_id,),
            )
            return None
        member_ids = [row['download_id'] for row in members]
        if progress is None or progress['download_id'] in member_ids:
            return progress
        target_position = min(
            max(0, int(old_position or 0)), len(member_ids) - 1
        )
        now = time.time()
        conn.execute(
            "UPDATE playlist_progress SET download_id = ?, "
            "position_seconds = 0, completed = 0, "
            "write_sequence = write_sequence + 1, updated_at = ? "
            "WHERE playlist_id = ?",
            (member_ids[target_position], now, playlist_id),
        )
        return self._progress(conn, playlist_id)

    def list_summaries(self, user_id, is_admin=False):
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            user_id, is_admin = _playlist_current_actor(conn, user_id, is_admin)
            rows = conn.execute(
                "SELECT id FROM playlists WHERE owner_user_id = ? "
                "ORDER BY content_updated_at DESC, id ASC", (user_id,),
            ).fetchall()
            return [self._snapshot(conn, row['id'], user_id, is_admin) for row in rows]

    def _snapshot(self, conn, playlist_id, user_id, is_admin=False, *, repair=True):
        """Read canonical editor and shelf values in the caller's transaction."""
        playlist = self._owned(conn, playlist_id, user_id)
        members = self._members(conn, playlist_id)
        progress = self._progress(conn, playlist_id)
        old_position = next((row['position'] for row in members
                             if progress and row['download_id'] == progress['download_id']), 0)
        if repair:
            progress = self._repair_progress(conn, playlist_id, members, old_position)
        resume_position = next((row['position'] for row in members
                                if progress and row['download_id'] == progress['download_id']), 0)
        items = []
        for row in members:
            entry = dict(row)
            visible = _playlist_download_visible(entry, user_id, is_admin)
            items.append(_playlist_item(entry if visible else None, row['position']))
        playlist.update(items=items, progress=progress, resume_position=resume_position)
        return _playlist_summary(playlist)

    def get(self, playlist_id, user_id, is_admin=False):
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            user_id, is_admin = _playlist_current_actor(conn, user_id, is_admin)
            return self._snapshot(conn, playlist_id, user_id, is_admin)

    def _create(self, conn, user_id, name, download_ids, is_admin=False):
        name = _validated_playlist_name(name)
        entries = self._validated_downloads(conn, download_ids, user_id, is_admin)
        playlist_id = str(uuid.uuid4())
        now = time.time()
        conn.execute(
            "INSERT INTO playlists(id, owner_user_id, name, revision, "
            "created_at, content_updated_at) VALUES (?, ?, ?, 1, ?, ?)",
            (playlist_id, user_id, name, now, now),
        )
        for position, entry in enumerate(entries):
            conn.execute(
                "INSERT INTO playlist_items(playlist_id, download_id, position, added_at) "
                "VALUES (?, ?, ?, ?)", (playlist_id, entry['id'], position, now),
            )
        return self._snapshot(conn, playlist_id, user_id, is_admin)

    def create(self, user_id, name, download_id=None, is_admin=False,
               download_ids=None):
        if download_ids is None:
            download_ids = [] if download_id is None else [download_id]
        elif download_id is not None:
            raise ValueError('Use download_id or download_ids, not both')
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            user_id, is_admin = _playlist_current_actor(conn, user_id, is_admin)
            result = self._create(conn, user_id, name, download_ids, is_admin)
        _publish_metadata_change('playlist')
        return result

    def _replace(self, conn, playlist_id, user_id, name, download_ids,
                 expected_revision, is_admin=False):
        name = _validated_playlist_name(name)
        if (isinstance(expected_revision, bool)
                or not isinstance(expected_revision, int)
                or expected_revision < 1):
            raise ValueError('expected_revision must be a positive integer')
        playlist = self._owned(conn, playlist_id, user_id)
        if playlist['revision'] != expected_revision:
            raise PlaylistRevisionConflict()
        entries = self._validated_downloads(conn, download_ids, user_id, is_admin)
        old_members = self._members(conn, playlist_id)
        old_added = {row['download_id']: row['added_at'] for row in old_members}
        progress = self._progress(conn, playlist_id)
        old_position = next((row['position'] for row in old_members
                             if progress and row['download_id'] == progress['download_id']), 0)
        now = time.time()
        conn.execute('DELETE FROM playlist_items WHERE playlist_id = ?', (playlist_id,))
        for position, entry in enumerate(entries):
            conn.execute(
                "INSERT INTO playlist_items(playlist_id, download_id, position, added_at) "
                "VALUES (?, ?, ?, ?)",
                (playlist_id, entry['id'], position, old_added.get(entry['id'], now)),
            )
        conn.execute(
            "UPDATE playlists SET name = ?, revision = revision + 1, "
            "content_updated_at = ? WHERE id = ?", (name, now, playlist_id),
        )
        self._repair_progress(conn, playlist_id, self._members(conn, playlist_id), old_position)
        return self._snapshot(conn, playlist_id, user_id, is_admin)

    def replace(self, playlist_id, user_id, name, download_ids,
                expected_revision, is_admin=False):
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            user_id, is_admin = _playlist_current_actor(conn, user_id, is_admin)
            result = self._replace(conn, playlist_id, user_id, name, download_ids,
                                   expected_revision, is_admin)
        _publish_metadata_change('playlist')
        return result

    def _add(self, conn, playlist_id, user_id, download_id, is_admin=False):
        if not isinstance(download_id, str) or not download_id:
            raise ValueError('download_id is required')
        self._owned(conn, playlist_id, user_id)
        entry = self._validated_downloads(conn, [download_id], user_id, is_admin)[0]
        existing = conn.execute(
            "SELECT 1 FROM playlist_items WHERE playlist_id = ? AND download_id = ?",
            (playlist_id, download_id),
        ).fetchone()
        if existing is None:
            count = conn.execute(
                "SELECT COUNT(*) FROM playlist_items WHERE playlist_id = ?",
                (playlist_id,),
            ).fetchone()[0]
            if count >= PLAYLIST_MAX_ITEMS:
                raise ValueError(f'A playlist may contain at most {PLAYLIST_MAX_ITEMS} videos')
            now = time.time()
            conn.execute(
                "INSERT INTO playlist_items(playlist_id, download_id, position, added_at) "
                "VALUES (?, ?, ?, ?)", (playlist_id, entry['id'], count, now),
            )
            conn.execute(
                "UPDATE playlists SET revision = revision + 1, content_updated_at = ? WHERE id = ?",
                (now, playlist_id),
            )
        result = self._snapshot(conn, playlist_id, user_id, is_admin)
        result['changed'] = existing is None
        return result

    def add(self, playlist_id, user_id, download_id, is_admin=False):
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            user_id, is_admin = _playlist_current_actor(conn, user_id, is_admin)
            result = self._add(conn, playlist_id, user_id, download_id, is_admin)
        if result['changed']:
            event_bus.publish('change', {
                'reason': 'playlist-add', 'playlist_id': playlist_id,
            }, owner_user_id=user_id)
        return result

    def delete(self, playlist_id, user_id):
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            user_id, _ = _playlist_current_actor(conn, user_id, False)
            self._owned(conn, playlist_id, user_id)
            conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
        event_bus.publish('change', {
            'reason': 'playlist-delete', 'playlist_id': playlist_id,
        }, owner_user_id=user_id)

    def save_progress(self, playlist_id, user_id, download_id, seconds,
                      completed, write_sequence):
        if (isinstance(seconds, bool) or not isinstance(seconds, (int, float))
                or not math.isfinite(seconds) or seconds < 0
                or seconds > PLAYLIST_MAX_POSITION_SECONDS):
            raise ValueError('position_seconds must be a finite nonnegative number')
        if not isinstance(completed, bool):
            raise ValueError('completed must be true or false')
        if (isinstance(write_sequence, bool)
                or not isinstance(write_sequence, int)
                or not 0 <= write_sequence <= PLAYBACK_SESSION_MAX_COORDINATE):
            raise ValueError('write_sequence is outside the allowed range')
        if download_id is not None and (
                not isinstance(download_id, str) or not download_id):
            raise ValueError('download_id must be a string or null')
        if download_id is None and not completed:
            raise ValueError('An incomplete playlist requires a current video')

        changed = False
        with _db_lock, db() as conn:
            self._owned(conn, playlist_id, user_id)
            if download_id is not None:
                member = conn.execute(
                    "SELECT 1 FROM playlist_items "
                    "WHERE playlist_id = ? AND download_id = ?",
                    (playlist_id, download_id),
                ).fetchone()
                if member is None:
                    raise PlaylistRevisionConflict()
            current = self._progress(conn, playlist_id)
            if current is not None and write_sequence < current['write_sequence']:
                return False
            if current is not None and write_sequence == current['write_sequence']:
                same = (
                    current['download_id'] == download_id
                    and math.isclose(current['position_seconds'], float(seconds),
                                     abs_tol=0.001)
                    and current['completed'] == completed
                )
                if not same:
                    raise PlaylistRevisionConflict()
                return False
            conn.execute(
                "INSERT INTO playlist_progress(playlist_id, download_id, "
                "position_seconds, completed, write_sequence, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(playlist_id) DO UPDATE SET "
                "download_id = excluded.download_id, "
                "position_seconds = excluded.position_seconds, "
                "completed = excluded.completed, "
                "write_sequence = excluded.write_sequence, "
                "updated_at = excluded.updated_at",
                (playlist_id, download_id, float(seconds), int(completed),
                 write_sequence, time.time()),
            )
            changed = True
        if changed:
            event_bus.publish('playlist-progress', {
                'reason': 'playlist-progress', 'playlist_id': playlist_id,
            }, owner_user_id=user_id)
        return changed

    def playback_snapshot(self, playlist_id, user_id, restart=False,
                          start_download_id=None, is_admin=False):
        detail = self.get(playlist_id, user_id, is_admin)
        with db() as conn:
            members = self._members(conn, playlist_id)
            snapshot_ids = [row['download_id'] for row in members]
            queue_items = []
            playable = {}
            for row in members:
                entry = dict(row)
                if _playlist_download_playable(entry, user_id, is_admin):
                    playable[row['position']] = entry
                    queue_items.append(_playlist_item(entry, row['position']))
                else:
                    queue_items.append(_playlist_item(None, row['position']))
        if not playable:
            return detail, queue_items, snapshot_ids, None, 0, 0
        progress = detail.get('progress')
        if progress and progress['completed'] and not restart:
            raise PlaylistRevisionConflict('completed')
        if start_download_id is not None:
            start_position = next(
                (position for position, entry in playable.items()
                 if entry['id'] == start_download_id), None
            )
            if start_position is None:
                raise PlaylistRevisionConflict()
            resume_seconds = 0
        elif restart or not progress:
            start_position = min(playable)
            resume_seconds = 0
        else:
            start_position = next(
                (position for position, entry in playable.items()
                 if entry['id'] == progress['download_id']), None
            )
            if start_position is None:
                start_position = min(playable)
                resume_seconds = 0
            else:
                resume_seconds = float(progress['position_seconds'])
                if resume_seconds < 5:
                    resume_seconds = 0
                duration = _finite_positive_number(
                    playable[start_position].get('duration_seconds')
                )
                # Edge skipping uses the browser's duration and clamps resume
                # positions there; the legacy near-end heuristic would skip
                # the item before the player can apply those bounds.
                if (db_get_preferences().get('skip_video_edges') != 'true'
                        and duration is not None
                        and duration - min(duration, resume_seconds)
                        <= max(30, duration * 0.05)):
                    next_positions = [
                        position for position in playable
                        if position > start_position
                    ]
                    if next_positions:
                        start_position = min(next_positions)
                        resume_seconds = 0
                    else:
                        self.save_progress(
                            playlist_id, user_id, progress['download_id'], 0,
                            True, int(progress.get('write_sequence') or 0) + 1,
                        )
                        raise PlaylistRevisionConflict('completed')
        return (detail, queue_items, snapshot_ids, playable[start_position],
                start_position, resume_seconds)


def _playlist_summary(playlist):
    items = playlist['items']
    visible = [item for item in items if item.get('id') is not None]
    playlist.update(
        item_count=len(items), member_ids=[item.get('id') for item in items],
        mosaic_ids=[item['id'] for item in visible[:4]],
        duration_seconds=sum(item.get('duration_seconds') or 0 for item in visible) or None,
    )
    if playlist.get('progress') and playlist['progress'].get('download_id') not in playlist['member_ids']:
        playlist['progress'] = None
    return playlist


def _authorized_playlist_receipt(conn, result, actor):
    """Revalidate cached identities without replacing the attempt's outcome."""
    if result.get('id') is None:
        return result
    if result.get('removed') is True:
        # The actor-scoped receipt records only a removed identity, never its
        # former title or members. A live authenticated actor may recover their
        # own deletion after the target is gone. Reused identities still obey
        # current ownership rather than inheriting the deleted target's rights.
        live = conn.execute('SELECT owner_user_id FROM playlists WHERE id = ?',
                            (result['id'],)).fetchone()
        if live is not None and live['owner_user_id'] != actor['id']:
            raise PlaylistNotFound()
        return result
    playlists._owned(conn, result['id'], actor['id'])
    for position, item in enumerate(result['items']):
        entry = _playlist_download_row(conn, item.get('id'))
        if not _playlist_download_visible(entry, actor['id'], 'admin' in actor['roles']):
            result['items'][position] = _playlist_item(None, item['position'])
    return _playlist_summary(result)


def _execute_playlist_mutation(payload, playlist_id=None, action=None):
    """Atomically authorize, conditionally save and record a canonical receipt."""
    action = action or ('playlist.create' if playlist_id is None else 'playlist.replace')
    creating = action == 'playlist.create'
    method = {'playlist.create': 'POST', 'playlist.replace': 'PUT',
              'playlist.add': 'POST', 'playlist.delete': 'DELETE'}[action]
    allowed_fields = ({'download_id'} if action == 'playlist.add' else set()
                      if action == 'playlist.delete' else {'name', 'download_ids', 'download_id'})
    allowed_fields |= {'expected_revision', 'client_mutation_id'}
    mutation_id = payload.get('client_mutation_id')
    match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
    if match is None:
        return {'error': 'Invalid mutation identifier'}, 400
    # Bind raw submitted fields as well as ordered membership. Unknown options
    # cannot accidentally become unbound semantic inputs in a later adapter.
    fingerprint = hashlib.sha256(json.dumps(
        [method, action, playlist_id, {key: value for key, value in payload.items()
                                     if key != 'client_mutation_id'}],
        sort_keys=True, ensure_ascii=True, separators=(',', ':'),
    ).encode()).hexdigest()
    with _db_lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        actor = _tag_actor(conn)
        if actor is None:
            return {'error': 'Authentication required'}, 401
        is_admin = 'admin' in actor['roles']
        receipt = conn.execute(
            'SELECT fingerprint, status, response FROM mutation_receipts '
            'WHERE actor_id = ? AND mutation_id = ?', (actor['id'], mutation_id),
        ).fetchone()
        if receipt is not None:
            if receipt['fingerprint'] != fingerprint:
                return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
            try:
                result = _authorized_playlist_receipt(conn, json.loads(receipt['response']), actor)
            except PlaylistNotFound:
                return {'error': 'Unknown playlist'}, 404
            return result, receipt['status']
        try:
            state = ({'id': None, 'name': '', 'revision': 0, 'items': [], 'progress': None,
                      'item_count': 0, 'member_ids': [], 'mosaic_ids': [],
                      'duration_seconds': None, 'resume_position': 0} if creating else
                     playlists._snapshot(conn, playlist_id, actor['id'], is_admin, repair=False))
        except PlaylistNotFound:
            return {'error': 'Unknown playlist'}, 404
        if conn.execute("SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ? AND phase != 'done'",
                        (actor['id'], mutation_id)).fetchone():
            return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
        now = time.time()
        _prune_mutation_receipts(conn, now)
        counts = conn.execute(
            'SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent '
            'FROM mutation_receipts WHERE actor_id = ?', (now - 60, actor['id']),
        ).fetchone()
        active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS (SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
        if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
            return {'error': 'Too many mutations; wait before submitting more', 'code': 'mutation_limit'}, 429
        error = None
        field_errors = {}
        status, outcome = (201 if creating else 200), 'committed'
        expected = payload.get('expected_revision')
        created = int(match.group(1)) / 1000
        if created < now - MUTATION_REPLAY_SECONDS or created > now + 300:
            error, status, outcome = 'Mutation identifier expired or clock is incorrect', 400, 'rejected'
        elif set(payload) - allowed_fields:
            error, status, outcome = 'Unsupported playlist option', 400, 'rejected'
        elif creating and expected is not None:
            error, status, outcome = 'Creation does not accept an expected revision', 400, 'rejected'
        elif not creating and (isinstance(expected, bool) or not isinstance(expected, int) or expected < 1):
            error, status, outcome = 'expected_revision must be a positive integer', 400, 'rejected'
        elif not creating and expected != state['revision']:
            error, status, outcome = 'Playlist state changed; review the current version', 409, 'conflicted'
        elif action == 'playlist.delete':
            conn.execute('DELETE FROM playlists WHERE id = ?', (playlist_id,))
            state = {'id': playlist_id, 'removed': True, 'membership_invalidated': True,
                     'revision': state['revision'] + 1}
        elif action == 'playlist.add':
            try:
                state = playlists._add(conn, playlist_id, actor['id'], payload.get('download_id'), is_admin)
            except ValueError as invalid:
                error, field_errors = str(invalid), {'download_id': str(invalid)}
                status, outcome = 400, 'rejected'
        else:
            ids = payload.get('download_ids')
            if ids is None and creating:
                ids = [] if payload.get('download_id') is None else [payload['download_id']]
            try:
                if payload.get('download_ids') is not None and payload.get('download_id') is not None:
                    raise ValueError('Use download_id or download_ids, not both')
                if not creating and payload.get('download_id') is not None:
                    raise ValueError('Use download_ids when replacing a playlist')
                _validated_playlist_name(payload.get('name'))
            except ValueError as invalid:
                error, field_errors = str(invalid), {'name': str(invalid)}
            if error is None:
                try:
                    state = (playlists._create(conn, actor['id'], payload.get('name'), ids, is_admin)
                             if creating else playlists._replace(conn, playlist_id, actor['id'],
                                 payload.get('name'), ids, expected, is_admin))
                except ValueError as invalid:
                    error, field_errors = str(invalid), {'download_ids': str(invalid)}
            if error is not None:
                status, outcome = 400, 'rejected'
        result = dict(state, mutation={'id': mutation_id, 'domain': 'playlist',
                                      'revision': state['revision'], 'outcome': outcome},
                      server_time=int(now * 1000))
        if error:
            result.update(error=error, field_errors=field_errors)
        conn.execute(
            'INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, fingerprint, status, response, recorded_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (actor['id'], mutation_id, result['id'] or 'playlist:create', fingerprint,
             status, json.dumps(result, separators=(',', ':')), now),
        )
    if outcome == 'committed':
        _publish_metadata_change('playlist')
    return result, status


def _execute_legacy_playlist_save(payload, playlist_id=None):
    # Old clients retain the same wire contract and conflict type while sharing
    # the transaction's current actor and member authorization checks.
    with _db_lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        actor = _tag_actor(conn)
        if actor is None:
            return {'error': 'Authentication required'}, 401
        is_admin = 'admin' in actor['roles']
        if playlist_id is None:
            ids = payload.get('download_ids')
            if ids is None:
                ids = [] if payload.get('download_id') is None else [payload['download_id']]
            elif payload.get('download_id') is not None:
                raise ValueError('Use download_id or download_ids, not both')
            result = playlists._create(conn, actor['id'], payload.get('name'), ids, is_admin)
        else:
            result = playlists._replace(conn, playlist_id, actor['id'], payload.get('name'),
                                        payload.get('download_ids'), payload.get('expected_revision'), is_admin)
    _publish_metadata_change('playlist')
    return result, 201 if playlist_id is None else 200


playlists = PlaylistService()


def db_get_preferences():
    with db() as conn:
        rows = conn.execute("SELECT key, value FROM preferences").fetchall()
        return {r["key"]: r["value"] for r in rows}


def _preference_snapshot(conn):
    values = {row['key']: row['value'] for row in conn.execute('SELECT key, value FROM preferences')
              if row['key'] in PREFERENCE_FIELDS}
    revision = conn.execute('SELECT revision FROM preference_state WHERE singleton = 1').fetchone()[0]
    return {'id': 'installation', 'values': values, 'preferences_revision': str(revision)}


def _write_preferences(conn, updates, previous, ids):
    for key, value in updates.items():
        conn.execute(
            'INSERT INTO preferences(key, value) VALUES (?, ?) '
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value', (key, str(value)),
        )
    changed = any(key in updates and str(updates[key]) != previous.get(key)
                  for key in ('library_rotation_enabled', 'library_rotation_hours'))
    if changed:
        enabled = updates.get('library_rotation_enabled', previous.get('library_rotation_enabled')) == 'true'
        if enabled:
            _write_library_rotation(conn, ids, updates.get('library_rotation_hours', previous.get('library_rotation_hours', '24')))
        else:
            conn.execute('DELETE FROM library_rotation_members')
            conn.execute('DELETE FROM library_rotation')


def _reconcile_preference_runtime(restore_rotation=True):
    # Durable desired state drives idempotent controllers. Recovery never
    # regenerates a deck/deadline or creates a download command. Existing queue
    # ownership guards still decide which already-enqueued worker may start.
    with _worker_condition, _rotation_lock:
        with db() as conn:
            conn.execute('BEGIN')
            pending = conn.execute('SELECT revision, runtime_pending FROM preference_state').fetchone()
            if not pending['runtime_pending']:
                return
            values = _preference_snapshot(conn)['values']
            rotation = conn.execute('SELECT expires_at FROM library_rotation').fetchone()
        _bandwidth.configure(values.get('max_total_download_mbps', '0'))
        if restore_rotation:
            if values.get('library_rotation_enabled') == 'true':
                if rotation is not None:
                    _schedule_rotation_timer(rotation['expires_at'])
            else:
                _cancel_rotation_timer()
        _dispatch_worker_queue()
        _worker_condition.notify_all()
        with _db_lock, db() as conn:
            conn.execute('UPDATE preference_state SET runtime_pending = 0 WHERE revision = ?',
                         (pending['revision'],))


def db_set_preferences(updates: dict, request_actor=False):
    with _worker_condition, _rotation_lock:
        previous = db_get_preferences()
        rotation_changed = any(key in updates and str(updates[key]) != previous.get(key)
                               for key in ('library_rotation_enabled', 'library_rotation_hours'))
        enabled = updates.get('library_rotation_enabled', previous.get('library_rotation_enabled')) == 'true'
        ids = _new_rotation_members() if rotation_changed and enabled else None
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if request_actor and _tag_actor(conn) is None:
                return False
            _write_preferences(conn, updates, previous, ids)
        _reconcile_preference_runtime()
        if rotation_changed:
            _publish_metadata_change('library_rotation')
        return True


def _db_user(conn, where, values):
    row = conn.execute(
        "SELECT id, username, name, password_hash, suspended, session_version, "
        f"created_at FROM users WHERE {where}",
        values,
    ).fetchone()
    if row is None:
        return None
    user = dict(row)
    user['suspended'] = bool(user['suspended'])
    user['roles'] = [
        role['name'] for role in conn.execute(
            "SELECT roles.name FROM roles "
            "JOIN user_roles ON user_roles.role_id = roles.id "
            "WHERE user_roles.user_id = ? "
            "ORDER BY roles.name COLLATE NOCASE",
            (user['id'],),
        )
    ]
    return user


def db_get_user_by_id(user_id):
    with db() as conn:
        return _db_user(conn, "id = ?", (user_id,))


def db_get_user_by_username(username):
    with db() as conn:
        return _db_user(conn, "username = ? COLLATE NOCASE", (username,))


def db_get_initial_admin():
    """Return the passwordless bootstrap administrator, if it still exists."""
    with db() as conn:
        row = conn.execute(
            "SELECT users.id FROM users "
            "JOIN user_roles ON user_roles.user_id = users.id "
            "JOIN roles ON roles.id = user_roles.role_id "
            "WHERE roles.name = 'admin' AND users.password_hash IS NULL "
            "ORDER BY users.created_at, users.id LIMIT 1"
        ).fetchone()
        return _db_user(conn, "id = ?", (row['id'],)) if row else None


def db_list_roles():
    with db() as conn:
        return [
            row['name'] for row in conn.execute(
                "SELECT name FROM roles ORDER BY name COLLATE NOCASE"
            )
        ]


def _public_user(user):
    return {
        key: value for key, value in user.items()
        if key != 'password_hash'
    }


def db_list_users():
    with db() as conn:
        ids = [
            row['id'] for row in conn.execute(
                "SELECT id FROM users ORDER BY username COLLATE NOCASE"
            )
        ]
        return [_public_user(_db_user(conn, "id = ?", (user_id,)))
                for user_id in ids]


def _b64url(data):
    return base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')


def _credential_verifier(value):
    key = str(app.secret_key).encode('utf-8')
    return hmac.new(key, value.encode('utf-8'), hashlib.sha256).digest()


def _companion_error(status, code, message):
    response = jsonify({'error': message, 'code': code})
    response.headers['Cache-Control'] = 'no-store'
    return response, status


def _bundled_extension():
    """Return verified package metadata without trusting a mutable artifact."""
    try:
        expected_line = COMPANION_XPI_CHECKSUM_PATH.read_text(
            encoding='ascii'
        ).strip()
        expected, filename = expected_line.split(None, 1)
        filename = filename.lstrip('*')
        if (not re.fullmatch(r'[0-9a-f]{64}', expected)
                or filename != COMPANION_XPI_NAME):
            return None
        package_bytes = COMPANION_XPI_PATH.read_bytes()
        actual = hashlib.sha256(package_bytes).hexdigest()
        with zipfile.ZipFile(io.BytesIO(package_bytes)) as archive:
            archive_names = {name.lower() for name in archive.namelist()}
    except (OSError, ValueError, zipfile.BadZipFile):
        return None
    if not hmac.compare_digest(actual, expected):
        return None
    return {
        'version': COMPANION_PACKAGE_VERSION,
        'url': '/browser-extension/vdl-companion-firefox.xpi',
        'download_url': '/browser-extension/vdl-companion-firefox.xpi?download=1',
        'sha256': actual,
        # Firefox Release refuses unsigned packages. Surface the development
        # artifact honestly instead of leaving a click to fail without useful
        # feedback; AMO-signed XPIs contain this signature trio.
        'signed': {
            'meta-inf/manifest.mf',
            'meta-inf/mozilla.sf',
            'meta-inf/mozilla.rsa',
        }.issubset(archive_names),
    }


def _validated_device_label(value):
    if not isinstance(value, str):
        raise ValueError('Device label is required')
    label = unicodedata.normalize('NFC', value).strip()
    if (not 1 <= len(label) <= 80
            or any(unicodedata.category(char).startswith('C') for char in label)):
        raise ValueError('Device label must contain 1 to 80 visible characters')
    return label


def _validated_extension_version(value):
    if (not isinstance(value, str) or not value or len(value) > 64
            or not re.fullmatch(r'[0-9A-Za-z][0-9A-Za-z.+-]*', value)):
        raise ValueError('Invalid extension version')
    return value


def _companion_protocol_error():
    package = _bundled_extension()
    return jsonify({
        'error': 'Companion update required',
        'code': 'incompatible_protocol',
        'supported_protocols': list(COMPANION_PROTOCOLS),
        'extension_url': (
            package['url'] if package else
            '/browser-extension/vdl-companion-firefox.xpi'
        ),
    }), 426


def _require_companion_protocol():
    raw = request.headers.get('X-VDL-Companion-Protocol')
    if raw != str(COMPANION_PROTOCOL):
        return _companion_protocol_error()
    try:
        _validated_extension_version(
            request.headers.get('X-VDL-Companion-Version')
        )
    except ValueError:
        return _companion_error(
            400, 'invalid_request', 'Invalid companion version header'
        )
    return None


def _read_json_body(limit, *, require_length=False):
    """Enforce route limits before Flask is allowed to decode JSON."""
    if request.mimetype != 'application/json':
        return None, _companion_error(
            415, 'unsupported_media_type', 'Content-Type must be application/json'
        )
    if require_length and request.content_length is None:
        return None, _companion_error(
            400, 'invalid_request', 'Content-Length is required'
        )
    if request.content_length is not None and request.content_length > limit:
        return None, _companion_error(
            413, 'request_too_large', 'Request body is too large'
        )
    raw = request.get_data(cache=True)
    if len(raw) > limit:
        return None, _companion_error(
            413, 'request_too_large', 'Request body is too large'
        )
    try:
        data = json.loads(raw)
    except (TypeError, ValueError, UnicodeDecodeError):
        return None, _companion_error(400, 'invalid_request', 'Invalid JSON request')
    if not isinstance(data, dict):
        return None, _companion_error(400, 'invalid_request', 'A JSON object is required')
    return data, None


def _prune_rate_window(values, now, seconds=60):
    cutoff = now - seconds
    return [timestamp for timestamp in values if timestamp > cutoff]


def _failed_pair_rate_limited(remote_addr):
    now = time.time()
    key = remote_addr or ''
    with _companion_rate_lock:
        global _failed_pair_global
        _failed_pair_global = _prune_rate_window(_failed_pair_global, now)
        values = _prune_rate_window(_failed_pair_rates.get(key, []), now)
        _failed_pair_rates[key] = values
        return len(values) >= 10 or len(_failed_pair_global) >= 60


def _record_failed_pair(remote_addr):
    now = time.time()
    key = remote_addr or ''
    with _companion_rate_lock:
        global _failed_pair_global
        _failed_pair_global = _prune_rate_window(_failed_pair_global, now)
        values = _prune_rate_window(_failed_pair_rates.get(key, []), now)
        values.append(now)
        _failed_pair_rates[key] = values
        _failed_pair_global.append(now)
        # An attacker can vary addresses, so retain only currently live keys.
        if len(_failed_pair_rates) > 1024:
            stale = [item for item, stamps in _failed_pair_rates.items()
                     if not _prune_rate_window(stamps, now)]
            for item in stale[:len(_failed_pair_rates) - 1024]:
                _failed_pair_rates.pop(item, None)
            while len(_failed_pair_rates) > 1024:
                _failed_pair_rates.pop(next(iter(_failed_pair_rates)))


def _token_rate_limited(token_id, request_id):
    now = time.time()
    with _companion_rate_lock:
        values = [
            (seen_id, timestamp)
            for seen_id, timestamp in _token_download_rates.get(token_id, [])
            if timestamp > now - 60
        ]
        if any(seen_id == request_id for seen_id, _timestamp in values):
            _token_download_rates[token_id] = values
            return False
        if len(values) >= 10:
            _token_download_rates[token_id] = values
            return True
        values.append((request_id, now))
        _token_download_rates[token_id] = values
        while len(_token_download_rates) > 4096:
            _token_download_rates.pop(next(iter(_token_download_rates)))
        return False


def _new_pairing_code(user_id, origin):
    now = time.time()
    # Keep the established 16-byte code shape so older companions can still
    # pair. New companions recognize the format byte and creation time, while
    # 88 unpredictable bits remain ample for a five-minute rate-limited code.
    payload = (
        bytes((COMPANION_PAIRING_CODE_FORMAT,))
        + int(now).to_bytes(4, 'big')
        + secrets.token_bytes(11)
    )
    raw = 'VDL1-' + _b64url(payload)
    record = {
        'verifier': _credential_verifier(raw),
        'user_id': user_id,
        'origin': origin,
        'created_at': now,
        'expires_at': now + 300,
    }
    with _pairing_lock:
        _pairing_codes[user_id] = record
    return raw, record['expires_at']


def _consume_pairing_code(code, origin):
    if (not isinstance(code, str)
            or not re.fullmatch(r'VDL1-[A-Za-z0-9_-]{22}', code)):
        return None
    verifier = _credential_verifier(code)
    now = time.time()
    with _pairing_lock:
        matched_user_id = None
        for user_id, record in list(_pairing_codes.items()):
            if record['expires_at'] <= now:
                _pairing_codes.pop(user_id, None)
                continue
            if (record['origin'] == origin
                    and hmac.compare_digest(record['verifier'], verifier)):
                matched_user_id = user_id
        if matched_user_id is None:
            return None
        # Consume before the database write so even a lost/error response can
        # never replay the credential.
        _pairing_codes.pop(matched_user_id, None)
        return matched_user_id


def _new_companion_token(user, device_label, extension_version):
    token_id = _b64url(secrets.token_bytes(16))
    token = f'vdlx_{token_id}.{_b64url(secrets.token_bytes(32))}'
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO extension_tokens("
            "id, user_id, token_verifier, device_label, extension_version, "
            "protocol_version, paired_session_version, created_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                token_id, user['id'], _credential_verifier(token),
                device_label, extension_version, COMPANION_PROTOCOL,
                user['session_version'], time.time(),
            ),
        )
    return token_id, token


def _companion_authenticate():
    header = request.headers.get('Authorization', '')
    match = re.fullmatch(
        r'Bearer (vdlx_([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43})', header
    )
    if match is None:
        return None
    token, token_id = match.groups()
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM extension_tokens WHERE id = ?", (token_id,)
        ).fetchone()
    if row is None or not hmac.compare_digest(
            bytes(row['token_verifier']), _credential_verifier(token)):
        return None
    user = db_get_user_by_id(row['user_id'])
    if (user is None or user['suspended'] or user['password_hash'] is None
            or user['session_version'] != row['paired_session_version']):
        return None

    now = time.time()
    reported_version = request.headers.get('X-VDL-Companion-Version')
    if row['last_used_at'] is None or row['last_used_at'] <= now - 300:
        try:
            version = _validated_extension_version(reported_version)
        except ValueError:
            version = row['extension_version']
        with _db_lock, db() as conn:
            conn.execute(
                "UPDATE extension_tokens SET last_used_at = ?, "
                "extension_version = ? WHERE id = ?",
                (now, version, token_id),
            )
    return {'id': token_id, 'user': user}


def _canonical_page_url(value):
    if (not isinstance(value, str) or len(value.encode('utf-8')) > 8192
            or any(ord(character) < 32 or ord(character) == 127
                   for character in value)):
        raise ValueError('Invalid page URL')
    try:
        parsed = urlsplit(value)
        port = parsed.port
        hostname = parsed.hostname
    except (ValueError, UnicodeError) as exc:
        raise ValueError('Invalid page URL') from exc
    if (parsed.scheme.lower() not in ('http', 'https') or not hostname
            or parsed.username is not None or parsed.password is not None):
        raise ValueError('Invalid page URL')
    try:
        ascii_host = hostname.encode('idna').decode('ascii').lower()
    except UnicodeError as exc:
        raise ValueError('Invalid page URL') from exc
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('Invalid page URL')
    if ':' in ascii_host and not ascii_host.startswith('['):
        display_host = f'[{ascii_host}]'
    else:
        display_host = ascii_host
    default_port = 443 if parsed.scheme.lower() == 'https' else 80
    authority = display_host + (f':{port}' if port and port != default_port else '')
    path = parsed.path or '/'
    return f'{parsed.scheme.lower()}://{authority}{path}' + (
        f'?{parsed.query}' if parsed.query else ''
    )


def _cookie_string(value, field, maximum, *, allow_empty=False, ascii_only=False):
    if not isinstance(value, str) or (not value and not allow_empty):
        raise ValueError(f'Invalid cookie {field}')
    try:
        encoded = value.encode('ascii' if ascii_only else 'utf-8')
    except UnicodeError as exc:
        raise ValueError(f'Invalid cookie {field}') from exc
    if len(encoded) > maximum or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f'Invalid cookie {field}')
    return value


def _domain_matches(hostname, domain, host_only):
    try:
        host_ip = ipaddress.ip_address(hostname)
    except ValueError:
        host_ip = None
    try:
        domain_ip = ipaddress.ip_address(domain)
    except ValueError:
        domain_ip = None
    if host_ip is not None or domain_ip is not None:
        return host_ip is not None and domain_ip is not None and host_ip == domain_ip
    return domain == hostname if host_only else (
        domain == hostname or hostname.endswith('.' + domain)
    )


def _cookie_path_matches(request_path, cookie_path):
    return (
        cookie_path == request_path
        or (
            request_path.startswith(cookie_path)
            and (cookie_path.endswith('/') or request_path[len(cookie_path):].startswith('/'))
        )
    )


def _validated_cookies(value, canonical_url):
    if not isinstance(value, list) or len(value) > 300:
        raise ValueError('Invalid cookies')
    parsed = urlsplit(canonical_url)
    hostname = parsed.hostname
    request_path = parsed.path or '/'
    allowed = {
        'name', 'value', 'domain', 'host_only', 'path', 'secure',
        'http_only', 'expires',
    }
    result = []
    seen = set()
    now = time.time()
    for item in value:
        if not isinstance(item, dict) or set(item) != allowed:
            raise ValueError('Invalid cookie fields')
        name = _cookie_string(item['name'], 'name', 256)
        cookie_value = _cookie_string(
            item['value'], 'value', 16384, allow_empty=True
        )
        raw_domain = _cookie_string(
            item['domain'], 'domain', 253, ascii_only=True
        ).lower()
        domain = raw_domain[1:] if raw_domain.startswith('.') else raw_domain
        path = _cookie_string(item['path'], 'path', 2048)
        if (not domain or domain.startswith('.') or not path.startswith('/')
                or any(character in domain for character in '/\\@[]')):
            raise ValueError('Invalid cookie scope')
        try:
            domain_ip = ipaddress.ip_address(domain)
        except ValueError:
            domain_ip = None
        if domain_ip is None and (
                any(not label or len(label) > 63
                    or label.startswith('-') or label.endswith('-')
                    or not re.fullmatch(r'[a-z0-9-]+', label)
                    for label in domain.rstrip('.').split('.'))
                or domain.endswith('.')):
            raise ValueError('Invalid cookie scope')
        for boolean in ('host_only', 'secure', 'http_only'):
            if not isinstance(item[boolean], bool):
                raise ValueError(f'Invalid cookie {boolean}')
        if not _domain_matches(hostname, domain, item['host_only']):
            raise ValueError('Cookie domain does not match page URL')
        if not _cookie_path_matches(request_path, path):
            raise ValueError('Cookie path does not match page URL')
        if item['secure'] and parsed.scheme != 'https':
            raise ValueError('Secure cookie requires HTTPS')
        expires = item['expires']
        if expires is not None:
            if isinstance(expires, bool) or not isinstance(expires, int):
                raise ValueError('Invalid cookie expiry')
            try:
                time.localtime(expires)
            except (OverflowError, OSError, ValueError) as exc:
                raise ValueError('Invalid cookie expiry') from exc
            if expires <= now:
                raise ValueError('Cookie has expired')
        key = (domain, path, name)
        if key in seen:
            raise ValueError('Duplicate cookie')
        seen.add(key)
        result.append({
            'name': name, 'value': cookie_value, 'domain': domain,
            'host_only': item['host_only'], 'path': path,
            'secure': item['secure'], 'http_only': item['http_only'],
            'expires': expires,
        })
    return result


class RewindingCookieBuffer(io.StringIO):
    """Keep yt-dlp's refreshed cookie jar readable by its next context."""
    def truncate(self, size=None):
        result = super().truncate(0 if size is None else size)
        if size in (None, 0):
            self.seek(0)
        return result


def _cookies_to_netscape(cookies):
    lines = ['# Netscape HTTP Cookie File']
    for cookie in cookies:
        domain = cookie['domain'] if cookie['host_only'] else '.' + cookie['domain']
        if cookie['http_only']:
            domain = '#HttpOnly_' + domain
        lines.append('\t'.join((
            domain,
            'FALSE' if cookie['host_only'] else 'TRUE',
            cookie['path'],
            'TRUE' if cookie['secure'] else 'FALSE',
            str(cookie['expires'] or 0),
            cookie['name'],
            cookie['value'],
        )))
    return RewindingCookieBuffer('\n'.join(lines) + '\n')


def _redact_sensitive_text(value, secrets_to_hide=()):
    text = str(value)
    for secret in secrets_to_hide:
        if secret:
            text = text.replace(secret, '<redacted>')
    text = re.sub(r'(https?://[^\s?#]+)\?[^\s#]*', r'\1?<redacted>', text)
    text = re.sub(r'(https?://[^\s#]+)#[^\s]*', r'\1', text)
    text = re.sub(r'(?i)(authorization\s*[:=]\s*)([^\s,;]+)', r'\1<redacted>', text)
    return text


class _RedactingYtdlpLogger:
    def __init__(self, sensitive_values):
        self._sensitive_values = tuple(sensitive_values)

    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        # DownloadError remains the authoritative user-visible failure; this
        # sink prevents yt-dlp from independently emitting credential text.
        _redact_sensitive_text(message, self._sensitive_values)


def _resolve_companion_download(user, request_id, canonical_url):
    """Resolve idempotency, dedupe, resume, or insert under one transaction."""
    with _db_lock, db() as conn:
        row = conn.execute(
            "SELECT id, url, status, visibility FROM downloads "
            "WHERE owner_user_id = ? AND extension_request_id = ?",
            (user['id'], request_id),
        ).fetchone()
        if row is not None:
            if row['url'] != canonical_url:
                return None, 'conflict', None
            return dict(row), 'existing', None

        row = conn.execute(
            "SELECT id, url, status, visibility FROM downloads "
            "WHERE owner_user_id = ? AND browser_authenticated = 1 "
            "AND url = ? AND status IN ('starting', 'downloading', 'paused') "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (user['id'], canonical_url),
        ).fetchone()
        if row is not None:
            return dict(row), 'already_active', None

        row = conn.execute(
            "SELECT id, url, status, visibility FROM downloads "
            "WHERE owner_user_id = ? AND browser_authenticated = 1 "
            "AND url = ? AND status IN ('cancelled', 'interrupted') "
            "ORDER BY created_at DESC, id DESC LIMIT 1",
            (user['id'], canonical_url),
        ).fetchone()
        if row is not None:
            conn.execute(
                "UPDATE downloads SET status = 'starting', progress = '0%', "
                "finished_at = NULL, extension_request_id = ? WHERE id = ?",
                (request_id, row['id']),
            )
            download_history.record(conn, row['id'], new=True)
            result = dict(row)
            result['status'] = 'starting'
            return result, 'resumed', 'update'

        while True:
            download_id = str(uuid.uuid4())[:8]
            if conn.execute(
                    "SELECT 1 FROM downloads WHERE id = ?", (download_id,)
            ).fetchone() is None:
                break
        conn.execute(
            "INSERT INTO downloads("
            "id, url, status, progress, created_at, owner_user_id, "
            "owner_username, visibility, browser_authenticated, "
            "extension_request_id"
            ") VALUES (?, ?, 'starting', '0%', ?, ?, ?, 'private', 1, ?)",
            (
                download_id, canonical_url, time.time(), user['id'],
                user['username'], request_id,
            ),
        )
        download_history.record(conn, download_id, create=True)
        return {
            'id': download_id, 'url': canonical_url, 'status': 'starting',
            'visibility': 'private',
        }, 'started', 'insert'


def _validated_username(value):
    if not isinstance(value, str):
        raise ValueError('Username is required')
    username = unicodedata.normalize('NFC', value).strip()
    if (not username or len(username) > 64
            or any(ord(character) < 32 for character in username)):
        raise ValueError('Username must be between 1 and 64 visible characters')
    return username


def _validated_user_name(value):
    if not isinstance(value, str):
        raise ValueError('Name is required')
    name = unicodedata.normalize('NFC', value).strip()
    if (not name or len(name) > 128
            or any(ord(character) < 32 for character in name)):
        raise ValueError('Name must be between 1 and 128 visible characters')
    return name


def _validated_password(value):
    if not isinstance(value, str) or len(value) < 8:
        raise ValueError('Password must contain at least 8 characters')
    if len(value) > 1024:
        raise ValueError('Password is too long')
    return value


def _db_role_id(conn, role_name):
    row = conn.execute(
        "SELECT id FROM roles WHERE name = ? COLLATE NOCASE",
        (role_name,),
    ).fetchone()
    if row is None:
        raise ValueError('Unknown role')
    return row['id']


def db_set_initial_admin_password(user_id, password):
    password_hash = generate_password_hash(_validated_password(password))
    with _db_lock, db() as conn:
        cursor = conn.execute(
            "UPDATE users SET password_hash = ?, session_version = session_version + 1 "
            "WHERE id = ? AND password_hash IS NULL",
            (password_hash, user_id),
        )
        if cursor.rowcount != 1:
            return None
        return _db_user(conn, "id = ?", (user_id,))


def db_create_user(username, password, role_name, name=None):
    username = _validated_username(username)
    name = _validated_user_name(username if name is None else name)
    password_hash = generate_password_hash(_validated_password(password))
    with _db_lock, db() as conn:
        role_id = _db_role_id(conn, role_name)
        try:
            cursor = conn.execute(
                "INSERT INTO users(username, name, password_hash, created_at) "
                "VALUES (?, ?, ?, ?)",
                (username, name, password_hash, time.time()),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError('A user with that login name already exists') from exc
        conn.execute(
            "INSERT INTO user_roles(user_id, role_id) VALUES (?, ?)",
            (cursor.lastrowid, role_id),
        )
        return _public_user(_db_user(conn, "id = ?", (cursor.lastrowid,)))


def _db_other_active_admin_exists(conn, user_id):
    return conn.execute(
        "SELECT 1 FROM users "
        "JOIN user_roles ON user_roles.user_id = users.id "
        "JOIN roles ON roles.id = user_roles.role_id "
        "WHERE roles.name = 'admin' AND users.suspended = 0 "
        "AND users.id != ? LIMIT 1",
        (user_id,),
    ).fetchone() is not None


def db_update_user(user_id, *, username=None, name=None, password=None,
                   role_name=None, suspended=None):
    with _db_lock, db() as conn:
        user = _db_user(conn, "id = ?", (user_id,))
        if user is None:
            return None
        if role_name is not None and not isinstance(role_name, str):
            raise ValueError('Unknown role')

        demotes_admin = (
            'admin' in user['roles']
            and role_name is not None
            and role_name.casefold() != 'admin'
        )
        suspends_active_admin = (
            'admin' in user['roles']
            and not user['suspended']
            and suspended is True
        )
        if ((demotes_admin or suspends_active_admin)
                and not _db_other_active_admin_exists(conn, user_id)):
            raise ValueError('At least one active administrator is required')

        # Password derivation can be slow. Complete it before the first write
        # acquires SQLite's writer lock, including combined profile updates.
        password_hash = (generate_password_hash(_validated_password(password))
                         if password is not None else None)
        if username is not None:
            username = _validated_username(username)
            try:
                conn.execute(
                    "UPDATE users SET username = ? WHERE id = ?",
                    (username, user_id),
                )
                # Keep the fallback label current in case this account is
                # removed later and the foreign key becomes NULL.
                conn.execute(
                    "UPDATE downloads SET owner_username = ? "
                    "WHERE owner_user_id = ?",
                    (username, user_id),
                )
            except sqlite3.IntegrityError as exc:
                raise ValueError('A user with that login name already exists') from exc
        if name is not None:
            conn.execute(
                "UPDATE users SET name = ? WHERE id = ?",
                (_validated_user_name(name), user_id),
            )
        if suspended is not None:
            if not isinstance(suspended, bool):
                raise ValueError('Suspended must be true or false')
            conn.execute(
                "UPDATE users SET suspended = ? WHERE id = ?",
                (int(suspended), user_id),
            )
        if password is not None:
            conn.execute(
                "UPDATE users SET password_hash = ?, "
                "session_version = session_version + 1 WHERE id = ?",
                (password_hash, user_id),
            )
        if role_name is not None:
            role_id = _db_role_id(conn, role_name)
            conn.execute("DELETE FROM user_roles WHERE user_id = ?", (user_id,))
            conn.execute(
                "INSERT INTO user_roles(user_id, role_id) VALUES (?, ?)",
                (user_id, role_id),
            )
        updated = _public_user(_db_user(conn, "id = ?", (user_id,)))
    if suspended is True:
        _release_playback_sessions_for_user(user_id)
    return updated


def db_delete_user(user_id):
    with _db_lock, db() as conn:
        user = _db_user(conn, "id = ?", (user_id,))
        if user is None:
            return False
        if ('admin' in user['roles']
                and not _db_other_active_admin_exists(conn, user_id)):
            raise ValueError('At least one active administrator is required')
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    _release_playback_sessions_for_user(user_id)
    return True


# ---------------------------------------------------------------------------
# Download orchestration
# ---------------------------------------------------------------------------

class DownloadCancelled(Exception):
    """Raised from the progress hook to abort an in-flight yt-dlp download."""
    pass


# Cancel and pause flags only need to live in memory: a download is only
# cancellable / pausable while its worker thread is alive in this process.
# Pause is implemented by stalling inside progress_hook -- yt-dlp invokes
# the hook between every chunk written, so spinning here effectively halts
# the underlying HTTP/HLS reader without tearing the connection down.
_cancel_flags = {}
_pause_flags  = {}
_cancel_lock  = threading.Lock()  # guards both maps

# HLS totals are extrapolated from the fragments received so far. Preserve a
# responsive internal average, but only publish it after a material movement;
# otherwise the one-decimal UI still changes on nearly every fragment.
_ESTIMATE_ALPHA = 0.10
_ESTIMATE_RELATIVE_DEADBAND = 0.005
_ESTIMATE_MIN_DEADBAND = 1024 * 1024
_progress_estimates = {}
_progress_estimate_lock = threading.Lock()

# ETA is more stable when treated as a predicted completion timestamp. The
# timestamp can be filtered while its remaining duration still counts down
# naturally between meaningful revisions.
_ETA_ALPHA = 0.10
_ETA_RELATIVE_DEADBAND = 0.05
_ETA_MIN_DEADBAND = 5.0
_ETA_RAW_DEVIATION_RELATIVE = 0.25
_ETA_RAW_DEVIATION_MIN = 30.0
_eta_estimates = {}
_eta_estimate_lock = threading.Lock()


def request_cancel(download_id):
    with _cancel_lock:
        _cancel_flags[download_id] = True
        # A paused download must wake up so the hook sees the cancel
        # flag and raises DownloadCancelled on its next iteration.
        _pause_flags.pop(download_id, None)
    # A queued worker is asleep on the slot condition rather than inside a
    # progress hook, so wake it to observe the cancellation immediately.
    with _worker_condition:
        for job in list(_worker_queue):
            if job['id'] == download_id:
                _worker_queue.remove(job)
                db_update_download(download_id, status='cancelled', finished_at=time.time())
                if job.get('ready'):
                    job['ready'].set()
                clear_cancel(download_id)
                clear_pause(download_id)
        _dispatch_worker_queue()
        _worker_condition.notify_all()
    _bandwidth.wake()


def is_cancel_requested(download_id):
    with _cancel_lock:
        return _cancel_flags.get(download_id, False)


def clear_cancel(download_id):
    with _cancel_lock:
        _cancel_flags.pop(download_id, None)


def request_pause(download_id):
    with _cancel_lock:
        _pause_flags[download_id] = True
    _bandwidth.wake()


def is_pause_requested(download_id):
    with _cancel_lock:
        return _pause_flags.get(download_id, False)


def clear_pause(download_id):
    with _cancel_lock:
        _pause_flags.pop(download_id, None)
    _bandwidth.wake()


def _clear_progress_estimate(download_id):
    with _progress_estimate_lock:
        _progress_estimates.pop(download_id, None)


def _smoothed_estimated_progress(download_id, raw_total, downloaded):
    raw_total = float(raw_total)
    downloaded = float(downloaded or 0)

    with _progress_estimate_lock:
        state = _progress_estimates.get(download_id)
        # A lower byte count identifies a restarted transfer. Its estimate and
        # percentage should not inherit momentum from the previous stream.
        if state is None or downloaded < state['downloaded']:
            smoothed_total = raw_total
            displayed_total = int(round(raw_total))
            percent = (downloaded / displayed_total) * 100
        else:
            smoothed_total = (
                state['smoothed_total']
                + _ESTIMATE_ALPHA * (raw_total - state['smoothed_total'])
            )
            displayed_total = state['displayed_total']
            deadband = max(
                _ESTIMATE_MIN_DEADBAND,
                displayed_total * _ESTIMATE_RELATIVE_DEADBAND,
            )
            if abs(smoothed_total - displayed_total) >= deadband:
                displayed_total = int(round(smoothed_total))

            candidate = (downloaded / displayed_total) * 100
            # Revised estimates must not make completed work appear to undo
            # itself. Falling byte counts reset the state in the branch above.
            percent = max(state['percent'], candidate)

        _progress_estimates[download_id] = {
            'smoothed_total': smoothed_total,
            'displayed_total': displayed_total,
            'downloaded': downloaded,
            'percent': percent,
        }
        return displayed_total, percent


def _clear_eta_estimate(download_id):
    with _eta_estimate_lock:
        _eta_estimates.pop(download_id, None)


def _seed_eta_estimate(download_id, eta):
    if eta is None or eta <= 0:
        return
    now = time.monotonic()
    deadline = now + float(eta)
    with _eta_estimate_lock:
        _eta_estimates[download_id] = {
            'smoothed_deadline': deadline,
            'displayed_deadline': deadline,
            'downloaded': 0.0,
        }


def _shift_eta_estimate(download_id, seconds):
    if seconds <= 0:
        return
    with _eta_estimate_lock:
        state = _eta_estimates.get(download_id)
        if state is not None:
            state['smoothed_deadline'] += seconds
            state['displayed_deadline'] += seconds


def _smoothed_eta(download_id, raw_eta, downloaded):
    now = time.monotonic()
    raw_deadline = now + float(raw_eta)
    downloaded = float(downloaded or 0)

    with _eta_estimate_lock:
        state = _eta_estimates.get(download_id)
        if state is None or downloaded < state['downloaded']:
            smoothed_deadline = raw_deadline
            displayed_deadline = raw_deadline
        else:
            displayed_deadline = state['displayed_deadline']
            displayed_eta = max(0.0, displayed_deadline - now)
            # Startup throughput after Continue can briefly imply days of
            # remaining work. Bound one sample's influence while allowing a
            # sustained slowdown to move the estimate over subsequent hooks.
            raw_deviation = max(
                _ETA_RAW_DEVIATION_MIN,
                displayed_eta * _ETA_RAW_DEVIATION_RELATIVE,
            )
            bounded_deadline = min(
                state['smoothed_deadline'] + raw_deviation,
                max(
                    state['smoothed_deadline'] - raw_deviation,
                    raw_deadline,
                ),
            )
            smoothed_deadline = (
                state['smoothed_deadline']
                + _ETA_ALPHA * (
                    bounded_deadline - state['smoothed_deadline']
                )
            )
            deadband = max(
                _ETA_MIN_DEADBAND,
                displayed_eta * _ETA_RELATIVE_DEADBAND,
            )
            if abs(smoothed_deadline - displayed_deadline) >= deadband:
                displayed_deadline = smoothed_deadline

        _eta_estimates[download_id] = {
            'smoothed_deadline': smoothed_deadline,
            'displayed_deadline': displayed_deadline,
            'downloaded': downloaded,
        }
        return max(0, int(round(displayed_deadline - now)))


def _source_server(url):
    try:
        host = urlsplit(url).hostname
        if not host:
            return 'unknown-source'
        host = host.rstrip('.')
        try:
            return ipaddress.ip_address(host).compressed.lower()
        except ValueError:
            host = host.encode('idna').decode('ascii').lower()
            if (len(host) > 253 or not all(
                    re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                    for label in host.split('.'))):
                return 'unknown-source'
            return host
    except (ValueError, UnicodeError, TypeError, AttributeError):
        return 'unknown-source'


def _dispatch_worker_queue():
    """Called under the scheduler lock; reserve both counts before starting."""
    global _active_worker_count
    prefs = db_get_preferences()

    def limit(key, default):
        try:
            return max(1, int(prefs.get(key, default)))
        except (ValueError, TypeError):
            return default

    total = limit('max_concurrent', 3)
    per_host = limit('max_concurrent_per_host', 2)
    unwinding_hosts = set()
    for job in list(_worker_queue):
        if job not in _worker_queue:
            continue
        if _active_worker_count >= total:
            break
        if job['host'] in unwinding_hosts:
            continue
        # Continue can be accepted after terminal status is published but
        # before the previous worker has closed its files and unwound.
        if (job['id'] in _worker_hosts
                or (not job.get('ready') and job['id'] in _live_worker_ids)):
            unwinding_hosts.add(job['host'])
            continue
        if sum(host == job['host'] for host in _worker_hosts.values()) >= per_host:
            continue
        _worker_queue.remove(job)
        _worker_hosts[job['id']] = job['host']
        _active_worker_count += 1
        if job.get('ready'):
            job['ready'].set()
            continue
        _live_worker_ids.add(job['id'])
        try:
            args = (job['url'], job['id'])
            if job['cookies'] is not None:
                args += (job['cookies'],)
            thread = threading.Thread(target=background_download, args=args, daemon=True)
            thread.start()
        except Exception as exc:
            _live_worker_ids.discard(job['id'])
            _worker_hosts.pop(job['id'], None)
            _active_worker_count -= 1
            db_update_download(job['id'], status='error', progress=str(exc), finished_at=time.time())


def enqueue_download(url, download_id, cookie_bundle=None):
    with _worker_condition:
        if is_cancel_requested(download_id):
            db_update_download(download_id, status='cancelled', finished_at=time.time())
            clear_cancel(download_id)
            clear_pause(download_id)
            return
        db_update_download(download_id, progress='Waiting for a download slot')
        _worker_queue.append({
            'id': download_id, 'url': url, 'host': _source_server(url),
            'cookies': cookie_bundle,
        })
        _dispatch_worker_queue()


def _acquire_worker_slot(download_id, url):
    # Direct callers may run a worker synchronously (CLI/tests). HTTP routes
    # enqueue data instead, so waiting URLs never own blocked worker threads.
    with _worker_condition:
        if download_id in _worker_hosts:
            return True
        if is_cancel_requested(download_id):
            return False
        ready = threading.Event()
        _worker_queue.append({
            'id': download_id, 'host': _source_server(url), 'ready': ready,
        })
        _dispatch_worker_queue()
    ready.wait()
    with _worker_condition:
        return download_id in _worker_hosts


def _release_worker_slot(download_id):
    global _active_worker_count
    with _worker_condition:
        if _worker_hosts.pop(download_id, None) is not None:
            _active_worker_count -= 1
        _dispatch_worker_queue()
        _worker_condition.notify_all()


_bandwidth = SharedBandwidth(
    cancelled=is_cancel_requested, paused=is_pause_requested,
    pause=lambda download_id: progress_hook({'status': None}, download_id),
    cancel_error=DownloadCancelled,
)


def progress_hook(d, download_id):
    # Cancel takes precedence over pause -- if the user hit Stop while paused,
    # we want to abort, not silently sleep forever.
    if is_cancel_requested(download_id):
        raise DownloadCancelled()

    # Honour pause requests by parking the worker thread here. The hook is
    # called between yt-dlp's HTTP read chunks, so this pauses the network
    # transfer without aborting the connection. We keep the row's status
    # at 'paused' for the duration; it flips back to 'downloading' on the
    # very next hook call after the flag clears.
    if is_pause_requested(download_id):
        pause_started = time.monotonic()
        # Mark the row paused once on entry; avoid hammering the DB on
        # every iteration of the wait loop.
        db_update_download(download_id, status='paused', speed=None, eta=None)
        while is_pause_requested(download_id):
            if is_cancel_requested(download_id):
                raise DownloadCancelled()
            time.sleep(0.25)
        # Paused wall time does not represent remaining download work. Move
        # both completion-time baselines forward before using the parked hook.
        _shift_eta_estimate(
            download_id,
            time.monotonic() - pause_started,
        )

    if d['status'] == 'downloading':
        total_bytes = d.get('total_bytes') or 0
        estimated_total = d.get('total_bytes_estimate') or 0
        downloaded = d.get('downloaded_bytes', 0)
        speed = d.get('speed')  # bytes/sec, may be None at the very start
        raw_eta = d.get('eta')  # seconds remaining, may be None
        eta = (
            _smoothed_eta(download_id, raw_eta, downloaded)
            if raw_eta is not None and raw_eta >= 0 else None
        )
        # Capture resolution + title as soon as they're known so the Current
        # tab can show them during the download, not only after completion.
        info = d.get('info_dict') or {}
        height = info.get('height')
        width = info.get('width')
        live_resolution = None
        if height:
            live_resolution = f"{height}p"
        elif width and height:
            live_resolution = f"{width}x{height}"
        live_title = info.get('title') or info.get('fulltitle')
        # Unknown-length streams still have useful live state. Keep percentage
        # calculation conditional without withholding status and metadata.
        progress = 'Downloading'
        filesize = None
        if total_bytes > 0:
            _clear_progress_estimate(download_id)
            percent = (downloaded / total_bytes) * 100
            progress = f"{percent:.1f}%"
            filesize = int(total_bytes)
        elif estimated_total > 0:
            filesize, percent = _smoothed_estimated_progress(
                download_id,
                estimated_total,
                downloaded,
            )
            progress = f"{percent:.1f}%"
        db_update_download(
            download_id,
            status='downloading',
            progress=progress,
            downloaded_bytes=max(0, int(downloaded or 0)),
            total_bytes=int(filesize) if filesize and filesize > 0 else None,
            speed=float(speed) if speed else None,
            eta=eta,
            filesize=filesize,
            resolution=live_resolution,
            title=live_title,
        )
    elif d['status'] == 'finished':
        # 'finished' here applies to one downloaded format, not necessarily
        # the whole job: a separate audio stream and ffmpeg merge may still
        # follow. Keep the row active until background_download has observed
        # the post-processor's final path and re-statted that output.
        info = d.get('info_dict') or {}
        filename = d.get('filename') or info.get('_filename')
        height = info.get('height')
        width = info.get('width')
        # Resolution: prefer height ("720p"), else width x height, else accept
        # only resolution-shaped fallbacks like "720p" / "1920x1080". Avoid
        # generic format_id strings like "video_url" that yt-dlp uses for
        # opaque sources (e.g. some HLS extractors).
        resolution = None
        if height:
            resolution = f"{height}p"
        elif width and height:
            resolution = f"{width}x{height}"
        else:
            for cand in (info.get('format_note'), info.get('resolution')):
                if cand and re.fullmatch(r'\d{3,5}p|\d+x\d+', str(cand)):
                    resolution = str(cand)
                    break
        filesize = info.get('filesize') or d.get('total_bytes')
        estimated_filesize = (
            info.get('filesize_approx') or d.get('total_bytes_estimate')
        )
        if not filesize and estimated_filesize:
            filesize, _percent = _smoothed_estimated_progress(
                download_id,
                estimated_filesize,
                d.get('downloaded_bytes', 0),
            )
        title = info.get('title') or info.get('fulltitle')
        finished_total = (
            int(filesize) if filesize and filesize > 0 else None
        )
        db_update_download(
            download_id,
            status='downloading',
            progress='100%',
            downloaded_bytes=(
                finished_total
                if finished_total is not None
                else max(0, int(d.get('downloaded_bytes') or 0))
            ),
            total_bytes=finished_total,
            filename=filename,
            resolution=resolution,
            filesize=int(filesize) if filesize else None,
            speed=0.0,  # use 0 (not None) so the column is touched and cleared
            eta=0,
            title=title,
        )
        _clear_progress_estimate(download_id)
        _clear_eta_estimate(download_id)


def summarize_formats(info_dict):
    """Reduce yt-dlp's info_dict['formats'] to a compact, JSON-serialisable
    list of descriptors. Only the fields useful for display or future
    fallback-format selection are kept; per-format URLs and cookies are
    intentionally dropped.

    Returns None if no formats are listed (e.g. extractors that yield a
    single direct URL without a format table).
    """
    if not info_dict:
        return None
    raw = info_dict.get('formats') or []
    if not raw:
        return None
    out = []
    for f in raw:
        if not isinstance(f, dict):
            continue
        out.append({
            'format_id':   f.get('format_id'),
            'ext':         f.get('ext'),
            'resolution':  f.get('resolution') or (
                f"{f.get('width')}x{f.get('height')}"
                if f.get('width') and f.get('height') else None
            ),
            'height':      f.get('height'),
            'fps':         f.get('fps'),
            'vcodec':      f.get('vcodec'),
            'acodec':      f.get('acodec'),
            'abr':         f.get('abr'),
            'tbr':         f.get('tbr'),
            'filesize':    f.get('filesize') or f.get('filesize_approx'),
            'format_note': f.get('format_note'),
            'protocol':    f.get('protocol'),
            'format':      f.get('format'),  # human-readable summary line
        })
    return out


def pick_best_format_id(formats_summary):
    """Choose the best concrete format_id from the summarised formats list
    captured by `summarize_formats()`. "Best" means: highest video height;
    ties broken by total bitrate, then fps, then filesize. If there are no
    video formats, we fall back to the audio entry with the highest abr/tbr
    so audio-only sources still work.

    Returns the format_id string, or None if nothing usable was found.
    """
    if not formats_summary:
        return None

    def has_video(f):
        v = f.get('vcodec')
        return bool(v) and v != 'none'

    def has_audio(f):
        a = f.get('acodec')
        return bool(a) and a != 'none'

    def num(v):
        try:
            return float(v) if v is not None else -1
        except (TypeError, ValueError):
            return -1

    video = [f for f in formats_summary if has_video(f) and f.get('format_id')]
    if video:
        video.sort(key=lambda f: (
            num(f.get('height')),
            num(f.get('tbr')),
            num(f.get('fps')),
            num(f.get('filesize')),
        ), reverse=True)
        return video[0].get('format_id')

    audio = [f for f in formats_summary if has_audio(f) and f.get('format_id')]
    if audio:
        audio.sort(key=lambda f: (
            num(f.get('abr')),
            num(f.get('tbr')),
            num(f.get('filesize')),
        ), reverse=True)
        return audio[0].get('format_id')

    return None


def _is_format_unavailable_error(exc):
    """True iff `exc` is a yt-dlp error caused by an unsatisfiable format
    selector. Matches the canonical message yt-dlp prints for that case;
    we deliberately do NOT match generic 'ffmpeg not installed' / network
    errors because retrying with a different format wouldn't help those.
    """
    msg = str(exc) if exc else ''
    return 'Requested format is not available' in msg


def _prepare_download_directory(value):
    """Create and validate a directory before it is persisted or used."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Download directory must not be empty')

    directory = value.strip()
    try:
        os.makedirs(directory, exist_ok=True)
    except (OSError, ValueError) as exc:
        raise ValueError(
            f'Download directory is not usable: {exc}'
        ) from exc
    if not os.path.isdir(directory) or not os.access(
            directory, os.W_OK | os.X_OK):
        raise ValueError('Download directory is not writable')
    return directory


def _validated_custom_filename(value):
    """Return an extension-free bare basename suitable for an output path."""
    if not isinstance(value, str):
        raise ValueError('Filename must be text')
    name = value.strip()
    if not name:
        raise ValueError('Filename must not be empty')
    if ('/' in name or '\\' in name or '\x00' in name
            or name in ('.', '..')):
        raise ValueError('Filename must not contain path separators')

    # The downloaded media decides its extension. Mirroring inline rename
    # avoids names such as video.webm.mp4 when a user supplies a suffix.
    stem, _typed_ext = os.path.splitext(name)
    if not stem:
        raise ValueError('Filename must not be empty')
    return stem


def _persist_worker_outcome(download_id, **changes):
    # Keep ownership until the outcome is durable. A one-shot fallback write
    # can hit the same busy database and strand an active row without a worker.
    while True:
        try:
            return db_update_download(download_id, **changes)
        except sqlite3.OperationalError as exc:
            if not _is_database_busy(exc):
                raise
            time.sleep(0.25)


DOWNLOAD_SOCKET_TIMEOUT = 15
DOWNLOAD_NETWORK_RETRIES = 2


@contextmanager
def _guard_download_network(ydl, download_id):
    if not hasattr(ydl, 'urlopen'):
        yield
        return
    original_urlopen = ydl.urlopen
    responses = set()

    def check_cancel():
        if is_cancel_requested(download_id):
            raise DownloadCancelled()

    def urlopen(*args, **kwargs):
        check_cancel()
        try:
            response = original_urlopen(*args, **kwargs)
        except Exception:
            check_cancel()
            raise
        if is_cancel_requested(download_id):
            response.close()
            raise DownloadCancelled()
        responses.add(response)
        original_read = response.read
        original_close = response.close

        def close():
            try:
                return original_close()
            finally:
                # Long fragmented downloads must not retain every completed
                # response until the entire video finishes.
                responses.discard(response)

        def read(*args, **kwargs):
            check_cancel()
            try:
                data = original_read(*args, **kwargs)
            except Exception:
                check_cancel()
                raise
            check_cancel()
            return data

        # Preserve the transport response's type and other methods. Extraction
        # and media reads both need cancellation, even with no bandwidth cap.
        response.read = read
        response.close = close
        return response

    ydl.urlopen = urlopen
    try:
        yield
    finally:
        # Generic extraction can return a direct media URL without consuming
        # its response body. Close every response before releasing ownership.
        for response in list(responses):
            response.close()
        ydl.urlopen = original_urlopen


def background_download(url, download_id, cookie_bundle=None):
    with _worker_condition:
        _live_worker_ids.add(download_id)
    try:
        if not _acquire_worker_slot(download_id, url):
            _persist_worker_outcome(
                download_id, status='cancelled', finished_at=time.time(),
                output_dir=os.path.abspath(db_get_preferences().get('download_dir', '.')),
            )
            return
        db_update_download(download_id, progress='Preparing download')
        return _background_download(url, download_id, cookie_bundle)
    except Exception as exc:
        sensitive_values = tuple(
            secret
            for cookie in (cookie_bundle or ()) if isinstance(cookie, dict)
            for secret in (cookie.get('name', ''), cookie.get('value', ''))
            if secret
        )
        diagnostic = _redact_sensitive_text(exc, sensitive_values)
        app.logger.error('Download worker %s failed: %s', download_id, diagnostic)
        _persist_worker_outcome(
            download_id, status='error', progress=diagnostic,
            finished_at=time.time(),
        )
    finally:
        with _worker_condition:
            # Legacy Continue can queue a newer attempt before this worker
            # unwinds. Its newly accepted controls belong to that successor.
            if not any(job['id'] == download_id and not job.get('ready') for job in _worker_queue):
                clear_cancel(download_id)
                clear_pause(download_id)
        _clear_progress_estimate(download_id)
        _clear_eta_estimate(download_id)
        # Fragment downloaders can retain their locked destination stream in a
        # progress-hook reference cycle when cancellation skips normal cleanup.
        # Finalize those unreachable objects before Remove may unlink the file.
        try:
            _release_worker_slot(download_id)
        finally:
            gc.collect()
            with _worker_condition:
                _live_worker_ids.discard(download_id)
                _dispatch_worker_queue()
                _worker_condition.notify_all()
            # Terminal outcomes publish before file handles close; reconcile
            # once more when Retry can safely own the work item.
            event_bus.publish('change', {'reason': 'worker-stopped', 'id': download_id})


def _background_download(url, download_id, cookie_bundle=None):
    sensitive_values = tuple(
        secret
        for cookie in (cookie_bundle or ()) if isinstance(cookie, dict)
        for secret in (cookie.get('name', ''), cookie.get('value', ''))
        if secret
    )
    cookie_buffer = None
    try:
        prefs = db_get_preferences()
        output_dir = prefs.get("download_dir", ".")
        output_dir = _prepare_download_directory(output_dir)
        db_update_download(download_id, output_dir=os.path.abspath(output_dir))

        # Check if there's a format override from quality selection; otherwise use preference
        entry = db_get_download(download_id)
        fmt = (entry.get('requested_format') if entry else None) or prefs.get("format", "best")
        requested_filename = entry.get('requested_filename') if entry else None
        audio_only = fmt == 'bestaudio/best'

        # Progress hooks report the paths of individual downloaded formats. The
        # post-processor hook is the first authoritative source for the merged or
        # remuxed output path, so retain its last completed path until yt-dlp has
        # returned and the file is safe to expose through History.
        postprocessed_paths = []

        def capture_postprocessed_path(payload):
            if payload.get('status') != 'finished':
                return
            info = payload.get('info_dict') or {}
            path = info.get('filepath') or info.get('_filename')
            if path:
                postprocessed_paths.append(path)

        def build_opts(format_selector):
            if requested_filename:
                # Retain the random row ID until the download is complete so
                # cancellation cleanup can identify every partial owned by it.
                # Percent signs are literals here, not yt-dlp placeholders.
                template_stem = requested_filename.replace('%', '%%')
            else:
                template_stem = '%(title)s'
            options = {
                'format': format_selector,
                'outtmpl': os.path.join(
                    output_dir, f'{template_stem}_{download_id}.%(ext)s'
                ),
                'progress_hooks': [lambda d: progress_hook(d, download_id)],
                'postprocessor_hooks': [capture_postprocessed_path],
                'quiet': True,
                'noprogress': True,
                # continuedl is default-True in yt-dlp, but make it explicit so a
                # resumed download picks up the existing .part file rather than
                # restarting from byte zero.
                'continuedl': True,
            }
            if audio_only:
                # `best` may be a combined video when no separate audio format is
                # available. Preserve the user's output intent across that yt-dlp
                # fallback, including any later retry with a concrete format ID.
                options['postprocessors'] = [
                    {'key': 'FFmpegExtractAudio', 'preferredcodec': 'm4a'},
                ]
            return with_cookie_options(options)

        def with_cookie_options(options):
            # Add the live secret only after the deployment helper's deep copy.
            merged = yt_dlp_options(options)
            # Bound a silent socket wait and keep retries finite. Cancellation
            # is checked before the next request, so Stop never starts a retry.
            merged.update(
                socket_timeout=DOWNLOAD_SOCKET_TIMEOUT,
                retries=DOWNLOAD_NETWORK_RETRIES,
                extractor_retries=DOWNLOAD_NETWORK_RETRIES,
                fragment_retries=DOWNLOAD_NETWORK_RETRIES,
            )
            if cookie_buffer is not None:
                cookie_buffer.seek(0)
                merged['cookiefile'] = cookie_buffer
                merged['logger'] = _RedactingYtdlpLogger(sensitive_values)
            return merged

        # Persist the yt-dlp format selector that we're about to use, so the
        # History tab can show *what was asked for* whenever a download fails
        # with 'Requested format is not available'. Saved up-front (not only
        # on success) so it sticks even if the probe phase below blows up.
        db_update_download(download_id, requested_format=fmt)

        formats_summary = None  # captured during the probe phase, used as
                                # the fallback source if the first attempt fails.

        if cookie_bundle is not None:
            cookie_buffer = _cookies_to_netscape(cookie_bundle)
            cookie_bundle = None

        # A Continue action starts a new worker, so its in-memory filter is gone.
        # The last persisted ETA is a much safer baseline than yt-dlp's first
        # throughput sample while the resumed connection is still warming up.
        if entry:
            _seed_eta_estimate(download_id, entry.get('eta'))

        # ---- Probe phase --------------------------------------------------
        # Run extract_info(download=False) up front so the available format
        # table is captured *before* yt-dlp tries to honour the user's
        # 'format' selector. If the selector is unsatisfiable, the download
        # phase below will raise "Requested format is not available" -- but
        # by then the row already carries the alternatives, so the UI can
        # show them in the error block AND we can pick a working format and
        # retry automatically.
        #
        # extract_info() also yields a clean title/resolution we can persist
        # immediately, which means freshly-queued items show useful metadata
        # in the Current tab even before the first byte arrives.
        if is_cancel_requested(download_id):
            raise DownloadCancelled()
        db_update_download(download_id, progress='Reading source information')
        try:
            probe_opts = with_cookie_options({
                'quiet': True,
                'noprogress': True,
                'skip_download': True,
                'progress_hooks': [lambda d: progress_hook(d, download_id)],
            })
            with yt_dlp.YoutubeDL(probe_opts) as probe, _guard_download_network(probe, download_id):
                info = probe.extract_info(url, download=False)
            formats_summary = summarize_formats(info)
            updates = {}
            if formats_summary is not None:
                updates['formats'] = json.dumps(formats_summary)
            probe_title = info.get('title') if info else None
            if probe_title:
                updates['title'] = probe_title
            if updates:
                db_update_download(download_id, **updates)
        except DownloadCancelled:
            raise
        except Exception:
            # Probe failures are non-fatal; the download phase will surface
            # the real error (geo block, private video, network, etc.).
            pass

        # ---- Download phase ----------------------------------------------
        # First attempt with the user's configured format selector.
        if is_cancel_requested(download_id):
            raise DownloadCancelled()
        db_update_download(download_id, progress='Waiting for media')
        try:
            with yt_dlp.YoutubeDL(build_opts(fmt)) as ydl, _guard_download_network(ydl, download_id):
                govern_download(ydl, _bandwidth, download_id)
                ydl.download([url])
        except yt_dlp.utils.DownloadError as e:
            # Auto-fallback only for yt-dlp's canonical unavailable-format
            # condition. Diagnostic suggestions can accompany unrelated
            # failures that must surface without changing the user's request.
            if (is_cancel_requested(download_id)
                    or not _is_format_unavailable_error(e)
                    or not formats_summary):
                raise
            best_id = pick_best_format_id(formats_summary)
            if not best_id or best_id == fmt:
                # Nothing better to try -- surface the original error.
                raise
            db_update_download(download_id, requested_format=best_id)
            with yt_dlp.YoutubeDL(build_opts(best_id)) as ydl, _guard_download_network(ydl, download_id):
                govern_download(ydl, _bandwidth, download_id)
                ydl.download([url])
        # Re-stat the final file (post-processing may have changed it,
        # e.g. ffmpeg merging .f137 + .f140 into a single .mp4).
        entry = db_get_download(download_id)
        if entry:
            final_path = (
                postprocessed_paths[-1]
                if postprocessed_paths else entry.get('filename')
            )
            # If extension changed during merge (e.g. .webm -> .mp4),
            # try the prefix-matched candidate.
            if final_path and not os.path.exists(final_path):
                base, _ = os.path.splitext(final_path)
                for ext in ('.mp4', '.mkv', '.webm', '.m4a'):
                    cand = base + ext
                    if os.path.exists(cand):
                        final_path = cand
                        break
            if final_path and os.path.exists(final_path):
                if requested_filename:
                    _, final_ext = os.path.splitext(final_path)
                    requested_path = os.path.join(
                        output_dir, requested_filename + final_ext
                    )
                    if os.path.realpath(requested_path) != os.path.realpath(final_path):
                        if os.path.lexists(requested_path):
                            raise FileExistsError(
                                f'A file named {os.path.basename(requested_path)} '
                                'already exists'
                            )
                        os.rename(final_path, requested_path)
                        final_path = requested_path
                # Probe the merged file with ffprobe for the authoritative
                # resolution. yt-dlp's progress hook reports the per-stream
                # resolution, which is None for the audio half of a merged
                # download — leaving the resolution column unset for some
                # extractors. ffprobe always reflects the final container.
                final_res = ffprobe_resolution(final_path)
                final_duration = _consume_media_probe(final_path, final_res)
                _persist_worker_outcome(
                    download_id,
                    status='finished',
                    progress='100%',
                    filename=final_path,
                    filesize=os.path.getsize(final_path),
                    resolution=final_res,
                    duration_seconds=final_duration,
                    media_metadata_probed=True,
                    speed=0.0,
                    eta=0,
                    finished_at=time.time(),
                )
            else:
                raise FileNotFoundError(
                    'Download completed but the final output file is missing'
                )
    except DownloadCancelled:
        _persist_worker_outcome(download_id, status='cancelled', finished_at=time.time())
    except yt_dlp.utils.DownloadError as e:
        if is_cancel_requested(download_id):
            _persist_worker_outcome(download_id, status='cancelled', finished_at=time.time())
        else:
            _persist_worker_outcome(
                download_id, status='error',
                progress=_redact_sensitive_text(e, sensitive_values),
                finished_at=time.time(),
            )
    except Exception as e:
        _persist_worker_outcome(
            download_id, status='error',
            progress=_redact_sensitive_text(e, sensitive_values),
            finished_at=time.time(),
        )
    finally:
        if cookie_buffer is not None:
            cookie_buffer.close()


def _finite_positive_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def ffprobe_media_metadata(path, *, timeout=10, require_video=False):
    """Return final-container resolution and duration from one ffprobe run."""
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=height,duration:format=duration',
                '-of', 'json', path,
            ],
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError as exc:
        if require_video:
            raise RuntimeError(
                'ffprobe is required to validate uploaded videos'
            ) from exc
        return None, None
    except subprocess.TimeoutExpired as exc:
        if require_video:
            raise ValueError('The uploaded video could not be inspected') from exc
        return None, None
    except OSError as exc:
        if require_video:
            raise RuntimeError(
                f'Unable to inspect the uploaded video: {exc}'
            ) from exc
        return None, None

    try:
        payload = json.loads(result.stdout or '{}')
        streams = payload.get('streams') or []
        container = payload.get('format') or {}
    except (AttributeError, json.JSONDecodeError) as exc:
        if require_video:
            raise ValueError('The uploaded file is not a supported video') from exc
        return None, None
    if result.returncode != 0 or not streams:
        if require_video:
            raise ValueError('The uploaded file does not contain a video stream')
        return None, None

    height = _finite_positive_number(streams[0].get('height'))
    duration = _finite_positive_number(container.get('duration'))
    if duration is None:
        duration = _finite_positive_number(streams[0].get('duration'))
    resolution = f'{int(height)}p' if height is not None else None
    return resolution, duration


def _cache_media_probe(path, resolution, duration):
    with _media_probe_cache_lock:
        _media_probe_cache[os.path.realpath(path)] = (resolution, duration)


def _consume_media_probe(path, resolution):
    with _media_probe_cache_lock:
        cached = _media_probe_cache.pop(os.path.realpath(path), None)
    if cached is None or cached[0] != resolution:
        return None
    return cached[1]


def ffprobe_resolution(path):
    """Return e.g. '1080p' for the first video stream in `path`, or None."""
    resolution, duration = ffprobe_media_metadata(path)
    _cache_media_probe(path, resolution, duration)
    return resolution


def inspect_uploaded_video(path):
    """Validate an upload with ffprobe and return its optional resolution."""
    resolution, duration = ffprobe_media_metadata(
        path, timeout=30, require_video=True
    )
    _cache_media_probe(path, resolution, duration)
    return resolution


def _validated_upload_filename(value):
    """Return a safe basename while preserving the desktop filename."""
    if not isinstance(value, str):
        raise ValueError('Uploaded file must have a filename')
    # Some clients still submit a browser-era C:\\fakepath prefix. Treat both
    # separator styles as untrusted path components and retain only the leaf.
    name = unicodedata.normalize(
        'NFC', value.replace('\\', '/').rsplit('/', 1)[-1]
    ).strip()
    if (not name or name in ('.', '..') or '\x00' in name
            or any(ord(character) < 32 for character in name)):
        raise ValueError('Uploaded file must have a valid filename')
    # Leave enough bytes for a collision suffix on filesystems with the usual
    # 255-byte component limit instead of failing late after a large transfer.
    if len(os.fsencode(name)) > 240:
        raise ValueError('Uploaded filename is too long')
    return name


def _validated_mounted_filename(value):
    """Keep the complete safe source basename; storage gets its own suffix."""
    if not isinstance(value, str):
        raise ValueError('Mounted file must have a filename')
    name = value
    if (not name or name in ('.', '..') or '/' in name or '\\' in name
            or '\x00' in name
            or any(ord(character) < 32 for character in name)):
        raise ValueError('Mounted file must have a valid filename')
    return name


def _reserve_upload_path(directory, filename):
    """Atomically reserve a collision-safe destination in the library."""
    stem, extension = os.path.splitext(filename)
    for suffix in range(10000):
        candidate_name = (
            filename if suffix == 0 else f'{stem} ({suffix}){extension}'
        )
        candidate = os.path.join(directory, candidate_name)
        try:
            descriptor = os.open(
                candidate,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
        except FileExistsError:
            continue
        os.close(descriptor)
        return candidate
    raise OSError('Unable to choose an unused filename for the upload')


def _reserve_mounted_path(directory, filename):
    """Reserve a new opaque library basename without replacing any file."""
    stem, extension = os.path.splitext(filename)
    limit = os.pathconf(directory, 'PC_NAME_MAX')
    available = limit - len(os.fsencode(extension)) - len('--') - 12
    if available < 1:
        raise ValueError('Mounted filename extension is too long')
    while len(os.fsencode(stem)) > available:
        stem = stem[:-1]
    for _attempt in range(10000):
        candidate = os.path.join(
            directory, f'{stem}--{uuid.uuid4().hex[:12]}{extension}'
        )
        try:
            descriptor = os.open(
                candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
        except FileExistsError:
            continue
        os.close(descriptor)
        return candidate
    raise OSError('Unable to choose an unused filename for the import')


def _file_identity(metadata):
    return (
        int(metadata.st_dev), int(metadata.st_ino),
        int(metadata.st_size), int(metadata.st_mtime_ns),
    )


def _hash_final_file(path, allowed_bases=None):
    """Read one allowed regular artifact in bounded chunks and detect races."""
    if not _is_allowed_download_path(path, allowed_bases):
        raise PermissionError('Media path is outside the library')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, 'rb') as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('Media path is not a regular file')
        digest = hashlib.sha256()
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
        identity = _file_identity(before)
        if (_file_identity(os.fstat(source.fileno())) != identity
                or _file_identity(os.stat(path, follow_symlinks=False)) != identity
                or not _is_allowed_download_path(path, allowed_bases)):
            raise OSError('Media changed while hashing')
    return digest.hexdigest(), identity


def _current_file_identity(path, allowed_bases=None):
    if not path or not _is_allowed_download_path(path, allowed_bases):
        return None
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    if not stat.S_ISREG(metadata.st_mode):
        return None
    return _file_identity(metadata)


class IngestSourceChanged(Exception):
    """A captured source no longer matches its startup snapshot."""


def _log_ingest_event(event, download_id='-', counts=None):
    # Correlate database timings without repeating source paths or exception
    # messages, which may contain private metadata or signed URLs.
    print(
        f'VDL ingest: timestamp={time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} '
        f'thread={threading.get_ident()} event={event} download_id={download_id}'
        + (f' counts={counts}' if counts is not None else ''),
        flush=True,
    )


def _ingest_signature(metadata):
    return (
        int(metadata.st_dev),
        int(metadata.st_ino),
        int(metadata.st_size),
        int(metadata.st_mtime_ns),
    )


def _source_signature(path):
    try:
        metadata = os.stat(path, follow_symlinks=False)
    except (FileNotFoundError, OSError) as exc:
        raise IngestSourceChanged() from exc
    if not stat.S_ISREG(metadata.st_mode):
        raise IngestSourceChanged()
    return _ingest_signature(metadata)


def _disjoint_ingest_and_output(ingest_root, output_dir):
    ingest_root = os.path.realpath(ingest_root)
    output_dir = os.path.realpath(output_dir)
    if os.path.commonpath((ingest_root, output_dir)) in (ingest_root, output_dir):
        raise ValueError(
            'The ingest folder and download directory must be different directory trees'
        )


def _ingest_relative_components(ingest_root, source_path, relative_path):
    """Reject lexical escapes before walking any source path components."""
    root = os.path.realpath(os.path.abspath(ingest_root))
    source_path = os.path.abspath(source_path)
    if (not relative_path or os.path.isabs(relative_path)
            or any(part in ('', '.', '..') for part in relative_path.split(os.sep))
            or os.path.join(root, relative_path) != source_path):
        raise IngestSourceChanged('Source path escaped the ingest mount')
    return root, relative_path.split(os.sep)


def _verified_ingest_signature(ingest_root, source_path, relative_path):
    root, components = _ingest_relative_components(
        ingest_root, source_path, relative_path
    )
    current = root
    try:
        for component in components[:-1]:
            current = os.path.join(current, component)
            if not stat.S_ISDIR(os.stat(current, follow_symlinks=False).st_mode):
                raise IngestSourceChanged('Source directory changed or became a symlink')
        return _source_signature(source_path)
    except OSError as exc:
        raise IngestSourceChanged('Source path changed after enumeration') from exc


def _open_ingest_source(ingest_root, source_path, relative_path):
    root, components = _ingest_relative_components(
        ingest_root, source_path, relative_path
    )
    descriptor = None
    try:
        descriptor = _open_ingest_directory(root, os.path.dirname(relative_path))
        return os.open(
            components[-1], os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0),
            dir_fd=descriptor,
        )
    except OSError as exc:
        raise IngestSourceChanged('Source path changed after enumeration') from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _open_ingest_directory(root, relative_path):
    """Walk from the configured root with no-follow directory descriptors."""
    descriptor = None
    flags = (os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
             | getattr(os, 'O_NOFOLLOW', 0))
    try:
        descriptor = os.open(root, flags)
        for component in relative_path.split(os.sep) if relative_path else ():
            if component in ('', '.', '..'):
                raise ValueError('Invalid ingest directory component')
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        raise


def _ingest_watched_file(source_path, expected_signature, *,
                         ingest_root=None, relative_path=None):
    """Copy one captured inbox file into the library without publishing early."""
    source_path = os.path.abspath(source_path)
    if ingest_root is None:
        ingest_root = os.path.dirname(source_path)
    if relative_path is None:
        relative_path = os.path.relpath(source_path, ingest_root)
    _verified_ingest_signature(ingest_root, source_path, relative_path)
    original_name = _validated_mounted_filename(os.path.basename(source_path))
    folder_tags = []
    seen_tags = set()
    for component in relative_path.split(os.sep)[:-1]:
        display, identity = _validated_tag_name(component)
        if identity not in seen_tags:
            folder_tags.append(display)
            seen_tags.add(identity)
    download_id = str(uuid.uuid4())[:8]
    title = os.path.splitext(original_name)[0] or original_name
    temporary_path = None
    final_path = None
    registered = False
    received = 0
    digest = hashlib.sha256()
    descriptor = None
    with _db_lock, db() as conn:
        download_history.start_mounted(conn, download_id, original_name)
    _log_ingest_event('attempt-start', download_id)
    event_bus.publish('change', {'reason': 'import-start', 'id': download_id})
    try:
        output_dir = os.path.abspath(_prepare_download_directory(
            db_get_preferences().get('download_dir', '.')
        ))
        _disjoint_ingest_and_output(ingest_root, output_dir)
        descriptor = _open_ingest_source(
            ingest_root, source_path, relative_path
        )
        with os.fdopen(descriptor, 'rb') as source:
            descriptor = None
            source_metadata = os.fstat(source.fileno())
            if (not stat.S_ISREG(source_metadata.st_mode)
                    or _ingest_signature(source_metadata) != expected_signature):
                raise IngestSourceChanged()
            with tempfile.NamedTemporaryFile(
                    mode='wb', dir=output_dir,
                    prefix=f'.vdl_{download_id}.', suffix='.ingest.part',
                    delete=False) as temporary:
                temporary_path = temporary.name
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    temporary.write(chunk)
                    digest.update(chunk)
                    received += len(chunk)
                temporary.flush()
            if (received != expected_signature[2]
                    or _ingest_signature(os.fstat(source.fileno()))
                    != expected_signature):
                raise IngestSourceChanged()
            if (_verified_ingest_signature(
                    ingest_root, source_path, relative_path) != expected_signature):
                raise IngestSourceChanged()
            resolution = inspect_uploaded_video(temporary_path)
            duration_seconds = _consume_media_probe(temporary_path, resolution)
            # A writer can resume while ffprobe runs, even after copy completes.
            if (_ingest_signature(os.fstat(source.fileno()))
                    != expected_signature
                    or _verified_ingest_signature(
                        ingest_root, source_path, relative_path)
                    != expected_signature):
                raise IngestSourceChanged()

        copy_identity = _file_identity(os.stat(temporary_path))
        if copy_identity[2] != received:
            raise IngestSourceChanged()

        with _upload_lock:
            final_path = _reserve_mounted_path(output_dir, original_name)
            os.replace(temporary_path, final_path)
            temporary_path = None

        if _current_file_identity(final_path) != copy_identity:
            raise IngestSourceChanged()

        db_insert_ingested_video(
            download_id,
            source_path,
            expected_signature,
            original_name,
            title,
            received,
            output_dir,
            final_path,
            resolution,
            duration_seconds,
            content_hash=(digest.hexdigest(), copy_identity),
            folder_tags=folder_tags,
        )
        registered = True
        _log_ingest_event('published', download_id)
        print(
            f'VDL ingest: added {original_name!r} as {download_id}',
            flush=True,
        )
        return download_id
    except Exception as exc:
        _log_ingest_event('attempt-failed', download_id)
        with _db_lock, db() as conn:
            download_history.fail_mounted(conn, download_id, exc)
        event_bus.publish('change', {'reason': 'import-error', 'id': download_id})
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)
        for path in (
                temporary_path,
                final_path if final_path and not registered else None):
            if not path:
                continue
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            except OSError:
                pass


_INGEST_TEMP_SUFFIXES = (
    '.part', '.partial', '.tmp', '.crdownload', '.download',
)


def _eligible_ingest_name(name):
    return not name.startswith('.') and not name.lower().endswith(
        _INGEST_TEMP_SUFFIXES
    )


def _snapshot_ingest_files(directory):
    """Finish a single recursive walk before any copied file is processed."""
    root = os.path.realpath(os.path.abspath(directory))
    pending = ['']
    visited = set()
    snapshot = []
    while pending:
        relative_dir = pending.pop()
        descriptor = _open_ingest_directory(root, relative_dir)
        try:
            metadata = os.fstat(descriptor)
            identity = (metadata.st_dev, metadata.st_ino)
            if identity in visited:
                continue
            visited.add(identity)
            with os.scandir(descriptor) as entries:
                for entry in entries:
                    if entry.name.startswith('.'):
                        continue
                    metadata = entry.stat(follow_symlinks=False)
                    relative = os.path.join(relative_dir, entry.name)
                    if stat.S_ISDIR(metadata.st_mode):
                        pending.append(relative)
                    elif (stat.S_ISREG(metadata.st_mode)
                          and _eligible_ingest_name(entry.name)):
                        snapshot.append((
                            os.path.join(root, relative),
                            relative,
                            _ingest_signature(metadata),
                        ))
        finally:
            os.close(descriptor)
    snapshot.sort(key=lambda item: item[1])
    return snapshot


class IngestStartupImporter:
    """Process one immutable startup snapshot, then exit."""

    def __init__(self, directory):
        self.directory = os.path.realpath(os.path.abspath(directory))

    def run(self, stop_event):
        counts = {
            'enumerated': 0, 'imported': 0, 'receipt-skipped': 0,
            'changed/missing': 0, 'failed': 0,
        }
        _log_ingest_event('batch-start')
        print(f'VDL ingest: startup scan beginning {self.directory!r}', flush=True)
        try:
            snapshot = _snapshot_ingest_files(self.directory)
        except OSError as exc:
            _log_ingest_event('batch-failed', counts=counts)
            print(f'VDL ingest: unable to scan {self.directory!r}: {exc}', flush=True)
            print(f'VDL ingest: startup scan failed; {counts}', flush=True)
            return

        counts['enumerated'] = len(snapshot)
        visible_paths = {path for path, _relative, _signature in snapshot}
        try:
            db_prune_ingest_receipts(self.directory, visible_paths)
            receipts = db_get_ingest_receipts(self.directory)
        except Exception as exc:
            _log_ingest_event('batch-failed', counts=counts)
            print(f'VDL ingest: receipt reconciliation failed: {exc}', flush=True)
            print(f'VDL ingest: startup scan failed; {counts}', flush=True)
            return

        for source_path, relative_path, expected_signature in snapshot:
            if stop_event.is_set():
                break
            try:
                if (_verified_ingest_signature(
                        self.directory, source_path, relative_path)
                        != expected_signature):
                    raise IngestSourceChanged('Source changed after enumeration')
            except IngestSourceChanged as exc:
                counts['changed/missing'] += 1
                print(f'VDL ingest: skipped {relative_path!r}: {exc}', flush=True)
                continue
            if receipts.get(source_path) == expected_signature:
                counts['receipt-skipped'] += 1
                continue
            try:
                _ingest_watched_file(
                    source_path, expected_signature,
                    ingest_root=self.directory, relative_path=relative_path,
                )
            except IngestSourceChanged as exc:
                counts['changed/missing'] += 1
                print(f'VDL ingest: skipped {relative_path!r}: {exc}', flush=True)
            except Exception as exc:
                counts['failed'] += 1
                print(f'VDL ingest: could not add {relative_path!r}: {exc}', flush=True)
            else:
                counts['imported'] += 1
        _log_ingest_event('batch-complete', counts=counts)
        print(f'VDL ingest: startup scan complete; {counts}', flush=True)


_THUMBNAIL_CACHE_VERSION = 2


def _thumbnail_path(entry, fallback_dir=None, *, version=_THUMBNAIL_CACHE_VERSION):
    """Return the stable sidecar path for one download's generated preview."""
    directory = None
    if entry.get('filename'):
        directory = os.path.dirname(os.path.abspath(entry['filename']))
    if not directory:
        directory = entry.get('output_dir') or fallback_dir
    if not directory:
        return None
    suffix = f'-v{version}' if version != 1 else ''
    return os.path.join(
        os.path.abspath(directory),
        f".vdl_{entry['id']}.thumbnail{suffix}.jpg",
    )


_PREVIEW_CACHE_VERSION = 6
_PREVIEW_FRAMES_PER_SECOND = 12


def _preview_path(entry, fallback_dir=None, *, version=_PREVIEW_CACHE_VERSION):
    """Return the stable sidecar path for one download's hover preview."""
    directory = (os.path.dirname(os.path.abspath(entry['filename']))
                 if entry.get('filename') else entry.get('output_dir'))
    if not directory:
        directory = fallback_dir
    if not directory:
        return None
    return os.path.join(
        os.path.abspath(directory),
        f".vdl_{entry['id']}.preview-v{version}.mp4",
    )


def generate_video_thumbnail(media_path, thumbnail_path):
    """Extract a compact preview frame without making download success depend on it."""
    duration = ffprobe_video_duration(media_path)
    seek_times = ([f'{duration * 2 / 3:.3f}'] if duration is not None else [])
    seek_times.extend(('1', '0'))
    for seek_time in seek_times:
        temporary_path = (
            f"{thumbnail_path}.{uuid.uuid4().hex}.tmp.jpg"
        )
        try:
            result = subprocess.run(
                [
                    'ffmpeg', '-v', 'error', '-threads', '1',
                    '-filter_threads', '1', '-filter_complex_threads', '1',
                    '-ss', seek_time, '-i', media_path, '-threads', '1',
                    '-map', '0:v:0', '-frames:v', '1', '-an', '-sn',
                    '-vf', 'scale=480:-2:force_original_aspect_ratio=decrease',
                    '-q:v', '4', '-f', 'image2', '-y', temporary_path,
                ],
                capture_output=True,
                timeout=30,
            )
            if (result.returncode == 0
                    and os.path.isfile(temporary_path)
                    and os.path.getsize(temporary_path) > 0):
                os.replace(temporary_path, thumbnail_path)
                return True
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            try:
                os.remove(temporary_path)
            except FileNotFoundError:
                pass
            except OSError:
                pass
    return False


_PREVIEW_SEGMENT_SECONDS = 2.0
_PREVIEW_SAMPLE_INTERVAL_SECONDS = 30.0
_PREVIEW_EDGE_MARGIN_SECONDS = 5.0


def ffprobe_video_duration(path):
    """Return a finite duration for the first video stream, or None."""
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error', '-threads', '1', '-select_streams', 'v:0',
                '-show_entries', 'stream=duration:format=duration',
                '-of', 'json', path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout or '{}')
        streams = data.get('streams') or []
        if not streams:
            return None
        for value in ((data.get('format') or {}).get('duration'),
                      streams[0].get('duration')):
            try:
                duration = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(duration) and duration > 0:
                return duration
    except (OSError, subprocess.SubprocessError, TypeError, ValueError,
            json.JSONDecodeError):
        pass
    return None


def _preview_segments(duration):
    """Return the duration-based recipe's inner (start, length) excerpts."""
    if not isinstance(duration, (int, float)) or not math.isfinite(duration):
        return []
    interior_duration = duration - (2 * _PREVIEW_EDGE_MARGIN_SECONDS)
    if interior_duration <= 0:
        return []
    # Trimming both outer excerpts leaves nothing until three excerpts fit.
    if interior_duration < 3 * _PREVIEW_SEGMENT_SECONDS:
        return []
    segment_count = math.floor(duration / _PREVIEW_SAMPLE_INTERVAL_SECONDS) + 3
    last_start = (
        duration
        - _PREVIEW_EDGE_MARGIN_SECONDS
        - _PREVIEW_SEGMENT_SECONDS
    )
    spacing = (
        last_start - _PREVIEW_EDGE_MARGIN_SECONDS
    ) / (segment_count - 1)
    return [
        (
            _PREVIEW_EDGE_MARGIN_SECONDS + spacing * index,
            _PREVIEW_SEGMENT_SECONDS,
        )
        # Keep the original spacing so removing endpoints never moves a sample.
        for index in range(1, segment_count - 1)
    ]


def generate_video_preview(media_path, preview_path):
    """Create a compact silent montage from evenly spaced video excerpts."""
    duration = ffprobe_video_duration(media_path)
    if duration is None:
        return False
    segments = _preview_segments(duration)
    if not segments:
        return False

    temporary_path = f"{preview_path}.{uuid.uuid4().hex}.tmp.mp4"
    command = ['ffmpeg', '-v', 'error', '-filter_threads', '1',
               '-filter_complex_threads', '1']
    for start, length in segments:
        command.extend([
            '-threads', '1', '-ss', f'{start:.3f}',
            '-t', f'{length:.3f}',
            '-i', media_path,
        ])

    filters = [
        f'[{index}:v:0]fps={_PREVIEW_FRAMES_PER_SECOND},scale=480:-2,setsar=1,'
        f'setpts=PTS-STARTPTS[v{index}]'
        for index in range(len(segments))
    ]
    inputs = ''.join(f'[v{index}]' for index in range(len(segments)))
    filters.append(
        f'{inputs}concat=n={len(segments)}:v=1:a=0[outv]'
    )
    command.extend([
        '-filter_complex', ';'.join(filters),
        '-map', '[outv]',
        '-an',
        # concat uses a microsecond time base. Pinning the output cadence keeps
        # x264 from declaring these tiny previews as unsupported level 6.2.
        '-r', str(_PREVIEW_FRAMES_PER_SECOND),
        '-c:v', 'libx264', '-threads', '1',
        '-preset', 'veryfast',
        '-crf', '28',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-f', 'mp4',
        '-y', temporary_path,
    ])

    try:
        result = subprocess.run(command, capture_output=True, timeout=180)
        if (result.returncode == 0
                and os.path.isfile(temporary_path)
                and os.path.getsize(temporary_path) > 0
                and ffprobe_video_duration(temporary_path) is not None):
            os.replace(temporary_path, preview_path)
            return True
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        try:
            os.remove(temporary_path)
        except FileNotFoundError:
            pass
        except OSError:
            pass
    return False


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

# Static UI assets are now served from templates/index.html and static/*

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/login', methods=['GET', 'POST'])
def login():
    current_id = session.get('user_id')
    current = db_get_user_by_id(current_id) if current_id is not None else None
    if (current is not None and not current['suspended']
            and current['password_hash'] is not None
            and session.get('session_version') == current['session_version']):
        return redirect(url_for('index'))

    initial_admin = db_get_initial_admin()
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '')
        password = request.form.get('password', '')
        if initial_admin is not None:
            confirmation = request.form.get('password_confirmation', '')
            if username.casefold() != initial_admin['username'].casefold():
                error = 'Complete the administrator setup first.'
            elif password != confirmation:
                error = 'Passwords do not match.'
            else:
                try:
                    user = db_set_initial_admin_password(
                        initial_admin['id'], password
                    )
                except ValueError as exc:
                    error = str(exc)
                else:
                    if user is None:
                        error = 'Administrator setup was already completed. Sign in.'
                    else:
                        _start_user_session(user)
                        return redirect(url_for('index'))
        else:
            user = db_get_user_by_username(username)
            if (user is None or user['password_hash'] is None
                    or not check_password_hash(user['password_hash'], password)):
                error = 'Invalid username or password.'
            elif user['suspended']:
                error = 'This account is suspended.'
            else:
                _start_user_session(user)
                return redirect(url_for('index'))

    response = app.make_response(render_template(
        'login.html',
        ui_version=APP_VERSION,
        initial_admin=initial_admin,
        error=error,
    ))
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/logout', methods=['POST'])
def logout():
    _get_asset_queue().clear_owner(_asset_demand_owner())
    _release_playback_sessions_for_user(session.get('user_id'))
    session.clear()
    return redirect(url_for('login'))


@app.route('/')
def index():
    response = app.make_response(render_template(
        'index.html',
        ui_version=APP_VERSION,
        current_user=_public_user(g.current_user),
        is_admin='admin' in g.current_user['roles'],
    ))
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/browser-extension/vdl-companion-firefox.xpi', methods=['GET'])
def browser_extension_package():
    package = _bundled_extension()
    if package is None:
        return _companion_error(
            500, 'extension_package_unavailable',
            'Browser extension package is unavailable',
        )
    download = request.args.get('download') == '1'
    response = send_file(
        COMPANION_XPI_PATH,
        mimetype='application/x-xpinstall',
        as_attachment=download,
        download_name=COMPANION_XPI_NAME,
        conditional=False,
    )
    response.headers['Content-Disposition'] = (
        f'{"attachment" if download else "inline"}; '
        f'filename="{COMPANION_XPI_NAME}"'
    )
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


@app.route('/api/extension/pairing-codes', methods=['POST'])
def extension_pairing_codes():
    origin = _companion_management_origin()
    if origin is None:
        return jsonify({
            'error': 'Pairing requires HTTPS or an allowed private HTTP network',
            'code': 'pairing_transport_not_allowed',
        }), 403
    code, expires_at = _new_pairing_code(g.current_user['id'], origin)
    response = jsonify({'code': code, 'expires_at': int(expires_at)})
    response.headers['Cache-Control'] = 'no-store'
    return response, 201


@app.route('/api/extension/pairing-codes/current', methods=['DELETE'])
def extension_current_pairing_code():
    with _pairing_lock:
        _pairing_codes.pop(g.current_user['id'], None)
    return '', 204


@app.route('/api/extension/connections', methods=['GET'])
def extension_connections():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, device_label, extension_version, protocol_version, "
            "created_at, last_used_at FROM extension_tokens "
            "WHERE user_id = ? AND paired_session_version = ? "
            "ORDER BY created_at DESC",
            (g.current_user['id'], g.current_user['session_version']),
        ).fetchall()
    response = jsonify({
        'connections': [dict(row) for row in rows],
        'bundled_extension': _bundled_extension(),
        'http_pairing_allowed': _companion_http_host_allowed(
            urlsplit(request.host_url).hostname
        ),
    })
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/extension/connections/<connection_id>', methods=['DELETE'])
def extension_connection(connection_id):
    with _db_lock, db() as conn:
        cursor = conn.execute(
            "DELETE FROM extension_tokens WHERE id = ? AND user_id = ?",
            (connection_id, g.current_user['id']),
        )
        removed = cursor.rowcount == 1
    if not removed:
        return jsonify({'error': 'Unknown companion connection'}), 404
    return '', 204


def _companion_preflight(method):
    origin = request.headers.get('Origin')
    if not _is_extension_origin(origin):
        return _companion_error(400, 'invalid_request', 'Invalid extension origin')
    response = app.make_response(('', 204))
    response.headers['Access-Control-Allow-Methods'] = method
    response.headers['Access-Control-Allow-Headers'] = (
        'Authorization, Content-Type, X-VDL-Companion-Protocol, '
        'X-VDL-Companion-Version'
    )
    response.headers['Access-Control-Max-Age'] = '600'
    if request.headers.get(
            'Access-Control-Request-Private-Network', ''
    ).lower() == 'true':
        response.headers['Access-Control-Allow-Private-Network'] = 'true'
    return response


@app.route('/api/extension/pair', methods=['POST', 'OPTIONS'])
def extension_pair():
    if request.method == 'OPTIONS':
        return _companion_preflight('POST')
    protocol_error = _require_companion_protocol()
    if protocol_error:
        return protocol_error
    if _failed_pair_rate_limited(request.remote_addr):
        return _companion_error(429, 'rate_limited', 'Try pairing again later')
    data, error = _read_json_body(16 * 1024)
    if error:
        return error
    if set(data) != {
        'code', 'origin', 'device_label', 'extension_version', 'protocol_version',
    }:
        _record_failed_pair(request.remote_addr)
        return _companion_error(400, 'invalid_request', 'Invalid pairing request')
    if data.get('protocol_version') != COMPANION_PROTOCOL:
        return _companion_protocol_error()
    try:
        origin = data.get('origin')
        parsed_origin = _normalized_http_origin(origin)
        if parsed_origin is None or _canonical_page_url(origin) != origin + '/':
            raise ValueError
        label = _validated_device_label(data.get('device_label'))
        extension_version = _validated_extension_version(
            data.get('extension_version')
        )
        if extension_version != request.headers.get('X-VDL-Companion-Version'):
            raise ValueError
    except ValueError:
        _record_failed_pair(request.remote_addr)
        return _companion_error(400, 'invalid_request', 'Invalid pairing request')

    user_id = _consume_pairing_code(data.get('code'), origin)
    user = db_get_user_by_id(user_id) if user_id is not None else None
    if (user is None or user['suspended'] or user['password_hash'] is None):
        _record_failed_pair(request.remote_addr)
        return _companion_error(
            401, 'companion_auth_failed', 'Companion authentication failed'
        )
    token_id, token = _new_companion_token(user, label, extension_version)
    return jsonify({
        'token': token,
        'connection_id': token_id,
        'user': {'username': user['username']},
        'protocol_version': COMPANION_PROTOCOL,
        'server_version': APP_VERSION,
        'bundled_extension_version': COMPANION_PACKAGE_VERSION,
    }), 201


@app.route('/api/extension/status', methods=['GET', 'OPTIONS'])
def extension_status():
    if request.method == 'OPTIONS':
        return _companion_preflight('GET')
    protocol_error = _require_companion_protocol()
    if protocol_error:
        return protocol_error
    auth = _companion_authenticate()
    if auth is None:
        return _companion_error(
            401, 'companion_auth_failed', 'Companion authentication failed'
        )
    return jsonify({
        'paired': True,
        'user': {'username': auth['user']['username']},
        'protocol_version': COMPANION_PROTOCOL,
        'server_version': APP_VERSION,
        'bundled_extension': _bundled_extension(),
    })


@app.route('/api/extension/downloads', methods=['POST', 'OPTIONS'])
def extension_downloads():
    if request.method == 'OPTIONS':
        return _companion_preflight('POST')
    protocol_error = _require_companion_protocol()
    if protocol_error:
        return protocol_error
    auth = _companion_authenticate()
    if auth is None:
        return _companion_error(
            401, 'companion_auth_failed', 'Companion authentication failed'
        )
    data, error = _read_json_body(256 * 1024, require_length=True)
    if error:
        return error
    if set(data) != {
        'schema', 'request_id', 'page_url', 'captured_at', 'cookies',
    } or data.get('schema') != 1:
        return _companion_error(400, 'invalid_request', 'Invalid download request')
    request_id = data.get('request_id')
    try:
        parsed_id = uuid.UUID(request_id)
        if (str(parsed_id) != request_id or parsed_id.version != 4):
            raise ValueError
        captured_at = data.get('captured_at')
        if (isinstance(captured_at, bool) or not isinstance(captured_at, int)
                or captured_at < 0 or abs(time.time() - captured_at) > 600):
            raise ValueError
        canonical_url = _canonical_page_url(data.get('page_url'))
        cookies = _validated_cookies(data.get('cookies'), canonical_url)
    except (TypeError, ValueError):
        return _companion_error(400, 'invalid_request', 'Invalid download request')

    if _token_rate_limited(auth['id'], request_id):
        return _companion_error(429, 'rate_limited', 'Try downloading again later')
    row, action, event_reason = _resolve_companion_download(
        auth['user'], request_id, canonical_url
    )
    if action == 'conflict':
        return _companion_error(
            409, 'request_id_conflict',
            'Request ID was already used for another URL',
        )
    if event_reason:
        event_bus.publish('change', {'reason': event_reason, 'id': row['id']})
    if action in ('started', 'resumed'):
        with _cancel_lock:
            _cancel_flags.pop(row['id'], None)
            _pause_flags.pop(row['id'], None)
        enqueue_download(canonical_url, row['id'], cookies)
    response_action = 'already_active' if action in ('existing', 'already_active') else action
    return jsonify({
        'id': row['id'],
        'action': response_action,
        'status': row['status'],
        'visibility': row['visibility'],
    }), (201 if action == 'started' else 200)


@app.route('/api/extension/token', methods=['DELETE', 'OPTIONS'])
def extension_token():
    if request.method == 'OPTIONS':
        return _companion_preflight('DELETE')
    protocol_error = _require_companion_protocol()
    if protocol_error:
        return protocol_error
    auth = _companion_authenticate()
    if auth is None:
        return _companion_error(
            401, 'companion_auth_failed', 'Companion authentication failed'
        )
    with _db_lock, db() as conn:
        conn.execute("DELETE FROM extension_tokens WHERE id = ?", (auth['id'],))
    return '', 204


@app.route('/api/users', methods=['GET', 'POST'])
@admin_required
def users():
    if request.method == 'GET':
        return jsonify({
            'users': db_list_users(),
            'roles': db_list_roles(),
            'current_user_id': g.current_user['id'],
        })

    data = request.get_json(silent=True) or {}
    try:
        user = db_create_user(
            data.get('username'),
            data.get('password'),
            data.get('role', 'normal'),
            data.get('name'),
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(user), 201


@app.route('/api/users/<int:user_id>', methods=['PATCH', 'DELETE'])
@admin_required
def user(user_id):
    if request.method == 'DELETE':
        if user_id == g.current_user['id']:
            return jsonify({"error": "You cannot remove your own account"}), 400
        try:
            removed = db_delete_user(user_id)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if not removed:
            return jsonify({"error": "Unknown user"}), 404
        return jsonify({"message": "User removed", "id": user_id})

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "A JSON object is required"}), 400
    allowed = {'username', 'name', 'password', 'role', 'suspended'}
    if not any(key in data for key in allowed):
        return jsonify({"error": "No user changes provided"}), 400
    if user_id == g.current_user['id'] and data.get('suspended') is True:
        return jsonify({"error": "You cannot suspend your own account"}), 400

    try:
        updated = db_update_user(
            user_id,
            username=data.get('username') if 'username' in data else None,
            name=data.get('name') if 'name' in data else None,
            password=data.get('password') if 'password' in data else None,
            role_name=data.get('role') if 'role' in data else None,
            suspended=data.get('suspended') if 'suspended' in data else None,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if updated is None:
        return jsonify({"error": "Unknown user"}), 404

    if user_id == g.current_user['id']:
        refreshed = db_get_user_by_id(user_id)
        session['session_version'] = refreshed['session_version']
    return jsonify(updated)


@app.route('/api/health', methods=['GET'])
def health():
    response = jsonify({
        "ok": True,
        "uptime_seconds": _get_uptime_seconds(),
        "version": APP_VERSION,
    })
    response.headers['Cache-Control'] = 'no-store'
    return response


def _visible_download(download_id):
    """Return a row the signed-in user may see, hiding private ids as 404."""
    entry = db_get_download(download_id)
    if entry is None:
        return None
    if (
        entry.get('visibility') == 'public'
        or entry.get('owner_user_id') == g.current_user['id']
        or 'admin' in g.current_user['roles']
    ):
        return entry
    return None


def _can_manage_download_visibility(entry):
    return (
        entry.get('owner_user_id') == g.current_user['id']
        or 'admin' in g.current_user['roles']
    )


@app.route('/api/download', methods=['POST'])
def add_download():
    data, error = _read_json_body(16384)
    if error is not None:
        return error
    if 'client_mutation_id' in data:
        result, status = _execute_download_submission(data)
        response = jsonify(result)
        response.status_code = status
        response.headers['Cache-Control'] = 'no-store'
        return response
    url = data.get('url')
    if not url:
        return jsonify({"error": "URL is required"}), 400

    requested_filename = data.get('filename')
    if requested_filename is not None:
        try:
            requested_filename = _validated_custom_filename(requested_filename)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    download_id = str(uuid.uuid4())[:8]
    db_insert_download(
        download_id,
        url,
        g.current_user['id'],
        g.current_user['username'],
    )

    # Store per-download format override if provided (selected quality)
    format_override = data.get('format')
    if format_override:
        db_update_download(download_id, requested_format=format_override)
    if requested_filename:
        db_update_download(download_id, requested_filename=requested_filename)

    enqueue_download(url, download_id)

    return jsonify({"message": "Download started", "id": download_id})


def _prepare_upload_directory(path):
    try:
        return os.path.abspath(_prepare_download_directory(path))
    except ValueError:
        # The shared preparer includes OS diagnostics; upload recovery errors
        # are public and must not copy physical paths into responses or History.
        raise ValueError('Upload directory is unavailable; review Settings') from None


def _upload_checkpoint(phase, operation):
    """Failure-injection seam at durable ownership/publication boundaries."""


def _upload_snapshot(conn, download_id):
    row = conn.execute('SELECT u.*, d.status, d.downloaded_bytes, d.total_bytes '
                       'FROM upload_operations u JOIN downloads d ON d.id=u.id WHERE u.id=?',
                       (download_id,)).fetchone()
    if row is None:
        return None
    return {'id': row['id'], 'phase': 'processing' if row['phase'] == 'publishing' else row['phase'], 'revision': str(row['revision']),
            'attempt_id': row['attempt_id'], 'download_status': row['status'],
            'downloaded_bytes': row['downloaded_bytes'] or 0,
            'total_bytes': row['total_bytes'] or 0,
            'cancel_requested': bool(row['cancel_requested']),
            'recovery_required': bool(row['cleanup_pending'] and row['phase'] in ('published', 'cancelled', 'failed'))}


def _authorized_upload(conn, download_id, actor):
    # Public playback visibility is not authority to supply another actor's bytes.
    row = conn.execute('SELECT * FROM upload_operations WHERE id=?', (download_id,)).fetchone()
    if row is None or actor is None or row['actor_id'] != actor['id']:
        return None
    target = conn.execute('SELECT owner_user_id FROM downloads WHERE id=?', (download_id,)).fetchone()
    if target is None or target['owner_user_id'] != actor['id']:
        return None
    return dict(row)


def _upload_result(conn, download_id, mutation_id=None, action=None):
    snapshot = _upload_snapshot(conn, download_id)
    result = {'id': download_id, 'upload': snapshot}
    resource = conn.execute('SELECT removal_revision FROM downloads WHERE id = ?', (download_id,)).fetchone()
    if resource is not None:
        result['removal_revision'] = str(resource['removal_revision'])
    if snapshot and snapshot['phase'] == 'published':
        row = dict(conn.execute('SELECT * FROM downloads WHERE id=?', (download_id,)).fetchone())
        public = _public_download_entry(row)
        result['download'] = {key: public.get(key) for key in (
            'id', 'url', 'status', 'progress', 'created_at', 'filename', 'display_filename',
            'resolution', 'filesize', 'speed', 'eta', 'title', 'finished_at', 'duration_seconds',
            'media_metadata_probed', 'formats', 'requested_format', 'downloaded_bytes', 'total_bytes',
            'favorite', 'view_count', 'source_type', 'visibility', 'browser_authenticated')}
        owner = conn.execute('SELECT username FROM users WHERE id=?', (row['owner_user_id'],)).fetchone()
        result['download']['downloaded_by'] = owner['username'] if owner else row['owner_username']
        result['download']['can_manage_visibility'] = True
        result['download']['can_manage_upload'] = True
        result['download'].update(_tag_snapshot(conn, download_id, row))
        result['download'].update(_favorite_snapshot(conn, download_id, row))
        result['download'].update(_rename_snapshot(conn, download_id, row))
        result['download'].update(_download_command_snapshot(conn, download_id, row))
        result['download']['removal_revision'] = str(row['removal_revision'])
        result['download']['quality'] = classify_video_quality(row['resolution'])
        result['download']['filename'] = public['filename']
        result['download']['upload'] = snapshot
    if action == 'upload.register':
        result['message'] = 'Video upload registered'
    elif action == 'upload.cancel':
        result['message'] = 'Upload already published' if snapshot['phase'] == 'published' else 'Stop requested'
    if mutation_id:
        result['mutation'] = {'id': mutation_id, 'domain': 'upload', 'action': action,
                              'outcome': 'accepted', 'revision': snapshot['revision']}
    return result


def _upload_decline(download_id, mutation_id, error, status, outcome='rejected'):
    return {'id': download_id, 'upload': None, 'error': error,
            'mutation': {'id': mutation_id, 'domain': 'upload', 'outcome': outcome, 'revision': '0'}}, status


def _upload_admission(conn, actor, mutation_id, fingerprint, download_id, *, existing_only=False):
    if mutation_id is None:
        return None
    match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
    if not match:
        return _upload_decline(download_id, mutation_id, 'Invalid mutation id', 400)
    receipt = conn.execute('SELECT * FROM mutation_receipts WHERE actor_id=? AND mutation_id=?',
                           (actor['id'], mutation_id)).fetchone()
    if receipt:
        if receipt['fingerprint'] != fingerprint or receipt['target_id'] != download_id:
            return _upload_decline(download_id, mutation_id, 'Mutation id is already bound to another request', 409, 'conflicted')
        if _authorized_upload(conn, download_id, actor) is None:
            return {'error': 'Upload unavailable'}, 404
        result = json.loads(receipt['response'])
        latest = _upload_result(conn, download_id)
        result.update(latest)
        result['mutation']['revision'] = result['upload']['revision']
        return result, receipt['status']
    if existing_only:
        return None
    if conn.execute('SELECT 1 FROM rename_operations WHERE actor_id=? AND mutation_id=?', (actor['id'], mutation_id)).fetchone():
        return _upload_decline(download_id, mutation_id, 'Mutation id is already bound to another request', 409, 'conflicted')
    now = time.time()
    _prune_mutation_receipts(conn, now)
    counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at>?),0) AS recent '
                          'FROM mutation_receipts WHERE actor_id=?', (now-60, actor['id'])).fetchone()
    active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id=? AND "
                          "(phase!='done' OR NOT EXISTS (SELECT 1 FROM mutation_receipts r "
                          "WHERE r.actor_id=rename_operations.actor_id AND r.mutation_id=rename_operations.mutation_id))",
                          (actor['id'],)).fetchone()[0]
    if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
        return _upload_decline(download_id, mutation_id, 'Mutation quota exceeded', 429)
    created = int(match.group(1)) / 1000
    if created < now-MUTATION_REPLAY_SECONDS or created > now+300:
        return _upload_decline(download_id, mutation_id, 'Mutation attempt has expired', 409)
    return None


def _record_upload_receipt(conn, actor, mutation_id, fingerprint, result, status):
    if mutation_id:
        conn.execute('INSERT INTO mutation_receipts(actor_id,mutation_id,target_id,fingerprint,status,response,recorded_at) '
                     'VALUES (?,?,?,?,?,?,?)', (actor['id'], mutation_id, result['id'], fingerprint,
                                               status, json.dumps(result), time.time()))


def _upload_phase(download_id, phase, **fields):
    with _db_lock, db() as conn:
        assignments = ['phase=?', 'revision=revision+1'] + [f'{name}=?' for name in fields]
        conn.execute(f'UPDATE upload_operations SET {", ".join(assignments)} WHERE id=?',
                     [phase, *fields.values(), download_id])
        operation = dict(conn.execute('SELECT * FROM upload_operations WHERE id=?', (download_id,)).fetchone())
    _upload_checkpoint(phase, operation)
    return operation


def _upload_cleanup(operation, *, preserve_final=False):
    """Retire owned paths exclusively before inspecting or removing them."""
    clean = True
    paths = [operation.get('temporary_path')]
    if not preserve_final:
        paths.append(operation.get('final_path'))
    retired = json.loads(operation.get('retired_paths') or '[]')
    # Persist the retirement destination before moving anything. Recovery can
    # find the pinned inode even if the process dies during cleanup.
    for path in paths:
        if not path or any(item['source'] == path for item in retired):
            continue
        target = os.path.join(os.path.dirname(path), f'.vdl_{operation["id"]}.{secrets.token_hex(16)}.upload.retired')
        retired.append({'source': path, 'retired': target})
    with _db_lock, db() as conn:
        conn.execute('UPDATE upload_operations SET retired_paths=? WHERE id=?',
                     (json.dumps(retired), operation['id']))
    operation['retired_paths'] = json.dumps(retired)
    for item in retired:
        source, target = item['source'], item['retired']
        try:
            try:
                info = os.lstat(target)
            except FileNotFoundError:
                try:
                    info = os.lstat(source)
                except FileNotFoundError:
                    continue
                if (str(info.st_dev) != operation.get('device') or str(info.st_ino) != operation.get('inode')
                        or not stat.S_ISREG(info.st_mode)):
                    clean = False
                    continue
                _upload_checkpoint('before_retire', {**operation, 'source': source})
                _rename_noreplace(source, target)
                _rename_sync(os.path.dirname(source))
                info = os.lstat(target)
            if (str(info.st_dev) != operation.get('device') or str(info.st_ino) != operation.get('inode')
                    or not stat.S_ISREG(info.st_mode)):
                # A replacement raced the exclusive move. Restore it only if
                # its original location is still free; never overwrite either.
                try:
                    _rename_noreplace(target, source)
                    _rename_sync(os.path.dirname(source))
                except OSError:
                    pass
                clean = False
                continue
            os.unlink(target)
            _rename_sync(os.path.dirname(target))
        except FileNotFoundError:
            pass
        except OSError:
            clean = False
    return clean


def _finish_upload_failure(download_id, phase, message, *, interrupted=False):
    with _upload_lock:
        with db() as conn:
            row = conn.execute('SELECT * FROM upload_operations WHERE id=?', (download_id,)).fetchone()
        if row is None or row['phase'] == 'published':
            return
        operation = dict(row)
        clean = _upload_cleanup(operation)
        status = 'interrupted' if interrupted else 'cancelled' if phase == 'cancelled' else 'error'
        with _db_lock, db() as conn:
            conn.execute('UPDATE upload_operations SET phase=?,revision=revision+1,cleanup_pending=? WHERE id=?',
                         (phase, not clean, download_id))
            conn.execute('UPDATE downloads SET status=?,progress=?,finished_at=? WHERE id=?',
                         (status, message if clean else 'Upload recovery requires intervention', time.time(), download_id))
            download_history.record(conn, download_id)
    _publish_metadata_change('upload')


def _recover_upload_operations():
    # A browser File cannot survive restart. Resolve the same attempt rather
    # than launching a transfer or guessing that a precommit hardlink published.
    with _file_operation_lock, db() as conn:
        operations = [dict(row) for row in conn.execute('SELECT * FROM upload_operations')]
    for operation in operations:
        if operation['phase'] == 'published':
            clean = _upload_cleanup(operation, preserve_final=True)
            with _db_lock, db() as conn:
                conn.execute('UPDATE upload_operations SET cleanup_pending=? WHERE id=?', (not clean, operation['id']))
        elif operation['phase'] not in ('cancelled', 'failed') or operation['cleanup_pending']:
            cancelled = operation['cancel_requested']
            _finish_upload_failure(operation['id'], 'cancelled' if cancelled else 'failed',
                                   'Cancelled' if cancelled else 'Upload interrupted; choose the file again',
                                   interrupted=not cancelled)


@app.route('/api/upload', methods=['POST'])
def start_video_upload():
    data, error = _read_json_body(16384)
    if error is not None:
        return error
    try:
        original_name = _validated_upload_filename(data.get('filename'))
        filesize = data.get('filesize')
        if isinstance(filesize, bool) or not isinstance(filesize, int) or filesize <= 0 or filesize > 9007199254740991:
            raise ValueError('Uploaded video size must be a positive integer')
        download_id = data.get('id', str(uuid.uuid4())[:8])
        if 'id' in data and (not isinstance(download_id, str) or not re.fullmatch(r'[0-9a-f]{32}', download_id)):
            raise ValueError('Invalid upload id')
        mutation_id = data.get('client_mutation_id')
        if 'client_mutation_id' in data and mutation_id is None:
            raise ValueError('Invalid mutation id')
        if 'client_mutation_id' in data and 'id' not in data:
            raise ValueError('A preallocated upload id is required')
        if mutation_id is not None and set(data) - {'id', 'filename', 'filesize', 'client_mutation_id'}:
            raise ValueError('Unsupported upload registration fields')
    except ValueError as exc:
        result, status = _upload_decline(data.get('id'), data.get('client_mutation_id'), str(exc), 400)
        return jsonify(result), status
    fingerprint = hashlib.sha256(json.dumps({'action': 'upload.register', 'id': download_id,
                              'filename': data['filename'], 'filesize': filesize}, sort_keys=True).encode()).hexdigest()
    try:
        # Recover an already accepted operation before consulting preferences
        # that may have changed since its output directory was captured.
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return jsonify({'error': 'Authentication required'}), 401
            replay = _upload_admission(conn, actor, mutation_id, fingerprint, download_id, existing_only=True)
            if replay:
                return jsonify(replay[0]), replay[1]
            if mutation_id is None:
                operation = _authorized_upload(conn, download_id, actor)
                if operation and operation['fingerprint'] == fingerprint:
                    return jsonify(_upload_result(conn, download_id, action='upload.register')), 202
        output_dir = _prepare_upload_directory(db_get_preferences().get('download_dir', '.'))
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return jsonify({'error': 'Authentication required'}), 401
            admission = _upload_admission(conn, actor, mutation_id, fingerprint, download_id)
            if admission:
                return jsonify(admission[0]), admission[1]
            existing = conn.execute('SELECT * FROM upload_operations WHERE id=?', (download_id,)).fetchone()
            if existing:
                if existing['actor_id'] != actor['id'] or existing['fingerprint'] != fingerprint:
                    result, status = _upload_decline(download_id, mutation_id, 'Upload id already exists', 409, 'conflicted')
                    return jsonify(result), status
                result = _upload_result(conn, download_id, mutation_id, 'upload.register')
            else:
                active = conn.execute("SELECT COUNT(*) FROM upload_operations WHERE actor_id=? "
                                      "AND phase IN ('registered','transferring','processing','publishing')", (actor['id'],)).fetchone()[0]
                if active >= 100:
                    result, status = _upload_decline(download_id, mutation_id, 'Too many outstanding uploads', 429)
                    return jsonify(result), status
                title = os.path.splitext(original_name)[0] or original_name
                conn.execute("INSERT INTO downloads(id,url,status,progress,created_at,filesize,title,output_dir,"
                             "requested_filename,downloaded_bytes,total_bytes,source_type,owner_user_id,owner_username) "
                             "VALUES (?,'','starting','0%',?,?,?,?,?,0,?,'upload',?,?)",
                             (download_id,time.time(),filesize,title,output_dir,original_name,filesize,actor['id'],actor['username']))
                download_history.record(conn, download_id, create=True)
                attempt = conn.execute('SELECT id FROM download_attempts WHERE work_id=? ORDER BY started_at DESC,id DESC LIMIT 1',
                                       (download_id,)).fetchone()
                conn.execute('INSERT INTO upload_operations(id,actor_id,actor_session_version,mutation_id,fingerprint,attempt_id,recorded_at) '
                             'VALUES (?,?,?,?,?,?,?)', (download_id,actor['id'],actor['session_version'],mutation_id,fingerprint,attempt['id'],time.time()))
                result = _upload_result(conn, download_id, mutation_id, 'upload.register')
            _record_upload_receipt(conn, actor, mutation_id, fingerprint, result, 202)
        _upload_checkpoint('registered', {'id': download_id})
        _publish_metadata_change('upload')
        return jsonify(result), 202
    except ValueError as exc:
        result, status = _upload_decline(download_id, mutation_id, str(exc), 400)
        return jsonify(result), status
    except sqlite3.IntegrityError:
        result, status = _upload_decline(download_id, mutation_id, 'Upload id already exists', 409, 'conflicted')
        return jsonify(result), status
    except sqlite3.Error:
        return jsonify({'error': 'Unable to start the video upload'}), 500


@app.route('/api/upload/<download_id>/status', methods=['GET'])
def upload_status(download_id):
    with _db_lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        actor = _tag_actor(conn)
        if actor is None:
            return jsonify({'error': 'Authentication required'}), 401
        if _authorized_upload(conn, download_id, actor) is None:
            return jsonify({'error': 'Upload unavailable'}), 404
        response = jsonify(_upload_result(conn, download_id))
        response.headers['Cache-Control'] = 'no-store'
        return response


def _cancel_upload(download_id, payload):
    mutation_id = payload.get('client_mutation_id')
    if 'client_mutation_id' in payload and mutation_id is None:
        return _upload_decline(download_id, mutation_id, 'Invalid mutation id', 400)
    if mutation_id is not None and set(payload) - {'client_mutation_id', 'expected_revision'}:
        return _upload_decline(download_id, mutation_id, 'Unsupported upload cancellation fields', 400)
    fingerprint = hashlib.sha256(json.dumps({'action':'upload.cancel','id':download_id,'payload':payload}, sort_keys=True).encode()).hexdigest()
    with _file_operation_lock, _upload_lock:
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return {'error': 'Authentication required'}, 401
            operation = _authorized_upload(conn, download_id, actor)
            if operation is None:
                return {'error': 'Upload unavailable'}, 404
            admission = _upload_admission(conn, actor, mutation_id, fingerprint, download_id)
            if admission:
                return admission
            if operation['phase'] not in ('published','cancelled','failed'):
                conn.execute('UPDATE upload_operations SET cancel_requested=1,revision=revision+1 WHERE id=?', (download_id,))
            result = _upload_result(conn, download_id, mutation_id, 'upload.cancel')
            _record_upload_receipt(conn, actor, mutation_id, fingerprint, result, 200)
        if operation['phase'] not in ('published','cancelled','failed'):
            request_cancel(download_id)
            if download_id not in _live_worker_ids:
                _finish_upload_failure(download_id, 'cancelled', 'Cancelled')
                clear_cancel(download_id)
        with db() as conn:
            latest = _upload_result(conn, download_id)
            result.update(latest)
            if mutation_id:
                result['mutation']['revision'] = result['upload']['revision']
    _publish_metadata_change('upload')
    return result, 200


@app.route('/api/upload/<download_id>/cancel', methods=['POST'])
def cancel_video_upload(download_id):
    payload, error = _read_json_body(4096)
    if error is not None:
        return error
    result, status = _cancel_upload(download_id, payload)
    response = jsonify(result)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


def _upload_progress(download_id, received, expected_size):
    with _db_lock, db() as conn:
        conn.execute("UPDATE downloads SET status='downloading',progress=?,downloaded_bytes=?,total_bytes=? WHERE id=?",
                     (f'{received / expected_size * 100:.1f}%',received,expected_size,download_id))
        download_history.record(conn, download_id)
    _publish_metadata_change('upload')


@app.route('/api/upload/<download_id>', methods=['PUT'])
def receive_video_upload(download_id):
    with _file_operation_lock, _worker_condition, _upload_lock:
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return jsonify({'error': 'Authentication required'}), 401
            operation = _authorized_upload(conn, download_id, actor)
            entry = conn.execute('SELECT * FROM downloads WHERE id=?', (download_id,)).fetchone()
            if operation is None:
                visible = _tag_visible_row(conn, download_id, actor)
                non_upload = visible is not None and visible['source_type'] != 'upload'
                return jsonify({'error': 'Entry is not a local upload' if non_upload else 'Unknown upload id'}), 409 if non_upload else 404
            if operation['actor_session_version'] != actor['session_version']:
                return jsonify({'error': 'Upload belongs to an expired session'}), 403
            if operation['phase'] != 'registered' or operation['cancel_requested'] or entry['status'] != 'starting':
                return jsonify({'error': 'Upload transfer already claimed or unavailable', **_upload_result(conn, download_id)}), 409
            conn.execute("UPDATE upload_operations SET phase='transferring',revision=revision+1 WHERE id=?", (download_id,))
            conn.execute("UPDATE downloads SET status='downloading',progress='0%' WHERE id=?", (download_id,))
            download_history.record(conn, download_id)
            entry = dict(entry)
        _live_worker_ids.add(download_id)
    received = 0
    expected_size = int(entry['total_bytes'])
    completed = False
    try:
        output_dir = _prepare_upload_directory(entry['output_dir'])
        temporary_path = os.path.join(output_dir, f'.vdl_{download_id}.{secrets.token_hex(16)}.upload.part')
        _upload_phase(download_id, 'transferring', temporary_path=temporary_path, cleanup_pending=1)
        with open(temporary_path, 'xb') as temporary:
            info = os.fstat(temporary.fileno())
            operation = _upload_phase(download_id, 'transferring', device=str(info.st_dev), inode=str(info.st_ino))
            while True:
                if is_cancel_requested(download_id):
                    raise DownloadCancelled()
                chunk = request.stream.read(1024*1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > expected_size:
                    raise ValueError('Uploaded video is larger than declared')
                temporary.write(chunk)
                _upload_progress(download_id, received, expected_size)
            temporary.flush()
            os.fsync(temporary.fileno())
        _rename_sync(output_dir)
        if received != expected_size:
            raise ValueError('Uploaded video ended before all bytes arrived')
        if is_cancel_requested(download_id):
            raise DownloadCancelled()
        _upload_phase(download_id, 'processing')
        try:
            resolution = inspect_uploaded_video(temporary_path)
            duration = _consume_media_probe(temporary_path, resolution)
        except ValueError as exc:
            _finish_upload_failure(download_id, 'failed', str(exc))
            with db() as conn:
                return jsonify({'error': str(exc), **_upload_result(conn, download_id)}), 415
        except RuntimeError as exc:
            _finish_upload_failure(download_id, 'failed', str(exc))
            with db() as conn:
                return jsonify({'error': str(exc), **_upload_result(conn, download_id)}), 503
        # Removal, cancellation and publication share this boundary. A Stop
        # arriving after the finished commit observes publication, never erases it.
        with _file_operation_lock, _upload_lock:
            with _db_lock, db() as conn:
                actor = _tag_actor(conn)
                operation = _authorized_upload(conn, download_id, actor)
                if operation is None or operation['actor_session_version'] != actor['session_version']:
                    raise PermissionError('Upload authorization changed')
                if operation['cancel_requested'] or is_cancel_requested(download_id):
                    raise DownloadCancelled()
            stem, extension = os.path.splitext(entry['requested_filename'])
            for suffix in range(10000):
                final_path = os.path.join(output_dir, entry['requested_filename'] if suffix == 0 else f'{stem} ({suffix}){extension}')
                operation = _upload_phase(download_id, 'publishing', final_path=final_path)
                try:
                    os.link(temporary_path, final_path)
                    break
                except FileExistsError:
                    continue
            else:
                raise OSError('Unable to choose an unused upload filename')
            _rename_sync(output_dir)
            _upload_checkpoint('linked', operation)
            with _db_lock, db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                actor = _tag_actor(conn)
                current = _authorized_upload(conn, download_id, actor)
                if current is None or current['actor_session_version'] != actor['session_version']:
                    raise PermissionError('Upload authorization changed')
                if current['cancel_requested']:
                    raise DownloadCancelled()
                # A replacement cannot be published as the bytes we validated.
                final_info = os.stat(final_path, follow_symlinks=False)
                if str(final_info.st_dev) != operation['device'] or str(final_info.st_ino) != operation['inode']:
                    raise OSError('Upload destination identity changed')
                conn.execute("UPDATE downloads SET status='finished',progress='100%',filename=?,filesize=?,resolution=?,"
                             "duration_seconds=?,media_metadata_probed=1,speed=0,eta=0,finished_at=?,downloaded_bytes=?,total_bytes=? WHERE id=?",
                             (final_path,received,resolution,duration,time.time(),received,received,download_id))
                conn.execute("UPDATE upload_operations SET phase='published',revision=revision+1,cleanup_pending=0 WHERE id=?", (download_id,))
                conn.execute("INSERT OR IGNORE INTO media_hashes(download_id,state) VALUES (?,'pending')", (download_id,))
                download_history.record(conn, download_id)
            completed = True
            _upload_checkpoint('published', operation)
            clean = _upload_cleanup(operation, preserve_final=True)
            with _db_lock, db() as conn:
                conn.execute('UPDATE upload_operations SET cleanup_pending=? WHERE id=?', (not clean,download_id))
        _publish_metadata_change('upload')
        _register_media_assets(download_id)
        _wake_duplicate_backfill()
        with db() as conn:
            return jsonify({'message':'Video added to library','filename':os.path.basename(final_path), **_upload_result(conn, download_id)})
    except DownloadCancelled:
        _finish_upload_failure(download_id, 'cancelled', 'Cancelled')
        with db() as conn:
            return jsonify({'error':'Upload cancelled', **_upload_result(conn, download_id)}), 409
    except ValueError as exc:
        _finish_upload_failure(download_id, 'failed', str(exc))
        with db() as conn:
            return jsonify({'error':str(exc), **_upload_result(conn, download_id)}), 400
    except PermissionError:
        _finish_upload_failure(download_id, 'failed', 'Upload authorization changed')
        return jsonify({'error': 'Upload authorization changed'}), 401
    except Exception:
        if not completed:
            cancelled = is_cancel_requested(download_id)
            _finish_upload_failure(download_id, 'cancelled' if cancelled else 'failed',
                                   'Cancelled' if cancelled else 'Upload failed; choose the file again')
        with db() as conn:
            return jsonify({'error':'Upload result not confirmed; check upload status', **_upload_result(conn, download_id)}), 500
    finally:
        clear_cancel(download_id)
        with _worker_condition:
            _live_worker_ids.discard(download_id)
            _worker_condition.notify_all()


@app.route('/api/probe', methods=['POST'])
def probe_url():
    """Probe a video URL to extract available formats and basic info (title)
    without downloading. Returns available qualities/formats and video title."""
    data = request.json or {}
    url = data.get('url')
    if not url:
        return jsonify({"error": "URL is required"}), 400

    try:
        with yt_dlp.YoutubeDL(yt_dlp_options({
            'quiet': True,
            'noprogress': True,
            'skip_download': True,
        })) as probe:
            info = probe.extract_info(url, download=False)

        # Extract title
        title = info.get('title') or info.get('fulltitle')

        # Build list of formats with resolution info
        formats_summary = summarize_formats(info)
        
        # Collect numeric video heights in order (highest first). Extractors
        # also use `resolution` for labels such as "audio only"; those are
        # display metadata, not values suitable for a height selector.
        resolutions_list = []
        seen_res = set()
        container_exts = set()
        if formats_summary:
            for fmt in formats_summary:
                try:
                    height = int(fmt.get('height'))
                except (TypeError, ValueError):
                    height = 0
                res_str = f"{height}p" if height > 0 else None

                if res_str and res_str not in seen_res:
                    seen_res.add(res_str)
                    resolutions_list.append(res_str)
                
                # Collect unique container formats (extensions)
                if fmt.get('ext'):
                    container_exts.add(fmt['ext'])
        
        # Sort by height (descending)
        resolutions_list.sort(
            key=lambda resolution: int(resolution.removesuffix('p')),
            reverse=True,
        )
        
        # Sort containers: mp4 first (if available), then others alphabetically
        containers_list = sorted(container_exts, key=lambda x: (x != 'mp4', x))

        return jsonify({
            "title": title,
            "resolutions": resolutions_list,
            "containers": containers_list,
            "formats": formats_summary
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


def _download_command_snapshot(conn, download_id, row=None):
    if row is None:
        row = conn.execute('SELECT command_revision, removal_revision FROM downloads WHERE id = ?', (download_id,)).fetchone()
    latest = conn.execute('SELECT id FROM download_attempts WHERE work_id = ? '
                          'ORDER BY started_at DESC, id DESC LIMIT 1', (download_id,)).fetchone()
    attempt_id = latest['id'] if latest else None
    job = conn.execute("SELECT id FROM download_commands WHERE target_id = ? AND attempt_id = ? "
                       "AND action IN ('submit', 'retry', 'resume') ORDER BY recorded_at DESC, id DESC LIMIT 1",
                       (download_id, attempt_id)).fetchone()
    return {'command_revision': str(row['command_revision']), 'removal_revision': str(row['removal_revision']),
            'current_attempt_id': attempt_id, 'job_id': job['id'] if job else None}


def _prune_mutation_receipts(conn, now):
    # A queued/running execution can outlive the replay window. All adapters
    # share this cleanup boundary so unrelated edits cannot erase its receipt.
    cutoff = now - MUTATION_RETENTION_SECONDS
    conn.execute("DELETE FROM bulk_clear_scopes WHERE phase = 'completed' AND recorded_at < ?", (cutoff,))
    conn.execute("DELETE FROM download_commands WHERE recorded_at < ? AND phase NOT IN ('accepted', 'dispatching') "
                 "AND NOT EXISTS (SELECT 1 FROM download_attempts a WHERE a.id = download_commands.attempt_id "
                 "AND a.status IN ('starting', 'downloading', 'paused'))", (cutoff,))
    conn.execute("DELETE FROM removal_operations WHERE recorded_at < ? AND phase = 'cleaned' AND NOT EXISTS "
                 "(SELECT 1 FROM mutation_receipts r WHERE r.actor_id = removal_operations.actor_id "
                 "AND r.mutation_id = removal_operations.mutation_id AND r.recorded_at >= ?) "
                 "AND NOT EXISTS (SELECT 1 FROM bulk_clear_targets t JOIN bulk_clear_scopes s ON s.id=t.scope_id "
                 "WHERE t.child_mutation_id=removal_operations.mutation_id AND s.actor_id=removal_operations.actor_id "
                 "AND s.phase != 'completed')", (cutoff, cutoff))
    conn.execute('DELETE FROM mutation_receipts WHERE recorded_at < ? AND NOT EXISTS '
                 '(SELECT 1 FROM bulk_clear_scopes s WHERE s.actor_id = mutation_receipts.actor_id '
                 "AND s.phase != 'completed' AND (s.mutation_id = mutation_receipts.mutation_id OR EXISTS "
                 '(SELECT 1 FROM bulk_clear_targets t WHERE t.scope_id=s.id '
                 'AND t.child_mutation_id=mutation_receipts.mutation_id))) AND NOT EXISTS '
                 "(SELECT 1 FROM removal_operations m WHERE m.actor_id = mutation_receipts.actor_id "
                 "AND m.mutation_id = mutation_receipts.mutation_id AND m.phase != 'cleaned') AND NOT EXISTS "
                 '(SELECT 1 FROM download_commands c WHERE c.actor_id = mutation_receipts.actor_id '
                 'AND c.mutation_id = mutation_receipts.mutation_id) AND NOT EXISTS '
                 '(SELECT 1 FROM upload_operations u WHERE u.actor_id = mutation_receipts.actor_id '
                 'AND u.id = mutation_receipts.target_id '
                 "AND (u.phase IN ('registered','transferring','processing','publishing') OR u.cleanup_pending = 1))", (cutoff,))


def _command_receipt_state(conn, result):
    command = result.get('command') or result.get('job')
    if command is None:
        return result
    record = conn.execute('SELECT * FROM download_commands WHERE id = ?', (command['id'],)).fetchone()
    if record is not None:
        attempt = conn.execute('SELECT status FROM download_attempts WHERE id = ?', (record['attempt_id'],)).fetchone()
        command['status'] = (attempt['status'] if attempt and attempt['status'] in TERMINAL_STATUSES
                             else record['phase'])
    return result


def _dispatch_download_command(command_id):
    # Caller holds the same filesystem/scheduler boundary as legacy commands.
    # Claim before external effects: neither replay nor restart repeats cleanup
    # after an ambiguous crash. Startup reports interruption instead.
    with _db_lock, db() as conn:
        conn.execute('BEGIN IMMEDIATE')
        record = conn.execute('SELECT * FROM download_commands WHERE id = ?', (command_id,)).fetchone()
        if record is None or record['phase'] != 'accepted':
            return
        record = dict(record)
        row = conn.execute('SELECT * FROM downloads WHERE id = ?', (record['target_id'],)).fetchone()
        if row is None or _download_command_snapshot(conn, row['id'], row)['current_attempt_id'] != record['attempt_id']:
            conn.execute("UPDATE download_commands SET phase = 'superseded' WHERE id = ?", (command_id,))
            return
        actor = _tag_actor(conn)
        if (actor is None or actor['id'] != record['actor_id']
                or actor['session_version'] != record['actor_session_version']
                or _tag_visible_row(conn, row['id'], actor) is None):
            conn.execute("UPDATE download_commands SET phase = 'interrupted' WHERE id = ?", (command_id,))
            if record['action'] in ('submit', 'retry', 'resume'):
                conn.execute("UPDATE downloads SET status = 'interrupted', progress = 'Command interrupted before dispatch', finished_at = ? WHERE id = ?", (time.time(), row['id']))
                download_history.record(conn, row['id'])
            return
        if record['action'] in ('pause', 'unpause', 'stop') and row['status'] in TERMINAL_STATUSES:
            # Acceptance does not keep an execution alive. A worker may have
            # completed since admission; never attach fresh flags to its result.
            conn.execute("UPDATE download_commands SET phase = 'dispatched' WHERE id = ?", (command_id,))
            return
        conn.execute("UPDATE download_commands SET phase = 'dispatching' WHERE id = ?", (command_id,))
        row = dict(row)
    target, action = record['target_id'], record['action']
    try:
        if action == 'retry':
            assets = _get_asset_queue()
            with assets.publication_lock:
                with _db_lock, db() as conn:
                    assets.invalidate([target], conn=conn)
                delete_download_artifacts(row, db_get_preferences().get('download_dir', '.'))
                with _db_lock, db() as conn:
                    conn.execute('UPDATE downloads SET filename = NULL, filesize = NULL WHERE id = ?', (target,))
                    conn.execute('DELETE FROM asset_invalidations WHERE download_id = ?', (target,))
        if action in ('submit', 'retry', 'resume'):
            clear_cancel(target)
            clear_pause(target)
            enqueue_download(row['url'], target)
        elif action == 'pause':
            # A Stop accepted earlier for this generation always wins.
            if not is_cancel_requested(target):
                request_pause(target)
        elif action == 'unpause':
            clear_pause(target)
        elif action == 'stop' and row['source_type'] == 'upload':
            _result, status = _cancel_upload(target, {})
            if status >= 400:
                raise RuntimeError('Upload stop unavailable')
        elif action == 'stop':
            request_cancel(target)
            if (target not in _live_worker_ids and target not in _worker_hosts
                    and not any(job['id'] == target for job in _worker_queue)):
                current = db_get_download(target)
                if current and current['status'] in download_history.ACTIVE:
                    db_update_download(target, status='cancelled', finished_at=time.time())
        if action in ('pause', 'unpause', 'stop'):
            current = db_get_download(target)
            if current and current['status'] in TERMINAL_STATUSES:
                # Close the small race between the dispatch check and applying
                # the flag, after the worker's own final cleanup has run.
                clear_cancel(target)
                clear_pause(target)
        with _db_lock, db() as conn:
            conn.execute("UPDATE download_commands SET phase = 'dispatched' WHERE id = ?", (command_id,))
    except Exception:
        # Acceptance is durable even when dispatch fails. Do not expose paths
        # or turn an accepted job into an allegedly rejected HTTP request.
        with _db_lock, db() as conn:
            conn.execute("UPDATE download_commands SET phase = 'interrupted' WHERE id = ?", (command_id,))
        if action in ('submit', 'retry', 'resume'):
            db_update_download(target, status='error', progress='Accepted command could not start; review the current download', finished_at=time.time())
        app.logger.warning('mutation action=download.%s dispatch=failed', action)
    _publish_metadata_change('download-submission' if action == 'submit' else 'download-command')


def _execute_download_submission(payload):
    mutation_id = payload.get('client_mutation_id')
    match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
    if match is None:
        return {'error': 'Invalid mutation identifier'}, 400
    # Hash the exact captured request, including omitted versus explicit fields.
    # Only the hash and identities belong in receipt presentation.
    fingerprint = hashlib.sha256(json.dumps(
        ['POST', 'download.submit', payload], sort_keys=True,
        ensure_ascii=True, separators=(',', ':'),
    ).encode()).hexdigest()
    dispatch_id = None
    with _file_operation_lock, _worker_condition:
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return {'error': 'Authentication required'}, 401
            receipt = conn.execute('SELECT * FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?',
                                   (actor['id'], mutation_id)).fetchone()
            if receipt is not None:
                if receipt['fingerprint'] != fingerprint:
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                result = json.loads(receipt['response'])
                if result['id'] is not None and _tag_visible_row(conn, result['id'], actor) is None:
                    return {'error': 'Download request unavailable'}, 404
                result, status = _command_receipt_state(conn, result), receipt['status']
                if result.get('job'):
                    dispatch_id = result['job']['id']
            else:
                if conn.execute("SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ? AND phase != 'done'",
                                (actor['id'], mutation_id)).fetchone():
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                now = time.time()
                _prune_mutation_receipts(conn, now)
                counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent '
                                      'FROM mutation_receipts WHERE actor_id = ?', (now - 60, actor['id'])).fetchone()
                unresolved = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS "
                                          "(SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
                if counts['total'] + unresolved >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + unresolved >= MUTATION_ACTOR_MINUTE_LIMIT:
                    return dict(id=None, job=None, current_attempt_id=None, submission_revision='0',
                                mutation={'id': mutation_id, 'domain': 'download-submission',
                                          'revision': '0', 'outcome': 'rejected'},
                                error='Too many mutations; wait before submitting more',
                                code='mutation_limit', server_time=int(now * 1000)), 429
                error, filename = None, None
                created = int(match.group(1)) / 1000
                if created < now - MUTATION_REPLAY_SECONDS or created > now + 300:
                    error = 'Mutation identifier expired or clock is incorrect'
                elif set(payload) - {'client_mutation_id', 'url', 'format', 'filename'}:
                    error = 'Unsupported download fields'
                else:
                    try:
                        _canonical_page_url(payload.get('url'))
                        if 'format' in payload and (not isinstance(payload['format'], str)
                                or not payload['format'].strip() or len(payload['format']) > 4096
                                or any(ord(character) < 32 or ord(character) == 127 for character in payload['format'])):
                            raise ValueError('Invalid download format')
                        if 'filename' in payload:
                            if isinstance(payload['filename'], str) and len(payload['filename'].encode('utf-8')) > 1024:
                                raise ValueError('Filename is too long')
                            filename = _validated_custom_filename(payload['filename'])
                    except (ValueError, UnicodeError) as exc:
                        error = str(exc)
                download_id, attempt_id, job = None, None, None
                if error is None:
                    download_id, dispatch_id = uuid.uuid4().hex, uuid.uuid4().hex
                    conn.execute("INSERT INTO downloads(id,url,status,progress,created_at,owner_user_id,owner_username,requested_format,requested_filename) "
                                 "VALUES (?,?,'starting','0%',?,?,?,?,?)",
                                 (download_id, payload['url'], now, actor['id'], actor['username'], payload.get('format'), filename))
                    download_history.record(conn, download_id, create=True)
                    attempt_id = _download_command_snapshot(conn, download_id)['current_attempt_id']
                    conn.execute('INSERT INTO download_commands(id,actor_id,mutation_id,target_id,actor_session_version,action,source_attempt_id,attempt_id,phase,recorded_at) '
                                 "VALUES (?,?,?,?,?,'submit',NULL,?,'accepted',?)",
                                 (dispatch_id, actor['id'], mutation_id, download_id, actor['session_version'], attempt_id, now))
                    job = {'id': dispatch_id, 'download_id': download_id, 'attempt_id': attempt_id, 'status': 'accepted'}
                revision = '0' if error else '1'
                status = 400 if error else 202
                result = dict(id=download_id, submission_revision=revision, current_attempt_id=attempt_id, job=job,
                              mutation={'id': mutation_id, 'domain': 'download-submission', 'revision': revision,
                                        'outcome': 'rejected' if error else 'accepted'}, server_time=int(now * 1000))
                if error:
                    result['error'] = error
                conn.execute('INSERT INTO mutation_receipts(actor_id,mutation_id,target_id,fingerprint,status,response,recorded_at) VALUES (?,?,?,?,?,?,?)',
                             (actor['id'], mutation_id, download_id or 'submission', fingerprint, status,
                              json.dumps(result, separators=(',', ':')), now))
        if dispatch_id:
            _dispatch_download_command(dispatch_id)
    return result, status


def _execute_download_command(download_id, payload, action):
    mutation_id = payload.get('client_mutation_id')
    match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
    if match is None:
        return {'error': 'Invalid mutation identifier'}, 400
    expected = payload.get('expected_revision')
    expected_attempt = payload.get('expected_attempt_id')
    fingerprint = hashlib.sha256(json.dumps(
        ['POST', 'download.' + action, download_id, payload], sort_keys=True,
        ensure_ascii=True, separators=(',', ':'),
    ).encode()).hexdigest()
    dispatch_id = None
    with _file_operation_lock, _worker_condition:
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return {'error': 'Authentication required'}, 401
            row = _tag_visible_row(conn, download_id, actor)
            if (row is None or action in ('stop', 'pause', 'unpause')
                    and row['source_type'] == 'upload'
                    and _authorized_upload(conn, download_id, actor) is None):
                return {'error': 'Unknown download id'}, 404
            receipt = conn.execute('SELECT * FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?',
                                   (actor['id'], mutation_id)).fetchone()
            if receipt is not None:
                if receipt['fingerprint'] != fingerprint:
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                result, status = _command_receipt_state(conn, json.loads(receipt['response'])), receipt['status']
                if result.get('command'):
                    dispatch_id = result['command']['id']
            else:
                if conn.execute("SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ? AND phase != 'done'",
                                (actor['id'], mutation_id)).fetchone():
                    return {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 409
                now = time.time()
                _prune_mutation_receipts(conn, now)
                counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent '
                                      'FROM mutation_receipts WHERE actor_id = ?', (now - 60, actor['id'])).fetchone()
                unresolved = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS "
                                          "(SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
                if counts['total'] + unresolved >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + unresolved >= MUTATION_ACTOR_MINUTE_LIMIT:
                    return {'error': 'Too many mutations; wait before submitting more', 'code': 'mutation_limit'}, 429
                state = _download_command_snapshot(conn, download_id, row)
                status, outcome, error = 202, 'accepted', None
                created = int(match.group(1)) / 1000
                if created < now - MUTATION_REPLAY_SECONDS or created > now + 300:
                    status, outcome, error = 400, 'rejected', 'Mutation identifier expired or clock is incorrect'
                elif not isinstance(expected, str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', expected):
                    status, outcome, error = 400, 'rejected', 'Expected revision must be a decimal string'
                elif 'expected_attempt_id' not in payload or (expected_attempt is not None and not isinstance(expected_attempt, str)):
                    status, outcome, error = 400, 'rejected', 'Expected attempt identity is required'
                elif set(payload) != {'client_mutation_id', 'expected_revision', 'expected_attempt_id'}:
                    status, outcome, error = 400, 'rejected', 'Unsupported command fields'
                elif expected != state['command_revision'] or expected_attempt != state['current_attempt_id']:
                    status, outcome, error = 409, 'conflicted', 'Download attempt changed; review the current work'
                elif conn.execute("SELECT 1 FROM removal_operations WHERE target_id = ? AND phase NOT IN ('done','cleaned')", (download_id,)).fetchone():
                    status, outcome, error = 409, 'rejected', 'Resolve the pending removal before controlling this download'
                elif conn.execute("SELECT 1 FROM download_commands WHERE target_id = ? AND phase IN ('accepted', 'dispatching')", (download_id,)).fetchone():
                    status, outcome, error = 409, 'conflicted', 'An accepted command is still awaiting dispatch'
                elif action in ('pause', 'unpause') and row['source_type'] == 'upload':
                    status, outcome, error = 409, 'rejected', 'Uploads do not support pausing'
                elif action in ('retry', 'resume') and (row['source_type'] != 'download' or row['browser_authenticated']):
                    status, outcome, error = 409, 'rejected', 'Send this source again to start a new attempt'
                elif action in ('retry', 'resume') and (row['status'] not in (TERMINAL_STATUSES if action == 'retry' else ('cancelled', 'interrupted')) or download_id in _live_worker_ids or download_id in _worker_hosts or any(job['id'] == download_id for job in _worker_queue)):
                    status, outcome, error = 409, 'rejected', 'Wait until the current worker has stopped'
                elif action == 'pause' and (row['status'] not in ('starting', 'downloading') or is_cancel_requested(download_id)):
                    status, outcome, error = 409, 'rejected', 'Cannot pause the current worker'
                elif action == 'unpause' and (row['status'] != 'paused' or is_cancel_requested(download_id)):
                    status, outcome, error = 409, 'rejected', 'Cannot unpause the current worker'
                if error is None and action == 'retry':
                    try:
                        _assert_no_pending_rename(dict(row))
                    except OSError:
                        status, outcome, error = 409, 'rejected', 'Resolve the pending file operation before retrying'
                command = None
                if error is None:
                    if action in ('retry', 'resume'):
                        conn.execute("UPDATE downloads SET status = 'starting', progress = '0%', finished_at = NULL, "
                                     "downloaded_bytes = 0, total_bytes = NULL, speed = 0, eta = NULL WHERE id = ?", (download_id,))
                        download_history.record(conn, download_id, new=True)
                    else:
                        conn.execute('UPDATE downloads SET command_revision = command_revision + 1 WHERE id = ?', (download_id,))
                    state = _download_command_snapshot(conn, download_id)
                    dispatch_id = uuid.uuid4().hex
                    conn.execute('INSERT INTO download_commands(id,actor_id,mutation_id,target_id,actor_session_version,action,source_attempt_id,attempt_id,phase,recorded_at) '
                                 "VALUES (?,?,?,?,?,?,?,?,'accepted',?)", (dispatch_id, actor['id'], mutation_id, download_id, actor['session_version'], action, expected_attempt, state['current_attempt_id'], now))
                    if action in ('retry', 'resume'):
                        state['job_id'] = dispatch_id
                    command = {'id': dispatch_id, 'action': 'download.' + action, 'source_attempt_id': expected_attempt,
                               'attempt_id': state['current_attempt_id'], 'job_id': dispatch_id if action in ('retry', 'resume') else None,
                               'status': 'accepted'}
                result = dict(state, id=download_id, command=command,
                              mutation={'id': mutation_id, 'domain': 'download-command', 'revision': state['command_revision'], 'outcome': outcome},
                              server_time=int(now * 1000))
                if error:
                    result['error'] = error
                conn.execute('INSERT INTO mutation_receipts(actor_id,mutation_id,target_id,fingerprint,status,response,recorded_at) VALUES (?,?,?,?,?,?,?)',
                             (actor['id'], mutation_id, download_id, fingerprint, status, json.dumps(result, separators=(',', ':')), now))
        if dispatch_id:
            _dispatch_download_command(dispatch_id)
    return result, status


def _download_command_route(action):
    def decorate(function):
        @wraps(function)
        def wrapped(download_id):
            payload = {}
            if request.is_json:
                payload, error = _read_json_body(4096)
                if error is not None:
                    return error
                if any(field in payload for field in ('client_mutation_id', 'expected_revision')):
                    result, status = _execute_download_command(download_id, payload, action)
                    response = jsonify(result)
                    response.status_code = status
                    response.headers['Cache-Control'] = 'no-store'
                    return response
            # Legacy controls share command serialization and cannot race a
            # durable generation hand-off or re-arm pause after cancellation.
            with _file_operation_lock, _worker_condition:
                with _db_lock, db() as conn:
                    conn.execute('BEGIN IMMEDIATE')
                    actor = _tag_actor(conn)
                    if actor is None:
                        return jsonify({'error': 'Authentication required'}), 401
                    row = _tag_visible_row(conn, download_id, actor)
                    if row is None:
                        return jsonify({'error': 'Unknown download id'}), 404
                    if conn.execute("SELECT 1 FROM removal_operations WHERE target_id = ? AND phase NOT IN ('done','cleaned')", (download_id,)).fetchone():
                        return jsonify({'error': 'Resolve the pending removal before controlling this download'}), 409
                    if 'expected_attempt_id' in payload and payload['expected_attempt_id'] != _download_command_snapshot(conn, download_id, row)['current_attempt_id']:
                        return jsonify({'error': 'Download attempt changed; review the current work'}), 409
                    if conn.execute("SELECT 1 FROM download_commands WHERE target_id = ? AND phase IN ('accepted', 'dispatching')", (download_id,)).fetchone():
                        return jsonify({'error': 'An accepted command is still awaiting dispatch'}), 409
                if action in ('pause', 'unpause') and is_cancel_requested(download_id):
                    return jsonify({'error': 'Cannot pause a stopping worker'}), 409
                result = function(download_id)
                response = app.make_response(result)
                if response.status_code < 300:
                    with _db_lock, db() as conn:
                        conn.execute('UPDATE downloads SET command_revision = command_revision + 1 WHERE id = ?', (download_id,))
                return response
        return wrapped
    return decorate


@app.route('/api/resume/<download_id>', methods=['POST'])
@_download_command_route('resume')
def resume_download(download_id):
    """Restart the worker for a cancelled or interrupted download, keeping the
    same id so yt-dlp's continuedl logic finds and reuses the existing .part
    file."""
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] not in ('cancelled', 'interrupted'):
        return jsonify({"error": f"Cannot resume from status '{entry['status']}'"}), 409
    if entry['source_type'] != 'download':
        return jsonify({'error': 'Send this source again to start a new attempt'}), 409
    if entry.get('browser_authenticated'):
        return jsonify({
            "error": "Fresh browser cookies are required; re-send this page from Firefox",
            "code": "fresh_browser_cookies_required",
        }), 409

    # The conditional write is the ownership hand-off: only its winner may
    # clear stale cancellation state and touch the shared partial files.
    with _cancel_lock:
        claimed = db_claim_download_for_resume(download_id)
        if claimed:
            _cancel_flags.pop(download_id, None)
            _pause_flags.pop(download_id, None)
    if not claimed:
        current = db_get_download(download_id)
        if current is None:
            return jsonify({"error": "Unknown download id"}), 404
        return jsonify({
            "error": f"Cannot resume from status '{current['status']}'"
        }), 409
    enqueue_download(entry['url'], download_id)
    return jsonify({"message": "Resumed", "id": download_id})


@app.route('/api/stop/<download_id>', methods=['POST'])
@_download_command_route('stop')
def stop_download(download_id):
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry.get('source_type') == 'upload':
        result, status = _cancel_upload(download_id, {})
        return jsonify(result), status
    # Stopping a paused download is also valid -- request_cancel() drops the
    # pause flag so the worker wakes up and aborts cleanly.
    if entry['status'] not in ('starting', 'downloading', 'paused'):
        return jsonify({"message": "Download is not active", "status": entry['status']}), 200
    with _worker_condition:
        request_cancel(download_id)
        # A failed URL worker from an earlier release is just as ownerless as
        # an upload awaiting its PUT. Never infer this from row status alone.
        if (download_id not in _live_worker_ids
                and download_id not in _worker_hosts
                and not any(job['id'] == download_id for job in _worker_queue)):
            current = db_get_download(download_id)
            if current and current['status'] in ('starting', 'downloading', 'paused'):
                db_update_download(download_id, status='cancelled', finished_at=time.time())
        # The public row derives its stopping message from the flag, so a late
        # Stop cannot overwrite a terminal result published by the worker.
        event_bus.publish('change', {'reason': 'stop-requested', 'id': download_id})
    return jsonify({"message": "Stop requested", "id": download_id})


@app.route('/api/pause/<download_id>', methods=['POST'])
@_download_command_route('pause')
def pause_download(download_id):
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] not in ('starting', 'downloading'):
        return jsonify({"error": f"Cannot pause from status '{entry['status']}'"}), 409
    request_pause(download_id)
    return jsonify({"message": "Pause requested", "id": download_id})


@app.route('/api/unpause/<download_id>', methods=['POST'])
@_download_command_route('unpause')
def unpause_download(download_id):
    """Wake a paused worker. Distinct from /api/resume, which restarts the
    worker thread for cancelled/interrupted rows -- here the worker is still
    alive, so we just clear the flag and the progress_hook loop exits."""
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] != 'paused':
        return jsonify({"error": f"Cannot unpause from status '{entry['status']}'"}), 409
    clear_pause(download_id)
    return jsonify({"message": "Unpaused", "id": download_id})


@app.route('/api/rename/<download_id>', methods=['POST'])
def rename_download(download_id):
    payload, error = _read_json_body(4096)
    if error is not None:
        return error
    result, status = _execute_rename_mutation(download_id, payload)
    response = jsonify(result)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/remove/<download_id>', methods=['POST'])
def remove_download(download_id):
    payload = {}
    if request.is_json:
        payload, error = _read_json_body(4096)
        if error is not None:
            return error
    elif request.content_length:
        return jsonify({'error': 'Removal requires a JSON object'}), 400
    result, status = _execute_removal_mutation(download_id, payload)
    response = jsonify(result)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/library/clear/preview', methods=['GET'])
@admin_required
def clear_library_preview():
    return _bulk_clear_preview_response('library')


@app.route('/api/library/clear', methods=['POST'])
@admin_required
def clear_library():
    return _bulk_clear_route('library')


def _visible_playable_library_entries(user_id, is_admin):
    allowed_bases = _trusted_download_directories()
    return [entry for entry in db_list_downloads(
        user_id, is_admin=is_admin, statuses=('finished',),
    ) if _playable_library_entry(entry, allowed_bases)]


def _library_response_items(entries):
    readiness = _asset_readiness_many(entries)
    return [
        {**_public_download_entry(entry), 'assets': readiness.get(entry['id'], {})}
        for entry in entries
    ]


@app.route('/api/library-catalog', methods=['GET'])
def get_library_catalog():
    """Playlist editing and member search include videos awaiting rotation."""
    return jsonify(_library_response_items(_visible_playable_library_entries(
        g.current_user['id'], 'admin' in g.current_user['roles'],
    )))


@app.route('/api/library', methods=['GET'])
def get_library():
    user_id = g.current_user['id']
    is_admin = 'admin' in g.current_user['roles']
    with _rotation_lock:
        while True:
            entries, order, _positions = resolve_library_snapshot(
                # None retains the legacy array's created-at tie behavior.
                user_id, is_admin, '', None
            )
            items = _library_response_items(entries)
            if order['kind'] == 'rotation' and _rotation_now() >= order['expires_at']:
                continue
            if request.args.get('include_order') == 'true':
                return jsonify({'items': items, 'order': order})
            return jsonify(items)


@app.route('/api/current-downloads', methods=['GET'])
def get_current_downloads():
    return jsonify([
        _public_download_entry(entry) for entry in db_list_downloads(
            g.current_user['id'], is_admin='admin' in g.current_user['roles'],
            statuses=('starting', 'downloading', 'paused', 'cancelled', 'interrupted'),
        )
    ])


@app.route('/api/history', methods=['GET'])
def get_history():
    try:
        value = _normalize_history_filter(request.args.get('filter', ''))
        page = int(request.args.get('page', '1'))
        page_size = int(request.args.get('page_size', '20'))
        if page < 1 or page_size < 1 or page_size > 100:
            raise ValueError('Page must be positive and page_size between 1 and 100')
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    with db() as conn:
        conn.execute('BEGIN')
        actor = _tag_actor(conn)
        if actor is None:
            return jsonify({'error': 'Authentication required'}), 401
        result = download_history.page(
            conn, actor['id'], 'admin' in actor['roles'],
            _parse_history_filter(value), page, page_size,
        )
        for item in result['items']:
            entry = _tag_visible_row(conn, item['download_id'], actor) if item['download_id'] else None
            entry = dict(entry) if entry is not None else None
            available = bool(entry and _playable_library_entry(entry))
            item['library_id'] = entry['id'] if available and item['status'] == 'finished' else None
            item['media_state'] = ('available' if item['library_id'] else
                                   'removed' if entry is None else 'unavailable')
            latest = conn.execute(
                'SELECT id FROM download_attempts WHERE work_id = '
                '(SELECT work_id FROM download_attempts WHERE id = ?) '
                'ORDER BY started_at DESC, id DESC LIMIT 1', (item['id'],),
            ).fetchone()
            current = bool(latest and latest['id'] == item['id']
                           and entry and entry['id'] not in _live_worker_ids)
            if entry:
                item.update(_download_command_snapshot(conn, entry['id'], entry))
            job = conn.execute("SELECT id FROM download_commands WHERE attempt_id = ? "
                               "AND action IN ('submit', 'retry', 'resume') ORDER BY recorded_at DESC, id DESC LIMIT 1",
                               (item['id'],)).fetchone()
            item['job_id'] = job['id'] if job else None
            item['can_resume'] = bool(current and entry and entry['status'] in ('cancelled', 'interrupted')
                                      and entry['source_type'] == 'download' and not entry['browser_authenticated'])
            item['can_retry'] = bool(current and entry and entry['status'] in TERMINAL_STATUSES
                                     and entry['source_type'] == 'download' and not entry['browser_authenticated'])
    return jsonify(result)


@app.route('/api/clear/preview', methods=['GET'])
@admin_required
def clear_history_preview():
    return _bulk_clear_preview_response('history')


@app.route('/api/clear', methods=['POST'])
@admin_required
def clear_history():
    return _bulk_clear_route('history')


@app.route('/api/retry/<download_id>', methods=['POST'])
@_download_command_route('retry')
def retry_download(download_id):
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({'error': 'Unknown download id'}), 404
    if entry.get('browser_authenticated') or entry['source_type'] != 'download':
        return jsonify({'error': 'Send this source again to start a new attempt'}), 409
    assets = _get_asset_queue()
    try:
        with _file_operation_lock, assets.publication_lock, _worker_condition:
            with db() as conn:
                current = conn.execute('SELECT * FROM downloads WHERE id = ?', (download_id,)).fetchone()
            if (current is None or current['status'] not in TERMINAL_STATUSES
                    or download_id in _live_worker_ids):
                return jsonify({'error': 'Wait until the current worker has stopped'}), 409
            current = dict(current)
            _assert_no_pending_rename(current)
            with _db_lock, db() as conn:
                assets.invalidate([download_id], conn=conn)
            delete_download_artifacts(current, db_get_preferences().get('download_dir', '.'))
            with _db_lock, db() as conn:
                latest = conn.execute('SELECT * FROM downloads WHERE id = ?', (download_id,)).fetchone()
                if (latest is None or latest['status'] not in TERMINAL_STATUSES
                        or latest['filename'] != current['filename']):
                    return jsonify({'error': 'Download changed; review its current state'}), 409
                conn.execute(
                    "UPDATE downloads SET status = 'starting', progress = '0%', "
                    "filename = NULL, finished_at = NULL, downloaded_bytes = 0, "
                    "total_bytes = NULL, filesize = NULL, speed = 0, eta = NULL "
                    "WHERE id = ?", (download_id,),
                )
                # The replacement gets a new source identity on publication.
                conn.execute('DELETE FROM asset_invalidations WHERE download_id=?', (download_id,))
                download_history.record(conn, download_id, new=True)
    except OSError as exc:
        return jsonify({'error': f'Cleanup failed: {exc}'}), 500
    event_bus.publish('change', {'reason': 'retry', 'id': download_id})
    enqueue_download(entry['url'], download_id)
    return jsonify({'id': download_id})


@app.route('/api/duplicates', methods=['GET'])
def get_duplicates():
    return jsonify(_duplicate_groups(
        g.current_user['id'], 'admin' in g.current_user['roles']
    ))


@app.route('/api/duplicates/refresh', methods=['POST'])
def refresh_duplicates():
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO media_hashes(download_id, state) "
            "SELECT id, 'pending' FROM downloads WHERE status = 'finished'"
        )
        conn.execute(
            "UPDATE media_hashes SET state = 'pending', digest = NULL, "
            "byte_size = NULL WHERE download_id IN "
            "(SELECT id FROM downloads WHERE status = 'finished')"
        )
    start_duplicate_backfill()
    _wake_duplicate_backfill()
    event_bus.publish('change', {'reason': 'duplicates'})
    return jsonify({'message': 'Duplicate index refresh started'}), 202


def _playlist_error_response(exc):
    if isinstance(exc, PlaylistNotFound):
        return jsonify({'error': 'Unknown playlist'}), 404
    if isinstance(exc, PlaylistRevisionConflict):
        if exc.args and exc.args[0] == 'completed':
            return jsonify({
                'code': 'playlist_completed',
                'error': 'This playlist is complete. Replay it from the beginning.',
            }), 409
        return jsonify({'error': 'Playlist state changed'}), 409
    return jsonify({'error': str(exc)}), 400


@app.route('/api/playlists', methods=['GET', 'POST'])
def playlist_collection():
    user_id = g.current_user['id']
    is_admin = 'admin' in g.current_user['roles']
    if request.method == 'GET':
        return jsonify(playlists.list_summaries(user_id, is_admin))
    payload, invalid = _read_json_body(2 * 1024 * 1024)
    if invalid is not None:
        return invalid
    if 'client_mutation_id' in payload:
        result, status = _execute_playlist_mutation(payload)
        response = jsonify(result)
        response.status_code = status
        response.headers['Cache-Control'] = 'no-store'
        return response
    try:
        result, status = _execute_legacy_playlist_save(payload)
    except (ValueError, PlaylistNotFound,
            PlaylistRevisionConflict) as exc:
        return _playlist_error_response(exc)
    return jsonify(result), status


@app.route('/api/playlists/<playlist_id>',
           methods=['GET', 'PUT', 'DELETE'])
def playlist_resource(playlist_id):
    user_id = g.current_user['id']
    is_admin = 'admin' in g.current_user['roles']
    try:
        if request.method == 'GET':
            return jsonify(playlists.get(playlist_id, user_id, is_admin))
        if request.method == 'DELETE':
            if request.content_length is not None and request.content_length > 4096:
                return _read_json_body(4096)[1]
            if not request.get_data():
                playlists.delete(playlist_id, user_id)
                return '', 204
            payload, invalid = _read_json_body(4096)
            if invalid is not None:
                return invalid
            if 'client_mutation_id' not in payload:
                playlists.delete(playlist_id, user_id)
                return '', 204
            result, status = _execute_playlist_mutation(payload, playlist_id, 'playlist.delete')
            response = jsonify(result)
            response.status_code = status
            response.headers['Cache-Control'] = 'no-store'
            return response
        payload, invalid = _read_json_body(2 * 1024 * 1024)
        if invalid is not None:
            return invalid
        if 'client_mutation_id' in payload:
            result, status = _execute_playlist_mutation(payload, playlist_id)
            response = jsonify(result)
            response.status_code = status
            response.headers['Cache-Control'] = 'no-store'
            return response
        result, status = _execute_legacy_playlist_save(payload, playlist_id)
        return jsonify(result), status
    except (ValueError, PlaylistNotFound,
            PlaylistRevisionConflict) as exc:
        return _playlist_error_response(exc)


@app.route('/api/playlists/<playlist_id>/items', methods=['POST'])
def playlist_items(playlist_id):
    payload, invalid = _read_json_body(4096)
    if invalid is not None:
        return invalid
    if 'client_mutation_id' in payload:
        result, status = _execute_playlist_mutation(payload, playlist_id, 'playlist.add')
        response = jsonify(result)
        response.status_code = status
        response.headers['Cache-Control'] = 'no-store'
        return response
    try:
        result = playlists.add(
            playlist_id,
            g.current_user['id'],
            payload.get('download_id'),
            'admin' in g.current_user['roles'],
        )
        return jsonify(result)
    except (ValueError, PlaylistNotFound,
            PlaylistRevisionConflict) as exc:
        return _playlist_error_response(exc)


@app.route('/api/playlists/<playlist_id>/progress', methods=['PUT'])
def playlist_progress(playlist_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'A JSON object is required'}), 400
    try:
        playlists.save_progress(
            playlist_id,
            g.current_user['id'],
            payload.get('download_id'),
            payload.get('position_seconds'),
            payload.get('completed'),
            payload.get('write_sequence'),
        )
    except (ValueError, PlaylistNotFound,
            PlaylistRevisionConflict) as exc:
        return _playlist_error_response(exc)
    return '', 204


def _playback_integer(payload, key, minimum, maximum):
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f'{key} must be an integer')
    if value < minimum or value > maximum:
        raise ValueError(f'{key} is outside the allowed range')
    return value


@app.route('/api/playback-sessions', methods=['POST'])
def create_playback_session():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'A JSON object is required'}), 400
    # Preference saves and deadline renewal share this lock, so the accepted
    # starting member always belongs to the generation returned to the caller.
    if payload.get('mode', 'sequential') == 'sequential':
        with _rotation_lock:
            while True:
                response = _create_playback_session(payload)
                if response is not None:
                    return response
    return _create_playback_session(payload)


def _create_playback_session(payload):
    mode = payload.get('mode', 'sequential')
    if mode not in ('sequential', 'shuffle', 'shuffle_clips', 'playlist'):
        return jsonify({'error': 'Unknown playback mode'}), 400
    user_id = g.current_user['id']
    is_admin = 'admin' in g.current_user['roles']
    if mode == 'playlist':
        playlist_id = payload.get('playlist_id')
        start_download_id = payload.get('start_download_id')
        restart = payload.get('restart', False)
        if (not isinstance(playlist_id, str) or not playlist_id
                or len(playlist_id) > 128):
            return jsonify({'error': 'playlist_id is invalid'}), 400
        if start_download_id is not None and (
                not isinstance(start_download_id, str)
                or not start_download_id
                or len(start_download_id) > 128):
            return jsonify({'error': 'start_download_id is invalid'}), 400
        if not isinstance(restart, bool):
            return jsonify({'error': 'restart must be true or false'}), 400
        try:
            (playlist, queue_items, snapshot_ids, entry,
             playlist_position, resume_seconds) = playlists.playback_snapshot(
                playlist_id, user_id, restart, start_download_id, is_admin
            )
        except (ValueError, PlaylistNotFound,
                PlaylistRevisionConflict) as exc:
            return _playlist_error_response(exc)
        if entry is None:
            return '', 204
        progress = playlist.get('progress') or {}
        state_fields = {
            'mode': mode,
            'playlist_id': playlist_id,
            'playlist_revision': playlist['revision'],
            'playlist_order': snapshot_ids,
            'playlist_queue': queue_items,
            'playlist_position': playlist_position,
            'resume_seconds': resume_seconds,
            'progress_sequence': int(progress.get('write_sequence') or 0),
            'page': None,
            'position': None,
        }
        progress_needs_repair = bool(progress) and (
            progress.get('download_id') != entry['id']
            or not math.isclose(
                float(progress.get('position_seconds') or 0),
                float(resume_seconds), abs_tol=0.001,
            )
        )
        if restart or start_download_id is not None or progress_needs_repair:
            state_fields['progress_sequence'] += 1
            try:
                playlists.save_progress(
                    playlist_id, user_id, entry['id'], 0, False,
                    state_fields['progress_sequence'],
                )
            except PlaylistRevisionConflict:
                return jsonify({'error': 'Playlist progress changed'}), 409
    elif mode in ('shuffle', 'shuffle_clips'):
        try:
            minimum_height, minimum_duration = _shuffle_preferences(
                db_get_preferences()
            )
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        selection, metadata_pending = resolve_shuffle_pool(
            user_id, is_admin, minimum_height,
            max(7.5, minimum_duration) if mode == 'shuffle_clips'
            else minimum_duration,
        )
        if not selection:
            if metadata_pending:
                return jsonify({
                    'code': 'shuffle_metadata_pending',
                    'error': 'Older videos are still being prepared for Shuffle.',
                }), 409
            return jsonify({
                'code': 'no_shuffle_candidates',
                'error': (
                    'No videos can supply a valid 5–20 second clip while '
                    'matching your Shuffle preferences. Videos must be at '
                    'least 7.5 seconds long. Change the minimum quality or '
                    'length in Playback settings.'
                    if mode == 'shuffle_clips' else
                    'No videos match your Shuffle preferences. Change the '
                    'minimum quality or length in Playback settings.'
                ),
                'minimum_height': minimum_height,
                'minimum_duration_minutes': minimum_duration // 60,
            }), 409
        entry = _shuffle_choice(selection)
        state_fields = {
            'mode': mode,
            'minimum_height': minimum_height,
            'minimum_duration_seconds': minimum_duration,
            'page': None,
            'position': None,
        }
    else:
        try:
            normalized_filter = _normalize_history_filter(
                payload.get('filter', '')
            )
            _parse_duration_filter(_parse_history_filter(normalized_filter))
            ordering = payload.get('ordering', 'newest')
            if ordering not in PLAYBACK_SESSION_ORDERINGS:
                raise ValueError('Unknown playback ordering')
            page_size = _playback_integer(
                payload, 'page_size', 1, PLAYBACK_SESSION_MAX_PAGE_SIZE
            )
            page = _playback_integer(
                payload, 'page', 0, PLAYBACK_SESSION_MAX_COORDINATE
            )
            position = _playback_integer(
                payload, 'position', 0, page_size - 1
            )
            start_download_id = payload.get('start_download_id')
            if start_download_id is not None and (
                    not isinstance(start_download_id, str)
                    or not start_download_id
                    or len(start_download_id) > 128):
                raise ValueError('start_download_id is invalid')
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400

        selection, order, rotation_positions = resolve_library_snapshot(
            user_id, is_admin, normalized_filter, ordering
        )
        if (payload.get('generation_id') != order['generation_id']
                or (order['kind'] == 'rotation'
                    and 'generation_id' not in payload)):
            return jsonify({
                'code': 'rotation_generation_changed',
                'error': 'Library order changed. Refresh the Library and try Play All again.',
            }), 409
        if order['kind'] == 'rotation' and start_download_id is None:
            return jsonify({'error': 'start_download_id is required for Library rotation'}), 400
        if start_download_id is not None:
            start_index = next(
                (index for index, candidate in enumerate(selection)
                 if str(candidate['id']) == start_download_id),
                None,
            )
            if start_index is None:
                return jsonify({
                    'error': 'The requested starting video is no longer available'
                }), 409
        elif selection:
            requested_index = page * page_size + position
            start_index = requested_index if requested_index < len(selection) else 0
        else:
            return '', 204
        entry = selection[start_index]
        state_fields = {
            'mode': mode,
            'filter': normalized_filter,
            'ordering': ordering,
            'page_size': page_size,
            'page': start_index // page_size,
            'position': start_index % page_size,
            'order': order,
            'rotation_position': rotation_positions.get(str(entry['id'])),
        }

    now = time.monotonic()
    session_id = secrets.token_urlsafe(32)
    state = {
        'session_id': session_id,
        'owner_user_id': user_id,
        **state_fields,
        'current_download_id': str(entry['id']),
        'sequence': 0,
        'last_response': None,
        'last_expected_download_id': None,
        'created_at': now,
        'last_activity': now,
    }
    with _playback_sessions_lock:
        if mode == 'sequential' and _rotation_order_expired(order):
            return None
        _prune_playback_sessions_locked(now)
        owned = sorted(
            (
                candidate for candidate in _playback_sessions.values()
                if candidate['owner_user_id'] == user_id
            ),
            key=lambda candidate: candidate['last_activity'],
        )
        while len(owned) >= PLAYBACK_SESSION_MAX_PER_USER:
            oldest = owned.pop(0)
            _playback_sessions.pop(oldest['session_id'], None)
        _playback_sessions[session_id] = state
    return jsonify(_playback_session_response(state, entry)), 201


def _rotation_order_expired(order):
    return (order['kind'] == 'rotation'
            and _rotation_now() >= order['expires_at'])


def _library_session_step(session_id, expected_download_id, sequence, prepare):
    # Never nest the lifecycle lock inside the lease lock: file checks and
    # renewal must remain independent of lease cleanup and keepalives.
    with _playback_sessions_lock:
        state = _playback_sessions.get(session_id)
        sequential = state is not None and state['mode'] == 'sequential'
    if not sequential:
        return _library_session_step_locked(
            session_id, expected_download_id, sequence, prepare
        )
    with _rotation_lock:
        while True:
            response = _library_session_step_locked(
                session_id, expected_download_id, sequence, prepare
            )
            if response is not None:
                return response


def _library_session_step_locked(session_id, expected_download_id, sequence, prepare):
    """Resolve files outside the lease lock, then atomically reserve or commit."""
    user_id = g.current_user['id']
    is_admin = 'admin' in g.current_user['roles']
    failed_ids = request.get_json().get('failed_download_ids', [])
    if (not isinstance(failed_ids, list) or len(failed_ids) > 10000
            or any(not isinstance(value, str) or not value or len(value) > 128
                   for value in failed_ids)):
        return jsonify({'error': 'failed_download_ids is invalid'}), 400
    failed_ids = set(failed_ids)

    def check_state():
        _prune_playback_sessions_locked(time.monotonic())
        state = _playback_sessions.get(session_id)
        if (state is None or state['owner_user_id'] != user_id
                or state['mode'] == 'playlist'):
            return None, (jsonify({'error': 'Unknown playback session'}), 404)
        if not prepare and sequence == state['sequence']:
            if expected_download_id != state['last_expected_download_id']:
                return None, (jsonify({'error': 'Playback position changed'}), 409)
            state['last_activity'] = time.monotonic()
            return None, jsonify(state['last_response'])
        if (sequence != state['sequence'] + 1
                or expected_download_id != state['current_download_id']):
            return None, (jsonify({'error': 'Playback position changed'}), 409)
        if (prepare and state.get('prepared')
                and state['mode'] != 'sequential'
                and (state['mode'] != 'shuffle_clips'
                     or state['prepared']['item']['id'] not in failed_ids)):
            state['last_activity'] = time.monotonic()
            return None, jsonify(state['prepared'])
        return state, None

    with _playback_sessions_lock:
        state, response = check_state()
        if response is not None:
            return response
        original_state = state
        snapshot = dict(state)

    if snapshot['mode'] in ('shuffle', 'shuffle_clips'):
        selection, metadata_pending = resolve_shuffle_pool(
            user_id, is_admin, snapshot['minimum_height'],
            max(7.5, snapshot['minimum_duration_seconds'])
            if snapshot['mode'] == 'shuffle_clips'
            else snapshot['minimum_duration_seconds'],
        )
        if snapshot['mode'] == 'shuffle_clips':
            selection = [entry for entry in selection
                         if str(entry['id']) not in failed_ids]
        if len(selection) > 1:
            selection = [entry for entry in selection
                         if str(entry['id']) != expected_download_id]
        next_index = None
    else:
        selection, order, rotation_positions = resolve_library_snapshot(
            user_id, is_admin, snapshot['filter'], snapshot['ordering']
        )
        metadata_pending = False
        previous_order = snapshot['order']
        if selection and order['kind'] == 'rotation' and order == previous_order:
            # Keep the last committed deck position even when that member has
            # disappeared. A dense index would skip its surviving successor.
            last_position = snapshot['rotation_position']
            next_index = next((
                index for index, entry in enumerate(selection)
                if rotation_positions[str(entry['id'])] > last_position
            ), 0)
        elif selection and order != previous_order:
            current_index = next((
                index for index, entry in enumerate(selection)
                if str(entry['id']) == expected_download_id
            ), None)
            next_index = ((current_index + 1) % len(selection)
                          if current_index is not None else 0)
        else:
            next_index = ((snapshot['page'] * snapshot['page_size']
                           + snapshot['position'] + 1) % len(selection)
                          if selection else None)

    with _playback_sessions_lock:
        state, response = check_state()
        if response is not None:
            return response
        if state is not original_state:
            return jsonify({'error': 'Unknown playback session'}), 404
        if snapshot['mode'] == 'sequential' and _rotation_order_expired(order):
            # The lease lock can be busy long enough to cross the deadline.
            # Release it before asking the canonical resolver to renew.
            return None
        state['last_activity'] = time.monotonic()
        if not selection:
            if prepare:
                return '', 204
            if metadata_pending:
                return jsonify({
                    'code': 'shuffle_metadata_pending',
                    'error': 'Older videos are still being prepared for Shuffle.',
                }), 409
            if state['mode'] == 'shuffle_clips':
                state.pop('prepared', None)
                return jsonify({
                    'code': 'no_shuffle_clip_candidates',
                    'error': (
                        'No remaining videos can supply a valid 5–20 second '
                        'clip. Retry or change your Shuffle preferences.'
                    ),
                }), 409
            _playback_sessions.pop(session_id, None)
            return '', 204
        if next_index is not None:
            entry = selection[next_index]
        else:
            prepared_id = (state.get('prepared') or {}).get('item', {}).get('id')
            entry = next((entry for entry in selection
                          if str(entry['id']) == prepared_id), None)
            if entry is None:
                entry = _shuffle_choice(selection)
        if prepare:
            response = {
                'session_id': session_id, 'sequence': sequence,
                'prepared': True, 'item': _playback_item(
                    entry, include_source_revision=state['mode'] == 'shuffle_clips',
                ),
            }
            if state['mode'] == 'sequential':
                response['order'] = order
            state['prepared'] = response
            return jsonify(response)
        state.pop('prepared', None)
        if next_index is not None:
            state['page'] = next_index // state['page_size']
            state['position'] = next_index % state['page_size']
        if state['mode'] == 'sequential':
            state['order'] = order
            state['rotation_position'] = rotation_positions.get(str(entry['id']))
        state['current_download_id'] = str(entry['id'])
        state['sequence'] = sequence
        state['last_expected_download_id'] = expected_download_id
        state['last_status'] = 200
        response = _playback_session_response(state, entry)
        state['last_response'] = response
        return jsonify(response)


@app.route('/api/playback-sessions/<session_id>/prepare', methods=['POST'])
def prepare_playback_session(session_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'A JSON object is required'}), 400
    expected_download_id = payload.get('expected_download_id')
    if (not isinstance(expected_download_id, str)
            or not expected_download_id or len(expected_download_id) > 128):
        return jsonify({'error': 'expected_download_id is invalid'}), 400
    try:
        sequence = _playback_integer(
            payload, 'sequence', 1, PLAYBACK_SESSION_MAX_COORDINATE
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    return _library_session_step(
        session_id, expected_download_id, sequence, prepare=True
    )


@app.route('/api/playback-sessions/<session_id>/advance', methods=['POST'])
def advance_playback_session(session_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'A JSON object is required'}), 400
    expected_download_id = payload.get('expected_download_id')
    if (not isinstance(expected_download_id, str)
            or not expected_download_id
            or len(expected_download_id) > 128):
        return jsonify({'error': 'expected_download_id is invalid'}), 400
    try:
        sequence = _playback_integer(
            payload, 'sequence', 1, PLAYBACK_SESSION_MAX_COORDINATE
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    with _playback_sessions_lock:
        state = _playback_sessions.get(session_id)
        library_mode = state is None or state['mode'] != 'playlist'
    if library_mode:
        return _library_session_step(
            session_id, expected_download_id, sequence, prepare=False
        )

    now = time.monotonic()
    user_id = g.current_user['id']
    is_admin = 'admin' in g.current_user['roles']
    with _playback_sessions_lock:
        _prune_playback_sessions_locked(now)
        state = _playback_sessions.get(session_id)
        if state is None or state['owner_user_id'] != user_id:
            return jsonify({'error': 'Unknown playback session'}), 404
        if (sequence == state['sequence']
                and state.get('last_status') == 204):
            if expected_download_id != state['last_expected_download_id']:
                return jsonify({'error': 'Playback position changed'}), 409
            state['last_activity'] = now
            return '', 204
        if sequence == state['sequence'] and state['last_response'] is not None:
            if expected_download_id != state['last_expected_download_id']:
                return jsonify({'error': 'Playback position changed'}), 409
            state['last_activity'] = now
            return jsonify(state['last_response'])
        if sequence != state['sequence'] + 1:
            return jsonify({'error': 'Playback sequence is out of order'}), 409
        if expected_download_id != state['current_download_id']:
            return jsonify({'error': 'Playback position changed'}), 409

        if state['mode'] == 'playlist':
            completed = payload.get('completed', False)
            if not isinstance(completed, bool):
                return jsonify({'error': 'completed must be true or false'}), 400
            try:
                playlist = playlists.get(
                    state['playlist_id'], user_id, is_admin
                )
            except PlaylistNotFound:
                _playback_sessions.pop(session_id, None)
                return jsonify({'error': 'Unknown playback session'}), 404
            if state['playlist_revision'] != playlist['revision']:
                return jsonify({'error': 'Playlist state changed'}), 409
            next_entry = None
            next_position = None
            with db() as conn:
                for position in range(
                        state['playlist_position'] + 1,
                        len(state['playlist_order'])):
                    candidate = _playlist_download_row(
                        conn, state['playlist_order'][position]
                    )
                    if _playlist_download_playable(candidate, user_id, is_admin):
                        next_entry = candidate
                        next_position = position
                        break
            current_progress = playlist.get('progress') or {}
            progress_sequence = int(
                current_progress.get('write_sequence') or 0
            ) + 1
            if next_entry is None:
                if completed:
                    playlists.save_progress(
                        state['playlist_id'], user_id,
                        state['current_download_id'], 0, True,
                        progress_sequence,
                    )
                    state['progress_sequence'] = progress_sequence
                state['sequence'] = sequence
                state['last_expected_download_id'] = expected_download_id
                state['last_status'] = 204
                state['last_activity'] = now
                return '', 204
            playlists.save_progress(
                state['playlist_id'], user_id, next_entry['id'], 0, False,
                progress_sequence,
            )
            state['progress_sequence'] = progress_sequence
            state['playlist_position'] = next_position
            state['resume_seconds'] = 0
            entry = next_entry
        state['current_download_id'] = str(entry['id'])
        state['sequence'] = sequence
        state['last_expected_download_id'] = expected_download_id
        state['last_activity'] = now
        state['last_status'] = 200
        response = _playback_session_response(state, entry)
        state['last_response'] = response
        return jsonify(response)


@app.route('/api/playback-sessions/<session_id>/select', methods=['POST'])
def select_playback_session_item(session_id):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({'error': 'A JSON object is required'}), 400
    expected_download_id = payload.get('expected_download_id')
    selected_download_id = payload.get('download_id')
    if any(not isinstance(value, str) or not value or len(value) > 128
           for value in (expected_download_id, selected_download_id)):
        return jsonify({'error': 'Playback download ids are invalid'}), 400
    try:
        sequence = _playback_integer(
            payload, 'sequence', 1, PLAYBACK_SESSION_MAX_COORDINATE
        )
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400

    now = time.monotonic()
    user_id = g.current_user['id']
    is_admin = 'admin' in g.current_user['roles']
    with _playback_sessions_lock:
        _prune_playback_sessions_locked(now)
        state = _playback_sessions.get(session_id)
        if (state is None or state['owner_user_id'] != user_id
                or state['mode'] != 'playlist'):
            return jsonify({'error': 'Unknown playback session'}), 404
        if sequence == state['sequence'] and state['last_response'] is not None:
            if (expected_download_id != state['last_expected_download_id']
                    or selected_download_id != state.get(
                        'last_selected_download_id')):
                return jsonify({'error': 'Playback position changed'}), 409
            state['last_activity'] = now
            return jsonify(state['last_response'])
        if sequence != state['sequence'] + 1:
            return jsonify({'error': 'Playback sequence is out of order'}), 409
        if expected_download_id != state['current_download_id']:
            return jsonify({'error': 'Playback position changed'}), 409
        try:
            detail = playlists.get(state['playlist_id'], user_id, is_admin)
        except PlaylistNotFound:
            return jsonify({'error': 'Unknown playback session'}), 404
        if detail['revision'] != state['playlist_revision']:
            return jsonify({'error': 'Playlist state changed'}), 409
        state['progress_sequence'] = int(
            (detail.get('progress') or {}).get('write_sequence') or 0
        )
        try:
            selected_position = state['playlist_order'].index(
                selected_download_id
            )
        except ValueError:
            return jsonify({'error': 'Playback position changed'}), 409
        with db() as conn:
            entry = _playlist_download_row(conn, selected_download_id)
        if not _playlist_download_playable(entry, user_id, is_admin):
            return jsonify({'error': 'The selected video is unavailable'}), 409
        state['playlist_position'] = selected_position
        state['current_download_id'] = selected_download_id
        state['sequence'] = sequence
        state['resume_seconds'] = 0
        state['last_expected_download_id'] = expected_download_id
        state['last_selected_download_id'] = selected_download_id
        state['last_activity'] = now
        state['last_status'] = 200
        response = _playback_session_response(state, entry)
        state['last_response'] = response
        return jsonify(response)


@app.route('/api/playback-sessions/<session_id>/keepalive', methods=['POST'])
def keepalive_playback_session(session_id):
    now = time.monotonic()
    with _playback_sessions_lock:
        _prune_playback_sessions_locked(now)
        state = _playback_sessions.get(session_id)
        if (state is None
                or state['owner_user_id'] != g.current_user['id']):
            return jsonify({'error': 'Unknown playback session'}), 404
        state['last_activity'] = now
    return '', 204


@app.route('/api/playback-sessions/<session_id>', methods=['DELETE'])
def release_playback_session(session_id):
    with _playback_sessions_lock:
        state = _playback_sessions.get(session_id)
        if (state is not None
                and state['owner_user_id'] == g.current_user['id']):
            _playback_sessions.pop(session_id, None)
    # Releasing an already-expired lease is intentionally harmless. Returning
    # the same response for foreign IDs also avoids exposing their existence.
    return '', 204


@app.route('/api/visibility/<download_id>', methods=['POST'])
def set_download_visibility(download_id):
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if not _can_manage_download_visibility(entry):
        return jsonify({
            "error": (
                "Only the downloader or an administrator can change "
                "visibility"
            )
        }), 403

    payload = request.get_json(silent=True) or {}
    visibility = payload.get('visibility')
    try:
        changed = db_set_download_visibility(download_id, visibility)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({
        "id": download_id,
        "visibility": visibility,
        "changed": changed,
    })


@app.route('/api/favorite/<download_id>', methods=['POST'])
def set_download_favorite(download_id):
    payload, error = _read_json_body(4096)
    if error is not None:
        return error
    result, status = _execute_favorite_mutation(download_id, payload)
    response = jsonify(result)
    response.status_code = status
    return response


@app.route('/api/view/<download_id>', methods=['POST'])
def record_download_view(download_id):
    entry = _visible_download(download_id)
    if entry is None or entry.get('status') != 'finished':
        return jsonify({"error": "Video is not available"}), 404
    path = entry.get('filename')
    if not path or not os.path.isfile(path):
        return jsonify({"error": "Video is not available"}), 404
    real = os.path.realpath(path)
    if not _is_allowed_download_path(real):
        abort(403)

    view_count = db_increment_view_count(download_id)
    if view_count is None:
        return jsonify({"error": "Video is not available"}), 404
    return jsonify({"id": download_id, "view_count": view_count})


@app.route('/api/client-capabilities', methods=['GET'])
def client_capabilities():
    response = jsonify({
        'mutation_protocol': 1, 'actions': ['tag.add', 'tag.remove', 'favorite.set', 'rename.set', 'preference.set', 'playlist.create', 'playlist.replace', 'playlist.add', 'playlist.delete', 'download.pause', 'download.unpause', 'download.stop', 'download.retry', 'download.resume', 'download.submit', 'upload.register', 'upload.cancel', 'entry.remove', 'history.clear', 'library.clear'],
        'upload_recovery': 1, 'entry_removal': 1, 'bulk_clear': 1,
        'tag_identity_version': TAG_IDENTITY_VERSION,
        'server_time': int(time.time() * 1000),
    })
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/downloads/<download_id>/editable-state', methods=['GET'])
def editable_download_state(download_id):
    with db() as conn:
        conn.execute('BEGIN')
        actor = _tag_actor(conn)
        if actor is None:
            return jsonify({'error': 'Authentication required'}), 401
        row = _tag_visible_row(conn, download_id, actor)
        if row is None:
            return jsonify({'error': 'Unknown download id'}), 404
        result = _tag_snapshot(conn, download_id, row)
        result.update(_favorite_snapshot(conn, download_id, row))
        result.update(_rename_snapshot(conn, download_id, row))
        result.update(_download_command_snapshot(conn, download_id, row))
        result['removal_revision'] = str(row['removal_revision'])
        result['permissions'] = {'tags': True, 'favorite': True, 'rename': row['status'] == 'finished'}
    response = jsonify(result)
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/mutations/<mutation_id>', methods=['GET'])
def mutation_receipt(mutation_id):
    with _file_operation_lock:
        with db() as lookup:
            bulk = lookup.execute('SELECT * FROM bulk_clear_scopes WHERE actor_id = ? AND mutation_id = ?',
                                  (session.get('user_id'), mutation_id)).fetchone()
        if bulk is not None:
            result, status = _recover_bulk_clear_operation(dict(bulk), request_actor=True)
            response = jsonify(result)
            response.status_code = status
            response.headers['Cache-Control'] = 'no-store'
            return response
        with db() as lookup:
            removal = lookup.execute('SELECT * FROM removal_operations WHERE actor_id = ? AND mutation_id = ?',
                                     (session.get('user_id'), mutation_id)).fetchone()
        if removal is not None:
            result, status = _recover_removal_operation(dict(removal), request_actor=True)
            response = jsonify(result)
            response.status_code = status
            response.headers['Cache-Control'] = 'no-store'
            return response
        with db() as lookup:
            pending = lookup.execute("SELECT * FROM rename_operations WHERE actor_id = ? AND mutation_id = ?",
                                     (session.get('user_id'), mutation_id)).fetchone()
        if pending is not None:
            result, status = _recover_rename_operation(dict(pending), request_actor=True)
            response = jsonify(result)
            response.status_code = status
            response.headers['Cache-Control'] = 'no-store'
            return response
        # Serializing recovery behind admitted writes makes expired absence final.
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            actor = _tag_actor(conn)
            if actor is None:
                return jsonify({'error': 'Authentication required'}), 401
            receipt = conn.execute(
                'SELECT target_id, status, response FROM mutation_receipts '
                'WHERE actor_id = ? AND mutation_id = ?', (actor['id'], mutation_id),
            ).fetchone()
            if receipt is not None:
                result = json.loads(receipt['response'])
                if result.get('mutation', {}).get('domain') == 'upload':
                    operation = _authorized_upload(conn, receipt['target_id'], actor)
                    if operation is None:
                        return jsonify({'error': 'Mutation unavailable'}), 404
                    result.update(_upload_result(conn, receipt['target_id']))
                    result['mutation']['revision'] = result['upload']['revision']
                preference_receipt = result.get('mutation', {}).get('domain') == 'preferences' and receipt['target_id'] == 'installation'
                playlist_receipt = result.get('mutation', {}).get('domain') == 'playlist'
                submission_rejection = (result.get('mutation', {}).get('domain') == 'download-submission'
                                        and result.get('id') is None and result.get('job') is None
                                        and result['mutation'].get('outcome') == 'rejected')
                if playlist_receipt:
                    try:
                        result = _authorized_playlist_receipt(conn, result, actor)
                    except PlaylistNotFound:
                        match = MUTATION_ID_PATTERN.fullmatch(mutation_id)
                        final = bool(match and int(match.group(1)) / 1000 < time.time() - MUTATION_REPLAY_SECONDS)
                        response = jsonify({'error': 'Mutation unavailable', 'final': final})
                        response.status_code = 404
                        response.headers['Cache-Control'] = 'no-store'
                        return response
                if not preference_receipt and not playlist_receipt and not submission_rejection and _tag_visible_row(conn, receipt['target_id'], actor) is None:
                    match = MUTATION_ID_PATTERN.fullmatch(mutation_id)
                    final = bool(match and int(match.group(1)) / 1000 < time.time() - MUTATION_REPLAY_SECONDS)
                    return jsonify({'error': 'Mutation unavailable', 'final': final}), 404
                if result.get('mutation', {}).get('domain') in ('download-command', 'download-submission'):
                    result = _command_receipt_state(conn, result)
                if result.get('mutation', {}).get('domain') == 'tags':
                    result['available_tags'] = _tag_vocabulary(conn, actor)
                response = jsonify(result)
                response.status_code = receipt['status']
            else:
                match = MUTATION_ID_PATTERN.fullmatch(mutation_id)
                final = bool(match and int(match.group(1)) / 1000 < time.time() - MUTATION_REPLAY_SECONDS)
                response = jsonify({'error': 'Mutation unavailable', 'final': final})
                response.status_code = 404
        response.headers['Cache-Control'] = 'no-store'
    if receipt is not None and preference_receipt:
        try:
            _reconcile_preference_runtime()
        except Exception:
            app.logger.warning('mutation action=preference.set runtime=pending')
    return response

@app.route('/api/tags/<download_id>', methods=['POST', 'DELETE'])
def download_tags(download_id):
    payload, error = _read_json_body(4096)
    if error is not None:
        return error
    result, status = _execute_tag_mutation(download_id, payload, request.method)
    response = jsonify(result)
    response.status_code = status
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/events')
def events():
    """Server-Sent Events stream. The browser opens one EventSource and we
    push a 'change' event every time a download row is inserted, updated, or
    deleted. The client reacts by re-fetching the Library, Current, and visible History --
    much cheaper than polling every second when nothing is happening.

    Keepalive comments (lines starting with ':') run every ~15s so proxies
    and the browser don't time the connection out during idle periods.
    """
    KEEPALIVE_SECS = 15
    user_id = g.current_user['id']
    session_version = session.get('session_version')

    def stream():
        q = event_bus.subscribe(user_id)
        try:
            # Greet the client so it knows the stream is live; also nudges it
            # to do an initial reconcile against the collection APIs.
            yield "event: ready\ndata: {}\n\n"
            while True:
                try:
                    kind, payload = q.get(timeout=KEEPALIVE_SECS)
                except queue.Empty:
                    # SSE comment line -- ignored by EventSource but keeps the
                    # TCP connection from being reaped by intermediaries.
                    yield ": keepalive\n\n"
                    continue
                if kind == 'assets':
                    user = db_get_user_by_id(user_id)
                    if (user is None or user['suspended']
                            or user['session_version'] != session_version):
                        return
                    entries = []
                    for download_id in (payload or {}).get('ids', [])[:200]:
                        entry = db_get_download(download_id)
                        if (entry is not None and _asset_eligible(entry)
                                and (entry.get('visibility') == 'public'
                                     or entry.get('owner_user_id') == user_id
                                     or 'admin' in user['roles'])):
                            entries.append(entry)
                    payload = {'assets': _asset_readiness_many(entries)}
                if kind == 'maintenance':
                    user = db_get_user_by_id(user_id)
                    if (user is None or user['suspended']
                            or user['session_version'] != session_version):
                        return
                    if 'admin' not in user['roles']:
                        continue
                data = json.dumps(payload or {})
                yield f"event: {kind}\ndata: {data}\n\n"
        finally:
            event_bus.unsubscribe(q)

    resp = Response(stream_with_context(stream()), mimetype='text/event-stream')
    resp.headers['Cache-Control'] = 'no-cache, no-transform'
    resp.headers['X-Accel-Buffering'] = 'no'  # disable proxy buffering (nginx)
    resp.headers['Connection'] = 'keep-alive'
    return resp


def _trusted_download_directories(connection=None):
    """Snapshot trusted roots once, independently of the filenames being checked."""
    if has_request_context() and hasattr(g, 'download_path_bases'):
        return g.download_path_bases
    # Workers capture output_dir before yt-dlp reports a filename. Retaining
    # those roots keeps old media playable after the preference changes, while
    # preventing a corrupted filename from authorizing its own directory.
    with db() if connection is None else nullcontext(connection) as conn:
        preference = conn.execute(
            "SELECT value FROM preferences WHERE key = 'download_dir'"
        ).fetchone()
        rows = conn.execute(
            "SELECT DISTINCT output_dir FROM downloads "
            "WHERE output_dir IS NOT NULL"
        ).fetchall()
    allowed_bases = {os.path.realpath(preference[0] if preference else '.')}
    for (output_dir,) in rows:
        try:
            allowed_bases.add(os.path.realpath(output_dir))
        except (TypeError, ValueError):
            continue
    snapshot = frozenset(allowed_bases)
    if has_request_context():
        g.download_path_bases = snapshot
    return snapshot


def _is_allowed_download_path(path, allowed_bases=None):
    """Confine media and previews to directories captured by download workers."""
    real = os.path.realpath(path)
    if allowed_bases is None:
        allowed_bases = _trusted_download_directories()
    try:
        return any(
            os.path.commonpath([real, base]) == base
            for base in allowed_bases
        )
    except ValueError:
        return False


def _rename_playback_path(entry):
    path = os.path.abspath(entry['filename']) if entry.get('filename') else None
    with db() as conn:
        removals = conn.execute("SELECT * FROM removal_operations WHERE phase NOT IN ('done','cleaned')").fetchall()
        for operation in removals:
            for item in json.loads(operation['artifacts']):
                if path != item['source']:
                    continue
                if _removal_matches(item['anchor'], item['identity']):
                    return item['anchor']
                if operation['phase'] == 'prepared' and _removal_matches(path, item['identity'], pristine=True):
                    return path
                return None
        operations = conn.execute('SELECT * FROM rename_operations WHERE target_id = ? OR source = ? OR destination = ? ORDER BY recorded_at',
                                  (entry['id'], path, path)).fetchall()
    for operation in operations:
        if operation['phase'] == 'done' and _rename_done_superseded(operation, entry):
            continue
        identity = json.loads(operation['identity'])
        if _rename_matches(operation['anchor'], identity):
            return operation['anchor']
        if operation['phase'] == 'prepared' and _rename_matches(operation['source'], identity, pristine=True):
            return operation['source']
        return None
    return entry.get('filename')


@app.route('/api/file/<download_id>', methods=['GET'])
def stream_file(download_id):
    """Serve a finished download for playback or browser download."""
    with _file_operation_lock:
        entry = _visible_download(download_id)
        if entry is None or entry.get('status') != 'finished':
            abort(404)
        path = _rename_playback_path(entry)
        if not path or not os.path.isfile(path):
            abort(404)
        real = os.path.realpath(path)
        if not _is_allowed_download_path(real):
            abort(403)
        # Resolve MIME type for the browser's <video> element. mimetypes.guess_type
        # relies on the OS MIME database, which may lack entries for .webm or .mkv
        # on minimal systems (e.g. Docker, some Linux distros). The hardcoded map
        # below covers every container yt-dlp can produce; the OS lookup is the
        # fallback for anything exotic.
        _MIME_MAP = {
            '.mp4':  'video/mp4',
            '.m4v':  'video/mp4',
            '.webm': 'video/webm',
            '.mkv':  'video/x-matroska',
            '.ogg':  'video/ogg',
            '.ogv':  'video/ogg',
            '.mov':  'video/quicktime',
            '.avi':  'video/x-msvideo',
            '.m4a':  'audio/mp4',
            '.mp3':  'audio/mpeg',
            '.opus': 'audio/ogg; codecs=opus',
            '.flac': 'audio/flac',
            '.wav':  'audio/wav',
        }
        ext = os.path.splitext(entry.get('filename') or real)[1].lower()
        mimetype = _MIME_MAP.get(ext) or mimetypes.guess_type(real)[0] or 'application/octet-stream'
        as_attachment = request.args.get('download') == '1'
        return send_file(
            real,
            mimetype=mimetype,
            conditional=True,
            as_attachment=as_attachment,
            download_name=(entry.get('display_filename') or os.path.basename(entry.get('filename') or real))
            if as_attachment else None,
        )

def _asset_eligible(entry):
    filename = entry.get('filename')
    return bool(
        entry.get('status') == 'finished' and filename
        and (entry.get('source_type') == 'upload'
             or os.path.splitext(filename)[1].lower() in BROWSER_VIDEO_EXTENSIONS)
        and os.path.isfile(filename) and _is_allowed_download_path(filename)
        and all(_is_allowed_download_path(_asset_path(entry, kind))
                for kind in ('thumbnail', 'montage'))
    )


def _asset_path(entry, kind):
    return (_thumbnail_path(entry) if kind == 'thumbnail'
            else _preview_path(entry))


def _generate_asset(kind, source, destination):
    generator = (generate_video_thumbnail if kind == 'thumbnail'
                 else generate_video_preview)
    return generator(source, destination)


def _notify_assets(ids):
    # IDs remain internal until the SSE sender rechecks current authorization.
    event_bus.publish('assets', {'ids': list(ids)[:200]})


def _notify_maintenance():
    event_bus.publish('maintenance', {})


def _asset_delivery_metadata(assets, entry):
    selected = assets.delivery(entry)
    return _public_asset_delivery(entry, selected)


def _public_asset_delivery(entry, selected):
    result = {key: selected.get(key) for key in ('available', 'current', 'identity')}
    result['url'] = (url_for('stream_preview', download_id=entry['id'],
                             asset=selected['identity'])
                     if selected.get('available') else None)
    return result


def _asset_readiness_many(entries):
    entries = list(entries)
    assets = _get_asset_queue()
    result = assets.readiness_many(entries, include_delivery=True)
    for entry in entries:
        if entry['id'] in result:
            state = result[entry['id']]
            state['montage_delivery'] = _public_asset_delivery(entry, state['montage_delivery'])
    return result


def _get_asset_queue():
    global _asset_queue, _asset_queue_db
    with _asset_queue_lock:
        if _asset_queue is None or _asset_queue_db != DB_PATH:
            if _asset_queue is not None:
                _asset_queue.stop()
            _asset_queue = AssetQueue(
                db=db, db_lock=_db_lock, get_entry=db_get_download,
                eligible=_asset_eligible, asset_path=_asset_path,
                generate=_generate_asset,
                versions={'thumbnail': _THUMBNAIL_CACHE_VERSION,
                          'montage': _PREVIEW_CACHE_VERSION},
                notify=_notify_assets, confined=_is_allowed_download_path,
                notify_maintenance=_notify_maintenance,
                legacy_path=lambda entry, kind, version: (
                    (_preview_path(entry, version=version) if version >= 3 else None) if kind == 'montage'
                    else _thumbnail_path(entry, version=version)),
            )
            _asset_queue_db = DB_PATH
        return _asset_queue


def _register_media_assets(download_id):
    # Publication is already committed. Reconciliation closes a missed enqueue
    # after a crash or transient filesystem/database failure.
    try:
        entry = db_get_download(download_id)
        if entry is not None:
            _get_asset_queue().register(entry)
    except (OSError, sqlite3.Error) as error:
        app.logger.warning('Unable to queue previews for %s: %s', download_id, error)


def _asset_demand_owner():
    if 'asset_session_id' not in session:
        session['asset_session_id'] = secrets.token_hex(16)
    return (session.get('user_id'), session.get('session_version'),
            session['asset_session_id'])


@app.route('/api/assets/demand', methods=['POST'])
def asset_demand():
    if request.content_length is not None and request.content_length > 32768:
        return jsonify(error='Asset demand is too large'), 413
    raw = request.stream.read(32769)
    if len(raw) > 32768:
        return jsonify(error='Asset demand is too large'), 413
    try:
        data = json.loads(raw) if request.is_json else None
    except (ValueError, UnicodeDecodeError):
        data = None
    if not isinstance(data, dict):
        return jsonify(error='Expected an asset demand object'), 400
    tab = data.get('tab_id')
    revision = data.get('revision')
    ids = data.get('ids')
    hovered = data.get('hovered_id')
    interaction = data.get('interaction', True)
    if (not isinstance(interaction, bool)
            or not isinstance(tab, str) or not 1 <= len(tab) <= 128
            or not isinstance(revision, int) or isinstance(revision, bool)
            or not 0 <= revision <= 9007199254740991
            or not isinstance(ids, list) or len(ids) > 200
            or any(not isinstance(value, str) or not 1 <= len(value) <= 128
                   for value in ids)
            or len(set(ids)) != len(ids)
            or (hovered is not None
                and (not isinstance(hovered, str) or hovered not in ids))):
        return jsonify(error='Invalid asset demand'), 400
    entries = []
    for download_id in ids:
        entry = _visible_download(download_id)
        if entry is not None and _asset_eligible(entry):
            entries.append(entry)
    accepted_ids = [entry['id'] for entry in entries]
    assets = _get_asset_queue()
    accepted = assets.replace_demand(
        _asset_demand_owner(), tab, revision, accepted_ids,
        hovered if hovered in accepted_ids else None, renew=interaction,
    )
    readiness = {}
    for entry in entries:
        state = assets.register(entry)
        if state:
            state['montage_delivery'] = _asset_delivery_metadata(assets, entry)
        readiness[entry['id']] = state
    return jsonify(assets=readiness, accepted=accepted)


def _stream_cached_asset(download_id, kind):
    # Open the cached file before removal may unlink its owned artifacts.
    with _get_asset_queue().publication_lock:
        return _stream_cached_asset_locked(download_id, kind)


def _stream_cached_asset_locked(download_id, kind):
    entry = _visible_download(download_id)
    if entry is None or entry.get('status') != 'finished':
        abort(404)
    media_path = entry.get('filename')
    if not media_path or not os.path.isfile(media_path):
        abort(404)
    if not _is_allowed_download_path(media_path):
        abort(403)
    path = _asset_path(entry, kind)
    if not path or not _is_allowed_download_path(path):
        abort(403)
    if not _asset_eligible(entry):
        abort(404)
    assets = _get_asset_queue()
    readiness = assets.register(entry)
    if kind not in readiness:
        abort(404)
    identity = None
    if kind == 'montage':
        identity = request.args.get('asset')
        if identity is not None and not re.fullmatch(r'[a-f0-9]{32}', identity):
            abort(404)
        selected = assets.delivery(entry, identity=identity, lease=True)
        if selected.get('available'):
            path = selected['path']
            identity = selected['identity']
        elif identity is not None:
            abort(404)
        else:
            return Response(status=404 if readiness[kind] == 'failed' else 202,
                            headers={'Cache-Control': 'no-store'})
    elif readiness[kind] != 'ready':
        return Response(status=404 if readiness[kind] == 'failed' else 202,
                        headers={'Cache-Control': 'no-store'})
    response = send_file(path, mimetype='image/jpeg' if kind == 'thumbnail' else 'video/mp4',
                         conditional=True, max_age=0,
                         etag=identity if identity else True)
    response.headers['Cache-Control'] = 'private, no-cache'
    return response


@app.route('/api/thumbnail/<download_id>', methods=['GET'])
def stream_thumbnail(download_id):
    """Deliver a cached frame; all missing work belongs to the shared queue."""
    return _stream_cached_asset(download_id, 'thumbnail')


@app.route('/api/preview/<download_id>', methods=['GET'])
def stream_preview(download_id):
    """Deliver a cached montage with ordinary conditional/range semantics."""
    return _stream_cached_asset(download_id, 'montage')


@app.route('/api/preview/<download_id>/lease', methods=['POST'])
def renew_preview_lease(download_id):
    data = request.get_json(silent=True)
    identity = data.get('asset') if isinstance(data, dict) else None
    if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{32}', identity):
        return jsonify(error='Invalid preview identity'), 400
    assets = _get_asset_queue()
    with assets.publication_lock:
        entry = _visible_download(download_id)
        if entry is None or not _asset_eligible(entry):
            abort(404)
        selected = assets.delivery(entry, identity=identity, lease=True)
        if not selected.get('available'):
            abort(404)
    return Response(status=204, headers={'Cache-Control': 'no-store'})


def start_asset_generation():
    return _get_asset_queue().start()


def stop_asset_generation():
    if _asset_queue is not None:
        _asset_queue.stop()


@app.route('/api/system/logs', methods=['GET'])
@admin_required
def system_logs():
    try:
        page = int(request.args.get('page', '1'))
        page_size = int(request.args.get('page_size', '50'))
        snapshot_id = request.args.get('snapshot_id')
        snapshot_id = int(snapshot_id) if snapshot_id is not None else None
        severity = request.args.get('severity', '').lower()
        text = request.args.get('filter', '').strip()
        if (page < 1 or not 1 <= page_size <= 100
                or (snapshot_id is not None and snapshot_id < 0)
                or severity not in ('', 'info', 'warning', 'error')
                or len(text) > 500):
            raise ValueError('Invalid system log filter or pagination')
    except ValueError:
        return jsonify(error='Invalid system log filter or pagination'), 400
    result = _get_asset_queue().system_logs(
        page=page, page_size=page_size, text=text,
        severity=severity, snapshot_id=snapshot_id,
    )
    return jsonify(result)


@app.route('/api/preview-maintenance', methods=['GET'])
@admin_required
def preview_maintenance():
    return jsonify(_get_asset_queue().maintenance_status())


PREFERENCE_FIELDS = frozenset({
    'download_dir', 'format', 'history_page_size', 'max_concurrent', 'player_mode',
    'start_fullscreen', 'theme', 'shuffle_min_height', 'max_concurrent_per_host',
    'max_total_download_mbps', 'shuffle_min_duration_minutes', 'skip_video_edges',
    'library_rotation_enabled', 'library_rotation_hours',
})


class PreferenceValidationError(ValueError):
    def __init__(self, field, message):
        super().__init__(message)
        self.field = field


def _validated_preferences(data):
    if not isinstance(data, dict):
        raise PreferenceValidationError('settings', 'Settings must be an object')
    updates = {key: value for key, value in data.items() if key in PREFERENCE_FIELDS and value is not None}
    for key, label in (('max_concurrent', 'Max concurrent downloads (total)'),
                       ('max_concurrent_per_host', 'Max concurrent downloads per server')):
        if key in data:
            value = data[key]
            if (isinstance(value, bool) or not isinstance(value, (str, int))
                    or not re.fullmatch(r'[0-9]+', str(value)) or len(str(value)) > 9 or int(value) < 1):
                raise PreferenceValidationError(key, f'{label} must be a positive whole number')
            updates[key] = str(int(value))
    if 'max_total_download_mbps' in data:
        try:
            updates['max_total_download_mbps'] = canonical_mbps(data['max_total_download_mbps'])
        except ValueError as error:
            raise PreferenceValidationError('max_total_download_mbps', str(error)) from error
    for key, label in (('skip_video_edges', 'Skip video intro and outro'),
                       ('library_rotation_enabled', 'Library rotation'),
                       ('start_fullscreen', 'Start fullscreen')):
        if key in data:
            value = data[key]
            if isinstance(value, bool):
                updates[key] = 'true' if value else 'false'
            elif isinstance(value, str) and value in {'true', 'false'}:
                updates[key] = value
            else:
                raise PreferenceValidationError(key, f'{label} must be true or false')
    for key, minimum, maximum, message in (
            ('library_rotation_hours', 1, 8760, 'Library rotation hours must be a whole number from 1 through 8760'),
            ('shuffle_min_duration_minutes', 0, 1440, 'Shuffle minimum length must be a whole number from 0 through 1440')):
        if key in data:
            value = data[key]
            digits = str(value).lstrip('0') or '0'
            if (isinstance(value, bool) or not isinstance(value, (str, int))
                    or not re.fullmatch(r'[0-9]+', str(value))
                    or len(digits) > 4 or not minimum <= int(digits) <= maximum):
                raise PreferenceValidationError(key, message)
            updates[key] = str(int(digits))
    if 'history_page_size' in updates:
        updates['history_page_size'] = str(updates['history_page_size'])
        if updates['history_page_size'] not in {'5', '10', '20', '50', 'endless'}:
            raise PreferenceValidationError('history_page_size', 'Videos per page must be 5, 10, 20, 50, or endless')
    if 'shuffle_min_height' in updates:
        value = updates['shuffle_min_height']
        if (isinstance(value, bool) or not isinstance(value, (str, int))
                or not str(value).isascii() or not str(value).isdigit()
                or len(str(value)) > 9 or int(value) not in SHUFFLE_MIN_HEIGHTS):
            raise PreferenceValidationError('shuffle_min_height', 'Shuffle minimum quality is invalid')
        updates['shuffle_min_height'] = str(int(value))
    for key in ('download_dir', 'format', 'player_mode', 'theme'):
        if key in updates and not isinstance(updates[key], str):
            raise PreferenceValidationError(key, 'Setting must be text')
    if not updates:
        raise PreferenceValidationError('settings', 'No valid preference fields provided')
    return updates


def _prepare_preference_directory(updates):
    if 'download_dir' in updates:
        try:
            updates['download_dir'] = _prepare_download_directory(updates['download_dir'])
        except ValueError as error:
            # Filesystem exception details can contain private absolute paths.
            raise PreferenceValidationError('download_dir', 'Download directory is not usable or writable') from error


def _admit_preference_mutation(conn, payload, fingerprint, match):
    actor = _tag_actor(conn)
    if actor is None:
        return {'reply': {'error': 'Authentication required'}, 'status': 401}
    mutation_id = payload['client_mutation_id']
    state = _preference_snapshot(conn)
    receipt = conn.execute('SELECT fingerprint, status, response FROM mutation_receipts WHERE actor_id = ? AND mutation_id = ?',
                           (actor['id'], mutation_id)).fetchone()
    if receipt is not None:
        if receipt['fingerprint'] != fingerprint:
            return {'reply': {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 'status': 409}
        return {'reply': json.loads(receipt['response']), 'status': receipt['status']}
    if conn.execute("SELECT 1 FROM rename_operations WHERE actor_id = ? AND mutation_id = ? AND phase != 'done'",
                    (actor['id'], mutation_id)).fetchone():
        return {'reply': {'error': 'Mutation identifier already used', 'code': 'mutation_id_conflict'}, 'status': 409}
    now = time.time()
    _prune_mutation_receipts(conn, now)
    counts = conn.execute('SELECT COUNT(*) AS total, COALESCE(SUM(recorded_at > ?), 0) AS recent FROM mutation_receipts WHERE actor_id = ?',
                          (now - 60, actor['id'])).fetchone()
    active = conn.execute("SELECT COUNT(*) FROM rename_operations WHERE actor_id = ? AND (phase != 'done' OR NOT EXISTS (SELECT 1 FROM mutation_receipts r WHERE r.actor_id = rename_operations.actor_id AND r.mutation_id = rename_operations.mutation_id))", (actor['id'],)).fetchone()[0]
    if counts['total'] + active >= MUTATION_ACTOR_RECEIPT_LIMIT or counts['recent'] + active >= MUTATION_ACTOR_MINUTE_LIMIT:
        return {'reply': {'error': 'Too many mutations; wait before submitting more', 'code': 'mutation_limit'}, 'status': 429}
    gate = {'actor': actor, 'state': state, 'now': now, 'status': 200,
            'outcome': 'committed', 'error': None, 'field_errors': {}}
    expected = payload.get('expected_revision')
    created = int(match.group(1)) / 1000
    if created < now - MUTATION_REPLAY_SECONDS or created > now + 300:
        gate.update(error='Mutation identifier expired or clock is incorrect', status=400, outcome='rejected')
    elif not isinstance(expected, str) or not re.fullmatch(r'0|[1-9][0-9]{0,18}', expected):
        gate.update(error='Expected revision must be a decimal string', status=400, outcome='rejected')
    elif expected != state['preferences_revision']:
        gate.update(error='Settings changed elsewhere; review current values before saving again', status=409, outcome='conflicted')
    return gate


def _reject_preference_validation(gate, invalid):
    gate.update(error=str(invalid), field_errors={invalid.field: str(invalid)},
                status=400, outcome='rejected')


def _record_preference_result(conn, gate, payload, fingerprint):
    state = gate['state']
    result = dict(state, mutation={'id': payload['client_mutation_id'], 'domain': 'preferences',
                                   'outcome': gate['outcome'], 'revision': state['preferences_revision']},
                  server_time=int(gate['now'] * 1000))
    if gate['error']:
        result.update(error=gate['error'], field_errors=gate['field_errors'])
    conn.execute('INSERT INTO mutation_receipts(actor_id, mutation_id, target_id, fingerprint, status, response, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                 (gate['actor']['id'], payload['client_mutation_id'], 'installation', fingerprint,
                  gate['status'], json.dumps(result, separators=(',', ':')), gate['now']))
    return result, gate['status']


def _execute_preference_mutation(payload):
    mutation_id = payload.get('client_mutation_id')
    match = MUTATION_ID_PATTERN.fullmatch(mutation_id) if isinstance(mutation_id, str) else None
    if match is None:
        return {'error': 'Invalid mutation identifier'}, 400
    fingerprint = hashlib.sha256(json.dumps(
        ['POST', 'preference.set', 'installation', payload.get('values'), payload.get('expected_revision')],
        sort_keys=True, ensure_ascii=True, separators=(',', ':'),
    ).encode()).hexdigest()
    with _worker_condition, _rotation_lock:
        # Check admission before idempotent filesystem preparation. The second
        # transaction repeats every check after that work: raw writers, account
        # changes, clock expiry and shared-domain receipts can race preparation.
        with _db_lock, db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            gate = _admit_preference_mutation(conn, payload, fingerprint, match)
            if 'reply' in gate:
                result, status = gate['reply'], gate['status']
                prepare = False
            else:
                if not gate['error']:
                    try:
                        updates = _validated_preferences(payload.get('values'))
                    except PreferenceValidationError as invalid:
                        _reject_preference_validation(gate, invalid)
                prepare = not gate['error']
                if not prepare:
                    result, status = _record_preference_result(conn, gate, payload, fingerprint)
        if prepare:
            preflight_error = None
            ids = None
            try:
                # mkdir(exist_ok=True) is an idempotent prerequisite: a crash
                # may leave an empty directory, never a playable file or job.
                # Already committed replay returns before this preparation.
                _prepare_preference_directory(updates)
                previous = gate['state']['values']
                rotation_changed = any(key in updates and str(updates[key]) != previous.get(key)
                                       for key in ('library_rotation_enabled', 'library_rotation_hours'))
                enabled = updates.get('library_rotation_enabled', previous.get('library_rotation_enabled')) == 'true'
                ids = _new_rotation_members() if rotation_changed and enabled else None
            except PreferenceValidationError as invalid:
                preflight_error = invalid
            with _db_lock, db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                gate = _admit_preference_mutation(conn, payload, fingerprint, match)
                if 'reply' in gate:
                    result, status = gate['reply'], gate['status']
                else:
                    if not gate['error']:
                        if preflight_error is not None:
                            _reject_preference_validation(gate, preflight_error)
                        else:
                            _write_preferences(conn, updates, gate['state']['values'], ids)
                            gate['state'] = _preference_snapshot(conn)
                    result, status = _record_preference_result(conn, gate, payload, fingerprint)
        # Committed settings and receipts survive controller failure. Resume
        # from current durable values, never an older receipt's captured form.
        if status != 401:
            try:
                _reconcile_preference_runtime()
            except Exception:
                app.logger.warning('mutation action=preference.set runtime=pending')
        if status == 200:
            _publish_metadata_change('preferences')
        return result, status


@app.route('/api/preferences', methods=['GET', 'POST'])
def preferences():
    if request.method == 'GET':
        with db() as conn:
            conn.execute('BEGIN')
            actor = _tag_actor(conn)
            if actor is None:
                return jsonify({'error': 'Authentication required'}), 401
            state = _preference_snapshot(conn)
        return jsonify(dict(state['values'], **state))
    data, invalid = _read_json_body(32768)
    if invalid is not None:
        return invalid
    if 'client_mutation_id' in data or 'expected_revision' in data:
        result, status = _execute_preference_mutation(data)
        return jsonify(result), status
    try:
        updates = _validated_preferences(data)
        _prepare_preference_directory(updates)
    except PreferenceValidationError as invalid:
        return jsonify({'error': str(invalid), 'field_errors': {invalid.field: str(invalid)}}), 400
    if db_set_preferences(updates, request_actor=True) is False:
        return jsonify({'error': 'Authentication required'}), 401
    return jsonify(db_get_preferences())


# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------

init_db()

_ingest_service_lock = threading.Lock()
_ingest_thread = None
_ingest_stop_event = None
_metadata_service_lock = threading.Lock()
_metadata_thread = None
_metadata_stop_event = None
_duplicate_service_lock = threading.Lock()
_duplicate_thread = None
_duplicate_stop_event = None
_duplicate_wake_event = threading.Event()


def _wake_duplicate_backfill():
    _duplicate_wake_event.set()


def _duplicate_backfill(stop_event):
    while not stop_event.is_set():
        try:
            _hash_backfill_once()
        except Exception as exc:
            print(f'VDL duplicate index: backfill failed: {exc}', flush=True)
        _duplicate_wake_event.wait(timeout=30)
        _duplicate_wake_event.clear()


def _requeue_unavailable_hashes():
    """Give prior-process failures one retry when a new worker starts."""
    with _db_lock, db() as conn:
        conn.execute(
            "UPDATE media_hashes SET state = 'pending' "
            "WHERE state = 'unavailable' AND download_id IN "
            "(SELECT id FROM downloads WHERE status = 'finished')"
        )


def start_duplicate_backfill():
    """Run at most one serial hash worker for final library files."""
    global _duplicate_thread, _duplicate_stop_event
    with _duplicate_service_lock:
        if _duplicate_thread is not None and _duplicate_thread.is_alive():
            return _duplicate_thread
        _requeue_unavailable_hashes()
        _duplicate_stop_event = threading.Event()
        _duplicate_thread = threading.Thread(
            target=_duplicate_backfill,
            args=(_duplicate_stop_event,),
            name='vdl-duplicates',
            daemon=True,
        )
        _duplicate_thread.start()
        return _duplicate_thread


def stop_duplicate_backfill():
    global _duplicate_thread, _duplicate_stop_event
    with _duplicate_service_lock:
        thread = _duplicate_thread
        stop_event = _duplicate_stop_event
        _duplicate_thread = None
        _duplicate_stop_event = None
    if stop_event is not None:
        stop_event.set()
        _duplicate_wake_event.set()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=5)


def _metadata_backfill(stop_event):
    """Probe legacy final files serially without holding the database lock."""
    with db() as conn:
        rows = [dict(row) for row in conn.execute(
            "SELECT id, filename FROM downloads "
            "WHERE status = 'finished' AND filename IS NOT NULL "
            "AND media_metadata_probed = 0 ORDER BY created_at"
        ).fetchall()]

    changed = False
    for candidate in rows:
        if stop_event.is_set():
            break
        download_id = candidate['id']
        filename = candidate['filename']
        current = db_get_download(download_id)
        if (current is None or current.get('status') != 'finished'
                or current.get('filename') != filename
                or not os.path.isfile(filename)):
            continue
        real_path = os.path.realpath(filename)
        if not _is_allowed_download_path(real_path):
            continue

        resolution, duration = ffprobe_media_metadata(filename)
        if stop_event.is_set():
            break
        current = db_get_download(download_id)
        if (current is None or current.get('status') != 'finished'
                or current.get('filename') != filename
                or not os.path.isfile(filename)
                or os.path.realpath(filename) != real_path
                or not _is_allowed_download_path(real_path)):
            continue
        with _db_lock, db() as conn:
            updated = conn.execute(
                "UPDATE downloads SET resolution = ?, duration_seconds = ?, "
                "media_metadata_probed = 1 WHERE id = ? AND status = 'finished' "
                "AND filename = ? AND media_metadata_probed = 0",
                (resolution, duration, download_id, filename),
            ).rowcount == 1
        changed = changed or updated
    if changed:
        event_bus.publish('change', {'reason': 'metadata'})


def start_metadata_backfill():
    """Start the one low-priority legacy metadata worker exactly once."""
    global _metadata_thread, _metadata_stop_event
    with _metadata_service_lock:
        if _metadata_thread is not None and _metadata_thread.is_alive():
            return _metadata_thread
        _metadata_stop_event = threading.Event()
        _metadata_thread = threading.Thread(
            target=_metadata_backfill,
            args=(_metadata_stop_event,),
            name='vdl-metadata',
            daemon=True,
        )
        _metadata_thread.start()
        return _metadata_thread


def stop_metadata_backfill():
    """Signal the metadata worker and wait briefly for its bounded probe."""
    global _metadata_thread, _metadata_stop_event
    with _metadata_service_lock:
        thread = _metadata_thread
        stop_event = _metadata_stop_event
        _metadata_thread = None
        _metadata_stop_event = None
    if stop_event is not None:
        stop_event.set()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=5)


def _remove_stale_ingest_partials(directory):
    """Discard unpublished copies left by an interrupted ingest process."""
    pattern = re.compile(r'^\.vdl_[0-9a-f]{8}\..+\.ingest\.part$')
    try:
        with os.scandir(directory) as entries:
            paths = [
                entry.path for entry in entries
                if pattern.fullmatch(entry.name)
                and entry.is_file(follow_symlinks=False)
            ]
    except OSError:
        return
    for path in paths:
        try:
            os.remove(path)
        except OSError:
            pass


def start_ingest_import():
    """Start one optional startup import worker per serving process."""
    global _ingest_thread, _ingest_stop_event
    configured_dir = os.environ.get('VDL_INGEST_DIR', '').strip()
    if not configured_dir:
        return None

    directory = os.path.realpath(os.path.abspath(configured_dir))
    if not os.path.isdir(directory):
        raise RuntimeError(
            f'VDL_INGEST_DIR is not a directory: {configured_dir}'
        )
    if not os.access(directory, os.R_OK | os.X_OK):
        raise RuntimeError(
            f'VDL_INGEST_DIR is not readable: {configured_dir}'
        )
    output_dir = os.path.realpath(os.path.abspath(_prepare_download_directory(
        db_get_preferences().get('download_dir', '.')
    )))
    try:
        _disjoint_ingest_and_output(directory, output_dir)
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc

    with _ingest_service_lock:
        if _ingest_thread is not None:
            return _ingest_thread
        _remove_stale_ingest_partials(output_dir)
        importer = IngestStartupImporter(directory)
        _ingest_stop_event = threading.Event()
        _ingest_thread = threading.Thread(
            target=importer.run,
            args=(_ingest_stop_event,),
            name='vdl-ingest',
            daemon=True,
        )
        _ingest_thread.start()
        return _ingest_thread


def stop_ingest_import():
    """Stop the startup batch if the HTTP server exits before it finishes."""
    global _ingest_thread, _ingest_stop_event
    with _ingest_service_lock:
        thread = _ingest_thread
        stop_event = _ingest_stop_event
        _ingest_thread = None
        _ingest_stop_event = None
    if stop_event is not None:
        stop_event.set()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=5)


def _should_start_ingest_import():
    return (os.environ.get('FLASK_DEBUG', '1') != '1'
            or os.environ.get('WERKZEUG_RUN_MAIN') == 'true')


def _port_number(value):
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError(
            'port must be an integer between 1 and 65535'
        )
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError(
            'port must be an integer between 1 and 65535'
        )
    return port


def parse_startup_args(argv=None):
    parser = argparse.ArgumentParser(
        prog='vdl.py',
        description='Run the VDL server.',
    )
    parser.add_argument(
        '-p', '--port',
        type=_port_number,
        default=os.environ.get('PORT', '5000'),
        metavar='PORT',
        help='port to listen on (default: PORT environment variable or 5000)',
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_startup_args(argv)
    # Environment defaults keep the same image useful in dev and production;
    # an explicit CLI port wins when a one-off launch needs a different bind.
    # threaded=True is required so the long-lived SSE connection on
    # /api/events doesn't block other requests.
    host  = os.environ.get("HOST", "127.0.0.1")
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    # Werkzeug executes main once in its debug parent and again in the serving
    # child. Only the child may own the singleton ingest thread.
    owns_background_work = _should_start_ingest_import()
    ingest_thread = start_ingest_import() if owns_background_work else None
    metadata_thread = start_metadata_backfill() if owns_background_work else None
    duplicate_thread = start_duplicate_backfill() if owns_background_work else None
    if owns_background_work:
        start_asset_generation()
        start_library_storage()
    print(
        f'VDL startup: UI v{APP_VERSION} | API v{APP_VERSION}',
        flush=True,
    )
    previous_sigterm = signal.getsignal(signal.SIGTERM)
    if threading.current_thread() is threading.main_thread():
        # tini forwards SIGTERM; converting it to a normal exit commits the
        # maintenance checkpoint before the process relinquishes its volume.
        signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(0))
    try:
        app.run(host=host, port=args.port, debug=debug, threaded=True)
    finally:
        if threading.current_thread() is threading.main_thread():
            signal.signal(signal.SIGTERM, previous_sigterm)
        if owns_background_work:
            with _rotation_lock:
                _cancel_rotation_timer()
            stop_library_storage()
            stop_asset_generation()
        if ingest_thread is not None:
            stop_ingest_import()
        if metadata_thread is not None:
            stop_metadata_backfill()
        if duplicate_thread is not None:
            stop_duplicate_backfill()


if __name__ == '__main__':
    main()
