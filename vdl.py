import argparse
import base64
import gc
import hashlib
import hmac
import io
import ipaddress

from flask import (
    Flask, Response, abort, g, jsonify, redirect, render_template, request,
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
import secrets
import stat
import tempfile
import unicodedata
from contextlib import contextmanager
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit


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
COMPANION_PACKAGE_VERSION = '1.0.2'
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
        self._subs = set()
        self._lock = threading.Lock()

    def subscribe(self):
        # maxsize keeps a stuck/disconnected client from ballooning memory.
        # If full, we drop the oldest event for that subscriber -- stale clients
        # always reconcile by refetching /api/history on the next event anyway.
        q = queue.Queue(maxsize=64)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def publish(self, kind, payload=None):
        msg = (kind, payload)
        with self._lock:
            subs = list(self._subs)
        for q in subs:
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

# A single lock serialises writes from background threads. SQLite itself is
# safe for concurrent reads, but multiple writers across threads on the same
# connection cause "database is locked" errors. We open a fresh connection
# per operation and guard writes with this lock.
_db_lock = threading.Lock()
_upload_lock = threading.Lock()
# Preview generation opens the source seven times and encodes a new asset.
# Serialising that work keeps a burst of first-time hovers from saturating the
# host while cached previews continue to bypass the lock entirely.
_preview_generation_lock = threading.Lock()
_NO_UPDATE = object()

# Workers wait here before entering yt-dlp. A FIFO queue keeps a burst in
# worker-arrival order while the counter lets preference changes take
# effect without replacing a fixed-size semaphore.
_worker_condition = threading.Condition()
_worker_queue = []
_active_worker_count = 0
# Terminal status is visible before a worker has necessarily unwound its
# yt-dlp stack. Keep that resource-ownership lifetime separate from the slot
# counter so removal cannot unlink a file the worker still has open.
_live_worker_ids = set()


@contextmanager
def db():
    """Yield a sqlite3 connection with row factory; commits on clean exit."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as conn:
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
            CREATE TABLE IF NOT EXISTS ingest_receipts (
                source_path TEXT PRIMARY KEY,
                device      INTEGER NOT NULL,
                inode       INTEGER NOT NULL,
                filesize    INTEGER NOT NULL,
                mtime_ns    INTEGER NOT NULL,
                download_id TEXT NOT NULL,
                ingested_at REAL NOT NULL
            );
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
        ]:
            if col not in existing_cols:
                conn.execute(ddl)
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
            "player_mode": "overlay",
            "start_fullscreen": "false",
            "theme": "system",
        }
        for k, v in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO preferences(key, value) VALUES (?, ?)",
                (k, v),
            )

        # Tags have no independent lifecycle. This also repairs orphan rows
        # left by an interrupted migration or a manually edited database.
        conn.execute(
            "DELETE FROM tags WHERE NOT EXISTS ("
            "SELECT 1 FROM download_tags WHERE tag_id = tags.id)"
        )

        # Any download that was active when the app died is now orphaned.
        # 'paused' counts as active for this purpose -- the worker thread
        # was holding the connection open and is gone now.
        conn.execute(
            "UPDATE downloads SET status = 'interrupted', progress = 'Interrupted' "
            "WHERE status IN ('starting', 'downloading', 'paused')"
        )


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
    event_bus.publish('change', {'reason': 'insert', 'id': download_id})


def db_insert_ingested_video(download_id, source_path, source_signature,
                             upload_name, title, filesize, output_dir,
                             filename, resolution):
    """Atomically register a watched-folder video and its source receipt."""
    now = time.time()
    device, inode, _signature_size, mtime_ns = source_signature
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO downloads("
            "id, url, status, progress, created_at, filename, resolution, "
            "filesize, speed, eta, title, finished_at, output_dir, "
            "requested_filename, downloaded_bytes, total_bytes, source_type"
            ") VALUES (?, '', 'finished', '100%', ?, ?, ?, ?, 0, 0, ?, ?, "
            "?, ?, ?, ?, 'upload')",
            (
                download_id, now, filename, resolution, filesize, title, now,
                output_dir, upload_name, filesize, filesize,
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
    event_bus.publish('change', {'reason': 'insert', 'id': download_id})


def db_get_ingest_receipts(directory):
    """Return source signatures already imported from one watched folder."""
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
        if os.path.dirname(row['source_path']) == directory
    }


def db_prune_ingest_receipts(directory, visible_paths):
    """Forget removed inbox files so a later replacement can be imported."""
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
                       requested_filename=None, downloaded_bytes=None,
                       total_bytes=_NO_UPDATE):
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
    if downloaded_bytes is not None:
        fields.append("downloaded_bytes = ?"); values.append(downloaded_bytes)
    if total_bytes is not _NO_UPDATE:
        fields.append("total_bytes = ?"); values.append(total_bytes)
    if not fields:
        return
    values.append(download_id)
    with _db_lock, db() as conn:
        conn.execute(
            f"UPDATE downloads SET {', '.join(fields)} WHERE id = ?",
            values,
        )
    event_bus.publish('change', {'reason': 'update', 'id': download_id})


def db_claim_download_for_resume(download_id):
    """Move one resumable row to starting, returning whether we won."""
    with _db_lock, db() as conn:
        cur = conn.execute(
            "UPDATE downloads SET status = 'starting', progress = '0%' "
            "WHERE id = ? AND status IN ('cancelled', 'interrupted')",
            (download_id,),
        )
        claimed = cur.rowcount == 1
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
        result["favorite"] = bool(result["favorite"])
        result["quality"] = classify_video_quality(result["resolution"])
        result["tags"] = _db_download_tags(conn, download_id)
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
        event_bus.publish("change", {"reason": "favorite", "id": download_id})
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
        (1080, '1080'),
        (720, '720p'),
        (480, '480p'),
        (360, '360p'),
    ):
        if height >= minimum:
            return label
    return str(height) if height > 0 else None


TAG_MAX_LENGTH = 64


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
        event_bus.publish("change", {"reason": "tag", "id": download_id})
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
        event_bus.publish("change", {"reason": "tag", "id": download_id})
    return tags, changed


def delete_download_artifacts(entry, fallback_dir=None):
    """Delete final and temporary files owned by one download row."""
    candidates = set()
    filename = entry.get("filename")
    if filename:
        # Keep supporting renamed files, whose basename no longer carries the
        # generated download ID used to identify yt-dlp's temporary files.
        candidates.update((filename, filename + ".part", filename + ".ytdl"))

    thumbnail = _thumbnail_path(entry, fallback_dir)
    if thumbnail:
        candidates.add(thumbnail)
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
        except OSError:
            pass

    removed = 0
    # A first-hover request may still be encoding after the UI asks to remove
    # its row. Waiting here prevents that request from publishing an orphaned
    # preview after the artifact scan has already finished.
    with _preview_generation_lock:
        for path in candidates:
            try:
                os.remove(path)
                removed += 1
            except FileNotFoundError:
                # A postprocessor may already have consumed a temporary file.
                pass
    return removed


def db_remove_download_if_inactive(download_id, fallback_dir=None):
    """Atomically remove a non-active, fully stopped download row."""
    with _db_lock, db() as conn:
        row = conn.execute(
            "SELECT * FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        entry = dict(row) if row else None
        with _worker_condition:
            worker_is_live = download_id in _live_worker_ids
        if (entry is None
                or entry['status'] in ('starting', 'downloading', 'paused')
                or worker_is_live):
            return entry, False
        # Keep the row as a retry handle if filesystem cleanup fails. Holding
        # the state lock also prevents Resume from claiming the same partial
        # files while they are being removed.
        delete_download_artifacts(entry, fallback_dir)
        cur = conn.execute(
            "DELETE FROM downloads WHERE id = ? "
            "AND status NOT IN ('starting', 'downloading', 'paused')",
            (download_id,),
        )
        removed = cur.rowcount == 1
    if removed:
        event_bus.publish('change', {'reason': 'delete', 'id': download_id})
    return entry, removed


def db_clear_history():
    placeholders = ",".join("?" * len(HISTORY_STATUSES))
    fallback_dir = db_get_preferences().get("download_dir", ".")
    with _db_lock, db() as conn:
        entries = [
            dict(r) for r in conn.execute(
                f"SELECT id, filename, output_dir FROM downloads WHERE status IN ({placeholders})",
                HISTORY_STATUSES,
            ).fetchall()
        ]
        # If any file cannot be removed, retain all rows so the user can retry
        # instead of losing the only record of the remaining artifacts.
        files_deleted = sum(
            delete_download_artifacts(entry, fallback_dir) for entry in entries
        )
        cur = conn.execute(
            f"DELETE FROM downloads WHERE status IN ({placeholders})",
            HISTORY_STATUSES,
        )
        rows = cur.rowcount
    if rows:
        event_bus.publish('change', {'reason': 'clear', 'count': rows})
    return rows, files_deleted


def db_list_downloads(user_id=None, is_admin=False):
    with db() as conn:
        visibility_sql = ""
        values = ()
        if user_id is not None and not is_admin:
            visibility_sql = (
                "WHERE downloads.visibility = 'public' "
                "OR downloads.owner_user_id = ? "
            )
            values = (user_id,)
        rows = conn.execute(
            "SELECT downloads.id, url, status, progress, "
            "downloads.created_at, "
            "filename, resolution, filesize, speed, eta, title, finished_at, "
            "formats, requested_format, downloaded_bytes, total_bytes, favorite, "
            "view_count, "
            "source_type, owner_user_id, visibility, browser_authenticated, "
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
            "SELECT download_tags.download_id, tags.name "
            "FROM download_tags "
            "JOIN tags ON tags.id = download_tags.tag_id "
            "ORDER BY tags.name COLLATE NOCASE, tags.name"
        ):
            tags_by_download.setdefault(row["download_id"], []).append(
                row["name"]
            )
        for download in downloads:
            download["favorite"] = bool(download["favorite"])
            download["browser_authenticated"] = bool(
                download["browser_authenticated"]
            )
            download["quality"] = classify_video_quality(
                download["resolution"]
            )
            download["tags"] = tags_by_download.get(download["id"], [])
            download["can_manage_visibility"] = (
                is_admin or download["owner_user_id"] == user_id
            )
            # The stable account id is an authorization detail; clients only
            # need the display name and this derived capability.
            download.pop("owner_user_id")
        return downloads


def db_get_preferences():
    with db() as conn:
        rows = conn.execute("SELECT key, value FROM preferences").fetchall()
        return {r["key"]: r["value"] for r in rows}


def db_set_preferences(updates: dict):
    with _db_lock, db() as conn:
        for k, v in updates.items():
            conn.execute(
                "INSERT INTO preferences(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, str(v)),
            )
    if "max_concurrent" in updates:
        with _worker_condition:
            _worker_condition.notify_all()


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
        actual = hashlib.sha256(COMPANION_XPI_PATH.read_bytes()).hexdigest()
    except (OSError, ValueError):
        return None
    if not hmac.compare_digest(actual, expected):
        return None
    return {
        'version': COMPANION_PACKAGE_VERSION,
        'url': '/browser-extension/vdl-companion-firefox.xpi',
        'sha256': actual,
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
    raw = 'VDL1-' + _b64url(secrets.token_bytes(16))
    now = time.time()
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
                "extension_request_id = ? WHERE id = ?",
                (request_id, row['id']),
            )
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
            password_hash = generate_password_hash(
                _validated_password(password)
            )
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
        return _public_user(_db_user(conn, "id = ?", (user_id,)))


def db_delete_user(user_id):
    with _db_lock, db() as conn:
        user = _db_user(conn, "id = ?", (user_id,))
        if user is None:
            return False
        if ('admin' in user['roles']
                and not _db_other_active_admin_exists(conn, user_id)):
            raise ValueError('At least one active administrator is required')
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
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
        _worker_condition.notify_all()


def is_cancel_requested(download_id):
    with _cancel_lock:
        return _cancel_flags.get(download_id, False)


def clear_cancel(download_id):
    with _cancel_lock:
        _cancel_flags.pop(download_id, None)


def request_pause(download_id):
    with _cancel_lock:
        _pause_flags[download_id] = True


def is_pause_requested(download_id):
    with _cancel_lock:
        return _pause_flags.get(download_id, False)


def clear_pause(download_id):
    with _cancel_lock:
        _pause_flags.pop(download_id, None)


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


def _configured_worker_limit():
    value = db_get_preferences().get("max_concurrent", "3")
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 3


def _acquire_worker_slot(download_id):
    global _active_worker_count

    ticket = object()
    with _worker_condition:
        _worker_queue.append(ticket)
        try:
            while True:
                if is_cancel_requested(download_id):
                    return False
                if (_worker_queue[0] is ticket
                        and _active_worker_count < _configured_worker_limit()):
                    _worker_queue.pop(0)
                    _active_worker_count += 1
                    _worker_condition.notify_all()
                    return True
                _worker_condition.wait()
        finally:
            if ticket in _worker_queue:
                _worker_queue.remove(ticket)
                _worker_condition.notify_all()


def _release_worker_slot():
    global _active_worker_count

    with _worker_condition:
        _active_worker_count -= 1
        _worker_condition.notify_all()


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


def background_download(url, download_id, cookie_bundle=None):
    with _worker_condition:
        _live_worker_ids.add(download_id)
    try:
        return _background_download(url, download_id, cookie_bundle)
    finally:
        # Fragment downloaders can retain their locked destination stream in a
        # progress-hook reference cycle when cancellation skips normal cleanup.
        # Finalize those unreachable objects before Remove may unlink the file.
        gc.collect()
        with _worker_condition:
            _live_worker_ids.discard(download_id)
            _worker_condition.notify_all()


def _background_download(url, download_id, cookie_bundle=None):
    sensitive_values = tuple(
        secret
        for cookie in (cookie_bundle or ()) if isinstance(cookie, dict)
        for secret in (cookie.get('name', ''), cookie.get('value', ''))
        if secret
    )
    cookie_buffer = None
    prefs = db_get_preferences()
    output_dir = prefs.get("download_dir", ".")
    try:
        output_dir = _prepare_download_directory(output_dir)
    except ValueError as exc:
        db_update_download(
            download_id,
            status='error',
            progress=str(exc),
            finished_at=time.time(),
        )
        clear_cancel(download_id)
        clear_pause(download_id)
        return
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

    if not _acquire_worker_slot(download_id):
        db_update_download(download_id, status='cancelled', finished_at=time.time())
        clear_cancel(download_id)
        clear_pause(download_id)
        return

    if cookie_bundle is not None:
        try:
            cookie_buffer = _cookies_to_netscape(cookie_bundle)
            cookie_bundle = None
        except Exception as exc:
            db_update_download(
                download_id, status='error',
                progress=_redact_sensitive_text(exc, sensitive_values),
                finished_at=time.time(),
            )
            clear_cancel(download_id)
            clear_pause(download_id)
            _release_worker_slot()
            return

    # A Continue action starts a new worker, so its in-memory filter is gone.
    # The last persisted ETA is a much safer baseline than yt-dlp's first
    # throughput sample while the resumed connection is still warming up.
    if entry:
        _seed_eta_estimate(download_id, entry.get('eta'))

    try:
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
        try:
            probe_opts = with_cookie_options({
                'quiet': True,
                'noprogress': True,
                'skip_download': True,
                'progress_hooks': [lambda d: progress_hook(d, download_id)],
            })
            with yt_dlp.YoutubeDL(probe_opts) as probe:
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
        try:
            with yt_dlp.YoutubeDL(build_opts(fmt)) as ydl:
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
            with yt_dlp.YoutubeDL(build_opts(best_id)) as ydl:
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
                thumbnail_path = _thumbnail_path(entry, output_dir)
                if thumbnail_path:
                    generate_video_thumbnail(final_path, thumbnail_path)
                db_update_download(
                    download_id,
                    status='finished',
                    progress='100%',
                    filename=final_path,
                    filesize=os.path.getsize(final_path),
                    resolution=final_res,
                    speed=0.0,
                    eta=0,
                    finished_at=time.time(),
                )
            else:
                raise FileNotFoundError(
                    'Download completed but the final output file is missing'
                )
    except DownloadCancelled:
        db_update_download(download_id, status='cancelled', finished_at=time.time())
    except yt_dlp.utils.DownloadError as e:
        if is_cancel_requested(download_id):
            db_update_download(download_id, status='cancelled', finished_at=time.time())
        else:
            db_update_download(
                download_id, status='error',
                progress=_redact_sensitive_text(e, sensitive_values),
                finished_at=time.time(),
            )
    except Exception as e:
        db_update_download(
            download_id, status='error',
            progress=_redact_sensitive_text(e, sensitive_values),
            finished_at=time.time(),
        )
    finally:
        if cookie_buffer is not None:
            cookie_buffer.close()
        clear_cancel(download_id)
        clear_pause(download_id)
        _clear_progress_estimate(download_id)
        _clear_eta_estimate(download_id)
        _release_worker_slot()


def ffprobe_resolution(path):
    """Return e.g. '1080p' for the first video stream in `path`, or None."""
    try:
        out = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=height', '-of', 'csv=p=0', path],
            capture_output=True, text=True, timeout=10,
        )
        h = out.stdout.strip()
        if h.isdigit() and int(h) > 0:
            return f"{int(h)}p"
    except Exception:
        pass
    return None


def inspect_uploaded_video(path):
    """Validate an upload with ffprobe and return its optional resolution."""
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=height', '-of', 'json', path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            'ffprobe is required to validate uploaded videos'
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ValueError('The uploaded video could not be inspected') from exc
    except OSError as exc:
        raise RuntimeError(
            f'Unable to inspect the uploaded video: {exc}'
        ) from exc

    try:
        streams = json.loads(result.stdout or '{}').get('streams') or []
    except (AttributeError, json.JSONDecodeError) as exc:
        raise ValueError('The uploaded file is not a supported video') from exc
    if result.returncode != 0 or not streams:
        raise ValueError('The uploaded file does not contain a video stream')

    height = streams[0].get('height')
    try:
        height = int(height)
    except (TypeError, ValueError):
        height = 0
    return f'{height}p' if height > 0 else None


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


class IngestSourceChanged(Exception):
    """The watched source stopped matching the settled scan candidate."""


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


def _ingest_watched_file(source_path, expected_signature):
    """Copy one settled inbox file into the library without publishing early."""
    source_path = os.path.abspath(source_path)
    original_name = _validated_upload_filename(os.path.basename(source_path))
    output_dir = os.path.abspath(_prepare_download_directory(
        db_get_preferences().get('download_dir', '.')
    ))
    if os.path.realpath(output_dir) == os.path.dirname(source_path):
        raise ValueError(
            'The ingest folder and download directory must be different'
        )

    download_id = str(uuid.uuid4())[:8]
    title = os.path.splitext(original_name)[0] or original_name
    temporary_path = None
    final_path = None
    registered = False
    received = 0
    descriptor = None
    try:
        flags = os.O_RDONLY
        if hasattr(os, 'O_NOFOLLOW'):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(source_path, flags)
        with os.fdopen(descriptor, 'rb') as source:
            descriptor = None
            if _ingest_signature(os.fstat(source.fileno())) != expected_signature:
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
                    received += len(chunk)
                temporary.flush()
            if _ingest_signature(os.fstat(source.fileno())) != expected_signature:
                raise IngestSourceChanged()

        if received != expected_signature[2]:
            raise IngestSourceChanged()
        if _source_signature(source_path) != expected_signature:
            raise IngestSourceChanged()
        resolution = inspect_uploaded_video(temporary_path)
        # ffprobe is bounded, but a host writer can still resume while it runs.
        # A final comparison prevents that changed source from being published.
        if _source_signature(source_path) != expected_signature:
            raise IngestSourceChanged()

        with _upload_lock:
            final_path = _reserve_upload_path(output_dir, original_name)
            os.replace(temporary_path, final_path)
            temporary_path = None

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
        )
        registered = True
        print(
            f'VDL ingest: added {original_name!r} as {download_id}',
            flush=True,
        )
        return download_id
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


class IngestFolderWatcher:
    """Periodically reconcile a flat drop folder into the video library."""

    def __init__(self, directory, scan_seconds=10.0, settle_seconds=60.0):
        self.directory = os.path.realpath(directory)
        self.scan_seconds = scan_seconds
        self.settle_seconds = settle_seconds
        self._candidates = {}

    @staticmethod
    def _eligible_name(name):
        lowered = name.lower()
        return (
            not name.startswith('.')
            and not lowered.endswith(_INGEST_TEMP_SUFFIXES)
        )

    def scan_once(self, now=None):
        """Observe candidates once and import only settled regular files."""
        now = time.monotonic() if now is None else now
        receipts = db_get_ingest_receipts(self.directory)
        visible_paths = set()
        try:
            with os.scandir(self.directory) as entries:
                for entry in entries:
                    if not self._eligible_name(entry.name):
                        continue
                    try:
                        metadata = entry.stat(follow_symlinks=False)
                    except (FileNotFoundError, OSError):
                        continue
                    if not stat.S_ISREG(metadata.st_mode):
                        continue

                    path = os.path.join(self.directory, entry.name)
                    signature = _ingest_signature(metadata)
                    visible_paths.add(path)
                    if receipts.get(path) == signature:
                        self._candidates.pop(path, None)
                        continue

                    candidate = self._candidates.get(path)
                    if candidate is None or candidate['signature'] != signature:
                        self._candidates[path] = {
                            'signature': signature,
                            'stable_since': now,
                            'observations': 1,
                            'failed': False,
                        }
                        continue

                    candidate['observations'] += 1
                    if (
                        candidate['failed']
                        or candidate['observations'] < 3
                        or now - candidate['stable_since'] < self.settle_seconds
                    ):
                        continue

                    try:
                        _ingest_watched_file(path, signature)
                    except IngestSourceChanged:
                        # The next scan starts a fresh quiet period from a new
                        # stat instead of treating a racing writer as an error.
                        self._candidates.pop(path, None)
                    except Exception as exc:
                        # A malformed movie should not be copied and probed on
                        # every pass. A modification or restart makes it
                        # eligible again after the operator fixes the source.
                        candidate['failed'] = True
                        print(
                            f'VDL ingest: could not add {entry.name!r}: {exc}',
                            flush=True,
                        )
                    else:
                        self._candidates.pop(path, None)
        except OSError as exc:
            print(
                f'VDL ingest: unable to scan {self.directory!r}: {exc}',
                flush=True,
            )
            return

        for path in set(self._candidates).difference(visible_paths):
            self._candidates.pop(path, None)
        db_prune_ingest_receipts(self.directory, visible_paths)

    def run(self, stop_event):
        while not stop_event.is_set():
            try:
                self.scan_once()
            except Exception as exc:
                # One DB or filesystem failure must not permanently kill the
                # only reconciliation thread.
                print(f'VDL ingest: scan failed: {exc}', flush=True)
            stop_event.wait(self.scan_seconds)


def _thumbnail_path(entry, fallback_dir=None):
    """Return the stable sidecar path for one download's generated preview."""
    directory = entry.get('output_dir')
    if not directory and entry.get('filename'):
        directory = os.path.dirname(os.path.abspath(entry['filename']))
    if not directory:
        directory = fallback_dir
    if not directory:
        return None
    return os.path.join(
        os.path.abspath(directory),
        f".vdl_{entry['id']}.thumbnail.jpg",
    )


_PREVIEW_CACHE_VERSION = 3
_PREVIEW_FRAMES_PER_SECOND = 12


def _preview_path(entry, fallback_dir=None):
    """Return the stable sidecar path for one download's hover preview."""
    directory = entry.get('output_dir')
    if not directory and entry.get('filename'):
        directory = os.path.dirname(os.path.abspath(entry['filename']))
    if not directory:
        directory = fallback_dir
    if not directory:
        return None
    return os.path.join(
        os.path.abspath(directory),
        f".vdl_{entry['id']}.preview-v{_PREVIEW_CACHE_VERSION}.mp4",
    )


def generate_video_thumbnail(media_path, thumbnail_path):
    """Extract a compact preview frame without making download success depend on it."""
    for seek_time in ('1', '0'):
        temporary_path = (
            f"{thumbnail_path}.{uuid.uuid4().hex}.tmp.jpg"
        )
        try:
            result = subprocess.run(
                [
                    'ffmpeg', '-v', 'error', '-ss', seek_time, '-i', media_path,
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


_PREVIEW_SEGMENT_COUNT = 7
_PREVIEW_SEGMENT_SECONDS = 3.0
_PREVIEW_TOTAL_SECONDS = _PREVIEW_SEGMENT_COUNT * _PREVIEW_SEGMENT_SECONDS
_PREVIEW_EDGE_MARGIN_SECONDS = 5.0


def ffprobe_video_duration(path):
    """Return a finite duration for the first video stream, or None."""
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error', '-select_streams', 'v:0',
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
        value = (data.get('format') or {}).get('duration')
        if value is None:
            value = streams[0].get('duration')
        duration = float(value)
        if math.isfinite(duration) and duration > 0:
            return duration
    except (OSError, subprocess.SubprocessError, TypeError, ValueError,
            json.JSONDecodeError):
        pass
    return None


def _preview_segments(duration):
    """Return equally spaced (start, length) excerpts for a hover preview."""
    interior_duration = duration - (2 * _PREVIEW_EDGE_MARGIN_SECONDS)
    if interior_duration <= 0:
        return []
    if interior_duration < _PREVIEW_TOTAL_SECONDS:
        return [(_PREVIEW_EDGE_MARGIN_SECONDS, interior_duration)]
    last_start = (
        duration
        - _PREVIEW_EDGE_MARGIN_SECONDS
        - _PREVIEW_SEGMENT_SECONDS
    )
    spacing = (
        last_start - _PREVIEW_EDGE_MARGIN_SECONDS
    ) / (_PREVIEW_SEGMENT_COUNT - 1)
    return [
        (
            _PREVIEW_EDGE_MARGIN_SECONDS + spacing * index,
            _PREVIEW_SEGMENT_SECONDS,
        )
        for index in range(_PREVIEW_SEGMENT_COUNT)
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
    command = ['ffmpeg', '-v', 'error']
    for start, length in segments:
        command.extend([
            '-ss', f'{start:.3f}',
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
        '-c:v', 'libx264',
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
                and os.path.getsize(temporary_path) > 0):
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
    response = send_file(
        COMPANION_XPI_PATH,
        mimetype='application/x-xpinstall',
        as_attachment=False,
        download_name=COMPANION_XPI_NAME,
        conditional=False,
    )
    response.headers['Content-Disposition'] = (
        f'inline; filename="{COMPANION_XPI_NAME}"'
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
        thread = threading.Thread(
            target=background_download,
            args=(canonical_url, row['id'], cookies),
            daemon=True,
        )
        thread.start()
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
    data = request.json or {}
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

    thread = threading.Thread(target=background_download, args=(url, download_id))
    thread.daemon = True
    thread.start()

    return jsonify({"message": "Download started", "id": download_id})


@app.route('/api/upload', methods=['POST'])
def start_video_upload():
    """Register a dropped video so it is visible before transfer begins."""
    data = request.get_json(silent=True) or {}
    try:
        original_name = _validated_upload_filename(data.get('filename'))
        filesize = data.get('filesize')
        if (isinstance(filesize, bool) or not isinstance(filesize, int)
                or filesize <= 0):
            raise ValueError('Uploaded video size must be a positive integer')
        output_dir = _prepare_download_directory(
            db_get_preferences().get('download_dir', '.')
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    download_id = str(uuid.uuid4())[:8]
    output_dir = os.path.abspath(output_dir)
    title = os.path.splitext(original_name)[0] or original_name
    try:
        db_insert_upload(
            download_id,
            original_name,
            title,
            filesize,
            output_dir,
            g.current_user['id'],
            g.current_user['username'],
        )
    except sqlite3.Error:
        return jsonify({"error": "Unable to start the video upload"}), 500
    return jsonify({
        "message": "Video upload registered",
        "id": download_id,
    }), 202


@app.route('/api/upload/<download_id>', methods=['PUT'])
def receive_video_upload(download_id):
    """Stream one registered upload to disk while publishing byte progress."""
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown upload id"}), 404
    if entry.get('source_type') != 'upload':
        return jsonify({"error": "Entry is not a local upload"}), 409
    if entry.get('status') != 'starting':
        return jsonify({
            "error": f"Cannot upload from status '{entry.get('status')}'"
        }), 409

    with _worker_condition:
        if download_id in _live_worker_ids:
            return jsonify({"error": "Upload is already active"}), 409
        _live_worker_ids.add(download_id)

    original_name = entry.get('requested_filename')
    expected_size = int(entry.get('total_bytes') or 0)
    output_dir = entry.get('output_dir')
    temporary_path = None
    final_path = None
    registered = False
    received = 0
    try:
        if is_cancel_requested(download_id):
            raise DownloadCancelled()
        output_dir = os.path.abspath(_prepare_download_directory(output_dir))
        db_update_download(
            download_id,
            status='downloading',
            progress='0%',
            downloaded_bytes=0,
            total_bytes=expected_size,
        )
        with tempfile.NamedTemporaryFile(
                mode='wb', dir=output_dir,
                prefix=f'.vdl_{download_id}.', suffix='.upload.part',
                delete=False) as temporary:
            temporary_path = temporary.name
            while True:
                if is_cancel_requested(download_id):
                    raise DownloadCancelled()
                chunk = request.stream.read(1024 * 1024)
                if not chunk:
                    break
                received += len(chunk)
                if received > expected_size:
                    raise ValueError('Uploaded video is larger than declared')
                temporary.write(chunk)
                percent = (received / expected_size) * 100
                db_update_download(
                    download_id,
                    status='downloading',
                    progress=f'{percent:.1f}%',
                    downloaded_bytes=received,
                    total_bytes=expected_size,
                )

        if is_cancel_requested(download_id):
            raise DownloadCancelled()
        if received != expected_size:
            raise ValueError('Uploaded video ended before all bytes arrived')
        try:
            resolution = inspect_uploaded_video(temporary_path)
        except ValueError as exc:
            db_update_download(
                download_id, status='error', progress=str(exc),
                finished_at=time.time(),
            )
            return jsonify({"error": str(exc)}), 415
        except RuntimeError as exc:
            db_update_download(
                download_id, status='error', progress=str(exc),
                finished_at=time.time(),
            )
            return jsonify({"error": str(exc)}), 503

        if is_cancel_requested(download_id):
            raise DownloadCancelled()

        with _upload_lock:
            final_path = _reserve_upload_path(output_dir, original_name)
            os.replace(temporary_path, final_path)
            temporary_path = None
        if is_cancel_requested(download_id):
            raise DownloadCancelled()

        db_update_download(
            download_id,
            status='finished',
            progress='100%',
            filename=final_path,
            filesize=received,
            resolution=resolution,
            speed=0.0,
            eta=0,
            finished_at=time.time(),
            downloaded_bytes=received,
            total_bytes=received,
        )
        registered = True
        return jsonify({
            "message": "Video added to library",
            "id": download_id,
            "filename": os.path.basename(final_path),
        })
    except DownloadCancelled:
        db_update_download(
            download_id,
            status='cancelled',
            progress='Cancelled',
            downloaded_bytes=received,
            total_bytes=expected_size,
            finished_at=time.time(),
        )
        return jsonify({"error": "Upload cancelled"}), 409
    except ValueError as exc:
        db_update_download(
            download_id, status='error', progress=str(exc),
            downloaded_bytes=received, total_bytes=expected_size,
            finished_at=time.time(),
        )
        return jsonify({"error": str(exc)}), 400
    except (OSError, sqlite3.Error) as exc:
        message = f'Unable to store the uploaded video: {exc}'
        db_update_download(
            download_id, status='error', progress=message,
            downloaded_bytes=received, total_bytes=expected_size,
            finished_at=time.time(),
        )
        return jsonify({"error": message}), 500
    except Exception as exc:
        if is_cancel_requested(download_id):
            db_update_download(
                download_id, status='cancelled', progress='Cancelled',
                downloaded_bytes=received, total_bytes=expected_size,
                finished_at=time.time(),
            )
            return jsonify({"error": "Upload cancelled"}), 409
        message = f'Upload failed: {exc}'
        db_update_download(
            download_id, status='error', progress=message,
            downloaded_bytes=received, total_bytes=expected_size,
            finished_at=time.time(),
        )
        return jsonify({"error": message}), 500
    finally:
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


@app.route('/api/resume/<download_id>', methods=['POST'])
def resume_download(download_id):
    """Restart the worker for a cancelled or interrupted download, keeping the
    same id so yt-dlp's continuedl logic finds and reuses the existing .part
    file."""
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] not in ('cancelled', 'interrupted'):
        return jsonify({"error": f"Cannot resume from status '{entry['status']}'"}), 409
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
    if not claimed:
        current = db_get_download(download_id)
        if current is None:
            return jsonify({"error": "Unknown download id"}), 404
        return jsonify({
            "error": f"Cannot resume from status '{current['status']}'"
        }), 409
    thread = threading.Thread(
        target=background_download, args=(entry['url'], download_id)
    )
    thread.daemon = True
    thread.start()
    return jsonify({"message": "Resumed", "id": download_id})


@app.route('/api/stop/<download_id>', methods=['POST'])
def stop_download(download_id):
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    # Stopping a paused download is also valid -- request_cancel() drops the
    # pause flag so the worker wakes up and aborts cleanly.
    if entry['status'] not in ('starting', 'downloading', 'paused'):
        return jsonify({"message": "Download is not active", "status": entry['status']}), 200
    request_cancel(download_id)
    return jsonify({"message": "Stop requested", "id": download_id})


@app.route('/api/pause/<download_id>', methods=['POST'])
def pause_download(download_id):
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] not in ('starting', 'downloading'):
        return jsonify({"error": f"Cannot pause from status '{entry['status']}'"}), 409
    request_pause(download_id)
    return jsonify({"message": "Pause requested", "id": download_id})


@app.route('/api/unpause/<download_id>', methods=['POST'])
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
    """Rename the file for a finished download. Body: {"filename": "new"}.

    The user only edits the basename -- the file stays in its original
    directory (so playback and the path-traversal guard keep working). The
    extension is preserved automatically: if the user typed a basename
    without (or with a different) extension we re-append the original one.
    """
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry.get('status') != 'finished':
        return jsonify({"error": "Only finished downloads can be renamed"}), 409
    old_path = entry.get('filename')
    if not old_path or not os.path.isfile(old_path):
        return jsonify({"error": "Original file is missing on disk"}), 410

    payload = request.get_json(silent=True) or {}
    new_name = (payload.get('filename') or '').strip()
    if not new_name:
        return jsonify({"error": "Filename must not be empty"}), 400
    # Reject anything that tries to escape the current directory or smuggle
    # control bytes. We accept only a bare basename.
    if ('/' in new_name or '\\' in new_name or '\x00' in new_name
            or new_name in ('.', '..')):
        return jsonify({"error": "Filename must not contain path separators"}), 400

    directory = os.path.dirname(old_path) or '.'
    _, old_ext = os.path.splitext(old_path)
    # Preserve the original extension. If the user typed their own (matching
    # or different) we still force the original one back -- the file's
    # bytes haven't changed, so the extension shouldn't either.
    new_base, _typed_ext = os.path.splitext(new_name)
    if not new_base:
        return jsonify({"error": "Filename must not be empty"}), 400
    final_name = new_base + old_ext
    new_path = os.path.join(directory, final_name)

    # No-op if the user submitted the same name.
    if os.path.realpath(new_path) == os.path.realpath(old_path):
        return jsonify({"message": "Unchanged", "id": download_id,
                        "filename": old_path})

    if os.path.exists(new_path):
        return jsonify({"error": "A file with that name already exists"}), 409

    try:
        os.rename(old_path, new_path)
    except OSError as exc:
        return jsonify({"error": f"Rename failed: {exc}"}), 500

    db_update_download(download_id, filename=new_path)
    return jsonify({"message": "Renamed", "id": download_id,
                    "filename": new_path})


@app.route('/api/remove/<download_id>', methods=['POST'])
def remove_download(download_id):
    entry = _visible_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    fallback_dir = db_get_preferences().get("download_dir", ".")
    try:
        entry, removed = db_remove_download_if_inactive(download_id, fallback_dir)
    except OSError as exc:
        return jsonify({"error": f"Cleanup failed: {exc}"}), 500
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if not removed:
        return jsonify({
            "error": "Cannot remove a download until its worker has fully stopped."
        }), 409
    return jsonify({"message": "Removed", "id": download_id})


@app.route('/api/clear/preview', methods=['GET'])
@admin_required
def clear_history_preview():
    placeholders = ",".join("?" * len(HISTORY_STATUSES))
    with db() as conn:
        rows = conn.execute(
            f"SELECT COUNT(*), COUNT(filename) FROM downloads WHERE status IN ({placeholders})",
            HISTORY_STATUSES,
        ).fetchone()
    return jsonify({"entries": rows[0], "with_files": rows[1]})


@app.route('/api/clear', methods=['POST'])
@admin_required
def clear_history():
    try:
        removed, files_deleted = db_clear_history()
    except OSError as exc:
        return jsonify({"error": f"Cleanup failed: {exc}"}), 500
    return jsonify({"message": "Cleared", "removed": removed, "files_deleted": files_deleted})


@app.route('/api/history', methods=['GET'])
def get_history():
    return jsonify(db_list_downloads(
        g.current_user['id'],
        is_admin='admin' in g.current_user['roles'],
    ))


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
    if _visible_download(download_id) is None:
        return jsonify({"error": "Unknown download id"}), 404
    payload = request.get_json(silent=True) or {}
    favorite = payload.get('favorite')
    if not isinstance(favorite, bool):
        return jsonify({"error": "Favorite must be true or false"}), 400

    changed = db_set_download_favorite(download_id, favorite)
    if changed is None:
        return jsonify({"error": "Unknown download id"}), 404
    return jsonify({
        "id": download_id,
        "favorite": favorite,
        "changed": changed,
    })


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


@app.route('/api/tags/<download_id>', methods=['POST', 'DELETE'])
def download_tags(download_id):
    if _visible_download(download_id) is None:
        return jsonify({"error": "Unknown download id"}), 404
    payload = request.get_json(silent=True) or {}
    try:
        if request.method == 'POST':
            tags, changed = db_add_download_tag(download_id, payload.get('tag'))
        else:
            tags, changed = db_remove_download_tag(download_id, payload.get('tag'))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if tags is None:
        return jsonify({"error": "Unknown download id"}), 404
    return jsonify({
        "id": download_id,
        "tags": tags,
        "available_tags": db_list_tags(
            g.current_user['id'],
            is_admin='admin' in g.current_user['roles'],
        ),
        "changed": changed,
    })


@app.route('/api/events')
def events():
    """Server-Sent Events stream. The browser opens one EventSource and we
    push a 'change' event every time a download row is inserted, updated, or
    deleted. The client reacts by re-fetching /api/history once -- which is
    much cheaper than polling every second when nothing is happening.

    Keepalive comments (lines starting with ':') run every ~15s so proxies
    and the browser don't time the connection out during idle periods.
    """
    KEEPALIVE_SECS = 15

    def stream():
        q = event_bus.subscribe()
        try:
            # Greet the client so it knows the stream is live; also nudges it
            # to do an initial reconcile against /api/history.
            yield "event: ready\ndata: {}\n\n"
            while True:
                try:
                    kind, payload = q.get(timeout=KEEPALIVE_SECS)
                except queue.Empty:
                    # SSE comment line -- ignored by EventSource but keeps the
                    # TCP connection from being reaped by intermediaries.
                    yield ": keepalive\n\n"
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


def _is_allowed_download_path(path):
    """Confine media and previews to directories captured by download workers."""
    real = os.path.realpath(path)
    # Worker snapshots are independent of the later filename reported by
    # yt-dlp, so a corrupted filename cannot authorize its own directory.
    # Retaining every snapshot keeps old downloads playable after preferences
    # change, including rows whose worker did not reach a finished state.
    prefs = db_get_preferences()
    allowed_bases = {os.path.realpath(prefs.get('download_dir', '.'))}
    with _db_lock, sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT DISTINCT output_dir FROM downloads "
            "WHERE output_dir IS NOT NULL"
        ).fetchall()
    for (output_dir,) in rows:
        try:
            allowed_bases.add(os.path.realpath(output_dir))
        except (TypeError, ValueError):
            continue

    try:
        return any(
            os.path.commonpath([real, base]) == base
            for base in allowed_bases
        )
    except ValueError:
        return False


@app.route('/api/file/<download_id>', methods=['GET'])
def stream_file(download_id):
    """Serve a finished download for playback or browser download."""
    entry = _visible_download(download_id)
    if entry is None or entry.get('status') != 'finished':
        abort(404)
    path = entry.get('filename')
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
    ext = os.path.splitext(real)[1].lower()
    mimetype = _MIME_MAP.get(ext) or mimetypes.guess_type(real)[0] or 'application/octet-stream'
    as_attachment = request.args.get('download') == '1'
    return send_file(
        real,
        mimetype=mimetype,
        conditional=True,
        as_attachment=as_attachment,
        download_name=os.path.basename(real) if as_attachment else None,
    )


@app.route('/api/thumbnail/<download_id>', methods=['GET'])
def stream_thumbnail(download_id):
    """Serve a cached local preview, generating one for older video rows."""
    entry = _visible_download(download_id)
    if entry is None or entry.get('status') != 'finished':
        abort(404)
    media_path = entry.get('filename')
    if not media_path or not os.path.isfile(media_path):
        abort(404)
    if not _is_allowed_download_path(media_path):
        abort(403)

    fallback_dir = db_get_preferences().get('download_dir', '.')
    thumbnail_path = _thumbnail_path(entry, fallback_dir)
    if not thumbnail_path or not _is_allowed_download_path(thumbnail_path):
        abort(403)
    if (not os.path.isfile(thumbnail_path)
            and not generate_video_thumbnail(media_path, thumbnail_path)):
        abort(404)
    return send_file(
        thumbnail_path,
        mimetype='image/jpeg',
        conditional=True,
        max_age=86400,
    )


@app.route('/api/preview/<download_id>', methods=['GET'])
def stream_preview(download_id):
    """Serve a cached hover montage, generating it on first use."""
    entry = _visible_download(download_id)
    if entry is None or entry.get('status') != 'finished':
        abort(404)
    media_path = entry.get('filename')
    if not media_path or not os.path.isfile(media_path):
        abort(404)
    if not _is_allowed_download_path(media_path):
        abort(403)

    fallback_dir = db_get_preferences().get('download_dir', '.')
    preview_path = _preview_path(entry, fallback_dir)
    if not preview_path or not _is_allowed_download_path(preview_path):
        abort(403)
    if not os.path.isfile(preview_path):
        with _preview_generation_lock:
            # Another request may have filled the cache while this one waited.
            if (not os.path.isfile(preview_path)
                    and not generate_video_preview(media_path, preview_path)):
                abort(404)
    return send_file(
        preview_path,
        mimetype='video/mp4',
        conditional=True,
        max_age=86400,
    )


@app.route('/api/preferences', methods=['GET', 'POST'])
def preferences():
    if request.method == 'GET':
        return jsonify(db_get_preferences())
    data = request.json or {}
    allowed = {
        'download_dir', 'format', 'history_page_size', 'max_concurrent', 'player_mode',
        'start_fullscreen', 'theme',
    }
    updates = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not updates:
        return jsonify({"error": "No valid preference fields provided"}), 400
    if "download_dir" in updates:
        try:
            updates["download_dir"] = _prepare_download_directory(
                updates["download_dir"]
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
    if "history_page_size" in updates:
        updates["history_page_size"] = str(updates["history_page_size"])
        if updates["history_page_size"] not in {'5', '10', '20', '50'}:
            return jsonify({"error": "Videos per page must be 5, 10, 20, or 50"}), 400
    db_set_preferences(updates)
    return jsonify(db_get_preferences())


# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------

init_db()

_ingest_service_lock = threading.Lock()
_ingest_thread = None
_ingest_stop_event = None


def _positive_seconds_from_env(name, default):
    value = os.environ.get(name, str(default))
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f'{name} must be a positive number') from exc
    if not math.isfinite(seconds) or seconds < 1:
        raise RuntimeError(f'{name} must be at least 1 second')
    return seconds


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


def start_ingest_watcher():
    """Start the optional watched-folder importer exactly once."""
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
    scan_seconds = _positive_seconds_from_env(
        'VDL_INGEST_SCAN_SECONDS', 10
    )
    settle_seconds = _positive_seconds_from_env(
        'VDL_INGEST_SETTLE_SECONDS', 60
    )
    output_dir = os.path.realpath(os.path.abspath(_prepare_download_directory(
        db_get_preferences().get('download_dir', '.')
    )))
    if directory == output_dir:
        raise RuntimeError(
            'VDL_INGEST_DIR and the download directory must be different'
        )

    with _ingest_service_lock:
        if _ingest_thread is not None and _ingest_thread.is_alive():
            return _ingest_thread
        _remove_stale_ingest_partials(output_dir)
        watcher = IngestFolderWatcher(
            directory,
            scan_seconds=scan_seconds,
            settle_seconds=settle_seconds,
        )
        _ingest_stop_event = threading.Event()
        _ingest_thread = threading.Thread(
            target=watcher.run,
            args=(_ingest_stop_event,),
            name='vdl-ingest',
            daemon=True,
        )
        _ingest_thread.start()
        print(
            f'VDL ingest: watching {directory!r} every {scan_seconds:g}s '
            f'(settle {settle_seconds:g}s)',
            flush=True,
        )
        return _ingest_thread


def stop_ingest_watcher():
    """Stop the optional importer after the HTTP server exits."""
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
    owns_ingest_watcher = (
        not debug or os.environ.get('WERKZEUG_RUN_MAIN') == 'true'
    )
    ingest_thread = start_ingest_watcher() if owns_ingest_watcher else None
    print(
        f'VDL startup: UI v{APP_VERSION} | API v{APP_VERSION}',
        flush=True,
    )
    try:
        app.run(host=host, port=args.port, debug=debug, threaded=True)
    finally:
        if ingest_thread is not None:
            stop_ingest_watcher()


if __name__ == '__main__':
    main()
