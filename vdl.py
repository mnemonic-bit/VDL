import argparse

from flask import Flask, render_template, request, jsonify, send_file, abort, Response, stream_with_context
import yt_dlp
import threading
import queue
import json
import uuid
import sqlite3
import os
import re
import time
import subprocess
import mimetypes
import copy
from contextlib import contextmanager
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
TERMINAL_STATUSES = ('finished', 'error', 'cancelled', 'interrupted')

# A single lock serialises writes from background threads. SQLite itself is
# safe for concurrent reads, but multiple writers across threads on the same
# connection cause "database is locked" errors. We open a fresh connection
# per operation and guard writes with this lock.
_db_lock = threading.Lock()

# Workers wait here before entering yt-dlp. A FIFO queue keeps a burst in
# worker-arrival order while the counter lets preference changes take
# effect without replacing a fixed-size semaphore.
_worker_condition = threading.Condition()
_worker_queue = []
_active_worker_count = 0


@contextmanager
def db():
    """Yield a sqlite3 connection with row factory; commits on clean exit."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
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
        ]:
            if col not in existing_cols:
                conn.execute(ddl)
        # Seed defaults only if missing.
        defaults = {
            "download_dir": DEFAULT_DOWNLOAD_DIR,
            "format": "best",
            "max_concurrent": "3",
            "player_mode": "overlay",
            "theme": "system",
        }
        for k, v in defaults.items():
            conn.execute(
                "INSERT OR IGNORE INTO preferences(key, value) VALUES (?, ?)",
                (k, v),
            )

        # Any download that was active when the app died is now orphaned.
        # 'paused' counts as active for this purpose -- the worker thread
        # was holding the connection open and is gone now.
        conn.execute(
            "UPDATE downloads SET status = 'interrupted', progress = 'Interrupted' "
            "WHERE status IN ('starting', 'downloading', 'paused')"
        )


def db_insert_download(download_id, url):
    with _db_lock, db() as conn:
        conn.execute(
            "INSERT INTO downloads(id, url, status, progress, created_at) "
            "VALUES (?, ?, 'starting', '0%', ?)",
            (download_id, url, time.time()),
        )
    event_bus.publish('change', {'reason': 'insert', 'id': download_id})


def db_update_download(download_id, *, status=None, progress=None,
                       filename=None, resolution=None, filesize=None,
                       speed=None, eta=None, title=None, finished_at=None,
                       formats=None, requested_format=None, output_dir=None):
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


def db_get_download(download_id):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        return dict(row) if row else None


def delete_download_artifacts(entry, fallback_dir=None):
    """Delete final and temporary files owned by one download row."""
    candidates = set()
    filename = entry.get("filename")
    if filename:
        # Keep supporting renamed files, whose basename no longer carries the
        # generated download ID used to identify yt-dlp's temporary files.
        candidates.update((filename, filename + ".part", filename + ".ytdl"))

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
    for path in candidates:
        try:
            os.remove(path)
            removed += 1
        except FileNotFoundError:
            # A postprocessor may already have consumed a temporary file.
            pass
    return removed


def db_remove_download_if_inactive(download_id, fallback_dir=None):
    """Atomically remove a non-active row and return its prior contents."""
    with _db_lock, db() as conn:
        row = conn.execute(
            "SELECT * FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        entry = dict(row) if row else None
        if entry is None or entry['status'] in ('starting', 'downloading', 'paused'):
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


def db_clear_terminal():
    placeholders = ",".join("?" * len(TERMINAL_STATUSES))
    fallback_dir = db_get_preferences().get("download_dir", ".")
    with _db_lock, db() as conn:
        entries = [
            dict(r) for r in conn.execute(
                f"SELECT id, filename, output_dir FROM downloads WHERE status IN ({placeholders})",
                TERMINAL_STATUSES,
            ).fetchall()
        ]
        # If any file cannot be removed, retain all rows so the user can retry
        # instead of losing the only record of the remaining artifacts.
        files_deleted = sum(
            delete_download_artifacts(entry, fallback_dir) for entry in entries
        )
        cur = conn.execute(
            f"DELETE FROM downloads WHERE status IN ({placeholders})",
            TERMINAL_STATUSES,
        )
        rows = cur.rowcount
    if rows:
        event_bus.publish('change', {'reason': 'clear', 'count': rows})
    return rows, files_deleted


def db_list_downloads():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, url, status, progress, created_at, "
            "filename, resolution, filesize, speed, eta, title, finished_at, "
            "formats, requested_format "
            "FROM downloads ORDER BY created_at ASC"
        ).fetchall()
        return [dict(r) for r in rows]


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
        # Mark the row paused once on entry; avoid hammering the DB on
        # every iteration of the wait loop.
        db_update_download(download_id, status='paused', speed=None, eta=None)
        while is_pause_requested(download_id):
            if is_cancel_requested(download_id):
                raise DownloadCancelled()
            time.sleep(0.25)

    if d['status'] == 'downloading':
        total_bytes = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
        downloaded = d.get('downloaded_bytes', 0)
        speed = d.get('speed')  # bytes/sec, may be None at the very start
        eta = d.get('eta')      # seconds remaining, may be None
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
        if total_bytes > 0:
            percent = (downloaded / total_bytes) * 100
            db_update_download(
                download_id,
                status='downloading',
                progress=f"{percent:.1f}%",
                speed=float(speed) if speed else None,
                eta=int(eta) if eta else None,
                filesize=int(total_bytes),
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
        filesize = (info.get('filesize') or info.get('filesize_approx')
                    or d.get('total_bytes') or d.get('total_bytes_estimate'))
        title = info.get('title') or info.get('fulltitle')
        db_update_download(
            download_id,
            status='downloading',
            progress='100%',
            filename=filename,
            resolution=resolution,
            filesize=int(filesize) if filesize else None,
            speed=0.0,  # use 0 (not None) so the column is touched and cleared
            eta=0,
            title=title,
        )


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
    return ('Requested format is not available' in msg
            or '--list-formats' in msg)


def background_download(url, download_id):
    prefs = db_get_preferences()
    output_dir = prefs.get("download_dir", ".")
    db_update_download(download_id, output_dir=os.path.abspath(output_dir))
    
    # Check if there's a format override from quality selection; otherwise use preference
    entry = db_get_download(download_id)
    fmt = (entry.get('requested_format') if entry else None) or prefs.get("format", "best")
    
    os.makedirs(output_dir, exist_ok=True)

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
        return yt_dlp_options({
            'format': format_selector,
            'outtmpl': os.path.join(output_dir, f'%(title)s_{download_id}.%(ext)s'),
            'progress_hooks': [lambda d: progress_hook(d, download_id)],
            'postprocessor_hooks': [capture_postprocessed_path],
            'quiet': True,
            'noprogress': True,
            # continuedl is default-True in yt-dlp, but make it explicit so a
            # resumed download picks up the existing .part file rather than
            # restarting from byte zero.
            'continuedl': True,
        })

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
            probe_opts = yt_dlp_options({
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
            # Auto-fallback: if yt-dlp tells the user to consult
            # --list-formats, we already have that table from the probe
            # phase. Pick the best concrete format_id and retry once with
            # an explicit selector. This mirrors what the user would
            # otherwise have to do by hand.
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
                # Probe the merged file with ffprobe for the authoritative
                # resolution. yt-dlp's progress hook reports the per-stream
                # resolution, which is None for the audio half of a merged
                # download — leaving the resolution column unset for some
                # extractors. ffprobe always reflects the final container.
                final_res = ffprobe_resolution(final_path)
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
            db_update_download(download_id, status='error', progress=str(e), finished_at=time.time())
    except Exception as e:
        db_update_download(download_id, status='error', progress=str(e), finished_at=time.time())
    finally:
        clear_cancel(download_id)
        clear_pause(download_id)
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


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

# Static UI assets are now served from templates/index.html and static/*

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    response = app.make_response(render_template(
        'index.html',
        ui_version=APP_VERSION,
    ))
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/health', methods=['GET'])
def health():
    response = jsonify({"ok": True, "version": APP_VERSION})
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/download', methods=['POST'])
def add_download():
    data = request.json or {}
    url = data.get('url')
    if not url:
        return jsonify({"error": "URL is required"}), 400

    download_id = str(uuid.uuid4())[:8]
    db_insert_download(download_id, url)

    # Store per-download format override if provided (selected quality)
    format_override = data.get('format')
    if format_override:
        db_update_download(download_id, requested_format=format_override)

    thread = threading.Thread(target=background_download, args=(url, download_id))
    thread.daemon = True
    thread.start()

    return jsonify({"message": "Download started", "id": download_id})


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
        
        # Collect resolutions in order (highest first)
        resolutions_list = []
        seen_res = set()
        container_exts = set()
        if formats_summary:
            for fmt in formats_summary:
                res_str = None
                if fmt.get('height'):
                    res_str = f"{fmt['height']}p"
                elif fmt.get('resolution'):
                    res_str = fmt['resolution']
                
                if res_str and res_str not in seen_res:
                    seen_res.add(res_str)
                    resolutions_list.append(res_str)
                
                # Collect unique container formats (extensions)
                if fmt.get('ext'):
                    container_exts.add(fmt['ext'])
        
        # Sort by height (descending)
        def get_height(res_str):
            try:
                return int(res_str.rstrip('p'))
            except:
                return 0
        
        resolutions_list.sort(key=get_height, reverse=True)
        
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
    entry = db_get_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] not in ('cancelled', 'interrupted'):
        return jsonify({"error": f"Cannot resume from status '{entry['status']}'"}), 409

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
    entry = db_get_download(download_id)
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
    entry = db_get_download(download_id)
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
    entry = db_get_download(download_id)
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
    entry = db_get_download(download_id)
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
    entry = db_get_download(download_id)
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
        return jsonify({"error": "Cannot remove an active download. Stop it first."}), 409
    return jsonify({"message": "Removed", "id": download_id})


@app.route('/api/clear/preview', methods=['GET'])
def clear_history_preview():
    placeholders = ",".join("?" * len(TERMINAL_STATUSES))
    with db() as conn:
        rows = conn.execute(
            f"SELECT COUNT(*), COUNT(filename) FROM downloads WHERE status IN ({placeholders})",
            TERMINAL_STATUSES,
        ).fetchone()
    return jsonify({"entries": rows[0], "with_files": rows[1]})


@app.route('/api/clear', methods=['POST'])
def clear_history():
    try:
        removed, files_deleted = db_clear_terminal()
    except OSError as exc:
        return jsonify({"error": f"Cleanup failed: {exc}"}), 500
    return jsonify({"message": "Cleared", "removed": removed, "files_deleted": files_deleted})


@app.route('/api/history', methods=['GET'])
def get_history():
    return jsonify(db_list_downloads())


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


@app.route('/api/file/<download_id>', methods=['GET'])
def stream_file(download_id):
    """Serve a finished download to the in-app player. Uses send_file's
    conditional/range response so the <video> element can seek.

    The absolute path captured by yt-dlp at download time is stored in the
    `filename` column. We trust that path (rather than rebuilding it from
    the *current* download_dir preference) so playback keeps working after
    the user changes the download directory mid-history.

    Path-traversal protection: instead of confining to the current
    `download_dir`, we confine to the union of every directory that has
    ever been used by a finished row. A tampered DB row pointing outside
    those directories is still rejected.
    """
    entry = db_get_download(download_id)
    if entry is None or entry.get('status') != 'finished':
        abort(404)
    path = entry.get('filename')
    if not path or not os.path.isfile(path):
        abort(404)
    real = os.path.realpath(path)

    # Build the allow-list of base directories: the current preference plus
    # every distinct parent directory of finished downloads on record.
    prefs = db_get_preferences()
    allowed_bases = {os.path.realpath(prefs.get('download_dir', '.'))}
    with _db_lock, sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT DISTINCT filename FROM downloads "
            "WHERE status = 'finished' AND filename IS NOT NULL"
        ).fetchall()
    for (fn,) in rows:
        try:
            allowed_bases.add(os.path.realpath(os.path.dirname(fn)))
        except (TypeError, ValueError):
            continue

    if not any(
        os.path.commonpath([real, base]) == base
        for base in allowed_bases
    ):
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
    return send_file(real, mimetype=mimetype, conditional=True)


@app.route('/api/preferences', methods=['GET', 'POST'])
def preferences():
    if request.method == 'GET':
        return jsonify(db_get_preferences())
    data = request.json or {}
    allowed = {'download_dir', 'format', 'max_concurrent', 'player_mode', 'theme'}
    updates = {k: v for k, v in data.items() if k in allowed and v is not None}
    if not updates:
        return jsonify({"error": "No valid preference fields provided"}), 400
    db_set_preferences(updates)
    return jsonify(db_get_preferences())


# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------

init_db()


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
    print(
        f'VDL startup: UI v{APP_VERSION} | API v{APP_VERSION}',
        flush=True,
    )
    app.run(host=host, port=args.port, debug=debug, threaded=True)


if __name__ == '__main__':
    main()
