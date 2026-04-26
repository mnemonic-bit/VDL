from flask import Flask, render_template_string, request, jsonify, send_file, abort, Response, stream_with_context
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
from contextlib import contextmanager

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

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads.db")
TERMINAL_STATUSES = ('finished', 'error', 'cancelled', 'interrupted')

# A single lock serialises writes from background threads. SQLite itself is
# safe for concurrent reads, but multiple writers across threads on the same
# connection cause "database is locked" errors. We open a fresh connection
# per operation and guard writes with this lock.
_db_lock = threading.Lock()


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
        ]:
            if col not in existing_cols:
                conn.execute(ddl)
        # Seed defaults only if missing.
        defaults = {
            "download_dir": ".",
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
        conn.execute(
            "UPDATE downloads SET status = 'interrupted', progress = 'Interrupted' "
            "WHERE status IN ('starting', 'downloading')"
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
                       speed=None, eta=None, title=None, finished_at=None):
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
    if not fields:
        return
    values.append(download_id)
    with _db_lock, db() as conn:
        conn.execute(
            f"UPDATE downloads SET {', '.join(fields)} WHERE id = ?",
            values,
        )
    event_bus.publish('change', {'reason': 'update', 'id': download_id})


def db_get_download(download_id):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        return dict(row) if row else None


def db_delete_download(download_id):
    with _db_lock, db() as conn:
        cur = conn.execute("DELETE FROM downloads WHERE id = ?", (download_id,))
        rows = cur.rowcount
    if rows:
        event_bus.publish('change', {'reason': 'delete', 'id': download_id})
    return rows


def db_clear_terminal():
    placeholders = ",".join("?" * len(TERMINAL_STATUSES))
    with _db_lock, db() as conn:
        cur = conn.execute(
            f"DELETE FROM downloads WHERE status IN ({placeholders})",
            TERMINAL_STATUSES,
        )
        rows = cur.rowcount
    if rows:
        event_bus.publish('change', {'reason': 'clear', 'count': rows})
    return rows


def db_list_downloads():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, url, status, progress, created_at, "
            "filename, resolution, filesize, speed, eta, title, finished_at "
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


# ---------------------------------------------------------------------------
# Download orchestration
# ---------------------------------------------------------------------------

class DownloadCancelled(Exception):
    """Raised from the progress hook to abort an in-flight yt-dlp download."""
    pass


# Cancel flags only need to live in memory: a download is only cancellable
# while its thread is alive in this process.
_cancel_flags = {}
_cancel_lock = threading.Lock()


def request_cancel(download_id):
    with _cancel_lock:
        _cancel_flags[download_id] = True


def is_cancel_requested(download_id):
    with _cancel_lock:
        return _cancel_flags.get(download_id, False)


def clear_cancel(download_id):
    with _cancel_lock:
        _cancel_flags.pop(download_id, None)


def progress_hook(d, download_id):
    if is_cancel_requested(download_id):
        raise DownloadCancelled()

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
        # 'finished' here means the file was fully written to disk for this
        # format; the post-processor (merge) may still run afterwards. We
        # capture filename + resolution from the info_dict yt-dlp embeds in
        # the hook payload, and re-stat the file at the end of the run to
        # get the final size after any merge. Speed is cleared since the
        # download is no longer active.
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
            status='finished',
            progress='100%',
            filename=filename,
            resolution=resolution,
            filesize=int(filesize) if filesize else None,
            speed=0.0,  # use 0 (not None) so the column is touched and cleared
            eta=0,
            title=title,
            finished_at=time.time(),
        )


def background_download(url, download_id):
    prefs = db_get_preferences()
    output_dir = prefs.get("download_dir", ".")
    fmt = prefs.get("format", "best")
    os.makedirs(output_dir, exist_ok=True)

    ydl_opts = {
        'format': fmt,
        'outtmpl': os.path.join(output_dir, f'%(title)s_{download_id}.%(ext)s'),
        'progress_hooks': [lambda d: progress_hook(d, download_id)],
        'quiet': True,
        'noprogress': True,
        # continuedl is default-True in yt-dlp, but make it explicit so a
        # resumed download picks up the existing .part file rather than
        # restarting from byte zero.
        'continuedl': True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        # Re-stat the final file (post-processing may have changed it,
        # e.g. ffmpeg merging .f137 + .f140 into a single .mp4).
        entry = db_get_download(download_id)
        if entry and entry.get('filename'):
            final_path = entry['filename']
            # If extension changed during merge (e.g. .webm -> .mp4),
            # try the prefix-matched candidate.
            if not os.path.exists(final_path):
                base, _ = os.path.splitext(final_path)
                for ext in ('.mp4', '.mkv', '.webm', '.m4a'):
                    cand = base + ext
                    if os.path.exists(cand):
                        final_path = cand
                        break
            if os.path.exists(final_path):
                # Probe the merged file with ffprobe for the authoritative
                # resolution. yt-dlp's progress hook reports the per-stream
                # resolution, which is None for the audio half of a merged
                # download — leaving the resolution column unset for some
                # extractors. ffprobe always reflects the final container.
                final_res = ffprobe_resolution(final_path)
                db_update_download(
                    download_id,
                    filename=final_path,
                    filesize=os.path.getsize(final_path),
                    resolution=final_res,
                )
    except DownloadCancelled:
        db_update_download(download_id, status='cancelled', progress='Cancelled by user', finished_at=time.time())
    except yt_dlp.utils.DownloadError as e:
        if is_cancel_requested(download_id):
            db_update_download(download_id, status='cancelled', progress='Cancelled by user', finished_at=time.time())
        else:
            db_update_download(download_id, status='error', progress=str(e), finished_at=time.time())
    except Exception as e:
        db_update_download(download_id, status='error', progress=str(e), finished_at=time.time())
    finally:
        clear_cancel(download_id)


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

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video Downloader</title>
    <!-- Apply the saved theme as early as possible to avoid a flash of the
         wrong theme. We mirror the server-side preference into localStorage
         on save, then read it here before the rest of the page paints. -->
    <script>
        (function () {
            try {
                const stored = localStorage.getItem('theme') || 'system';
                const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
                const effective = (stored === 'system') ? (sysDark ? 'dark' : 'light') : stored;
                document.documentElement.setAttribute('data-theme', effective);
                document.documentElement.dataset.themePref = stored;
            } catch (e) { /* localStorage may be blocked — fall through to default light */ }
        })();
    </script>
    <style>
        /* Theme tokens. Light values are the defaults; the [data-theme="dark"]
           override block below redefines them. Theme is applied to <html> via
           the `data-theme` attribute, set early in <head> to avoid a flash of
           the wrong theme. */
        :root {
            --bg:           #ffffff;
            --fg:           #1a1a1a;
            --muted:        #555555;
            --muted-2:      #888888;
            --border:       #cccccc;
            --border-soft:  #e5e5e5;
            --surface:      #ffffff;
            --surface-2:    #f6f6f6;
            --surface-3:    #f3f3f3;
            --surface-hover: #ececec;
            --progress-bg:  #f3f3f3;
            --menu-shadow:  rgba(0,0,0,0.12);
            --link:         #3498db;
            --error-fg:     #c0392b;
            --error-bg:     #fdecea;
            --error-border: #f5c6c0;
            --error-text:   #6b1f17;
            --warn:         #f1c40f;
            --warn-text:    #000000;
            --accent:       #4caf50;
            --danger:       #e74c3c;
            --danger-2:     #c0392b;
            --orange:       #f39c12;
            --orange-2:     #d68910;
            --tab-bg:       #ffffff;
        }
        html[data-theme="dark"] {
            --bg:           #1a1d21;
            --fg:           #e6e6e6;
            --muted:        #a8acb3;
            --muted-2:      #7a7f87;
            --border:       #3a3f47;
            --border-soft:  #2a2e34;
            --surface:      #23272d;
            --surface-2:    #2a2e34;
            --surface-3:    #2f343b;
            --surface-hover: #353b43;
            --progress-bg:  #2a2e34;
            --menu-shadow:  rgba(0,0,0,0.5);
            --link:         #5dade2;
            --error-fg:     #ff7066;
            --error-bg:     #3a2020;
            --error-border: #5a2a28;
            --error-text:   #f5c6c0;
            --warn:         #f1c40f;
            --warn-text:    #000000;
            --accent:       #4caf50;
            --danger:       #e74c3c;
            --danger-2:     #c0392b;
            --orange:       #f39c12;
            --orange-2:     #d68910;
            --tab-bg:       #23272d;
        }
        html, body { background: var(--bg); color: var(--fg); }
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; box-sizing: border-box; }
        *, *::before, *::after { box-sizing: border-box; }
        /* URL + Download fused into one segmented control. The input has no
           right border / right radius; the button has no left radius and
           sits flush. They share the same height. */
        .form-group { margin-bottom: 20px; display: flex; width: 100%; }
        .form-group input[type="url"] {
            flex: 1; padding: 10px 12px; font-size: 1em;
            border: 1px solid var(--border); border-right: none;
            border-radius: 4px 0 0 4px;
            background: var(--surface); color: var(--fg);
        }
        .form-group input[type="url"]:focus { outline: none; border-color: var(--muted); }
        .form-group button[type="submit"] {
            padding: 0 16px; font-size: 1em; line-height: 1;
            border: 1px solid var(--border);
            border-radius: 0 4px 4px 0;
            background-color: var(--surface-2); color: var(--fg); cursor: pointer;
            display: inline-flex; align-items: center; gap: 6px;
        }
        .form-group button[type="submit"]:hover { background-color: var(--surface-hover); }
        /* When the input is focused, also darken the button border so the
           seam reads as one control. */
        .form-group:focus-within input[type="url"],
        .form-group:focus-within button[type="submit"] { border-color: var(--muted); }
        input[type="text"], input[type="number"], select, textarea {
            background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 4px;
        }
        input[type="text"]:focus, input[type="number"]:focus, select:focus, textarea:focus { outline: none; border-color: var(--muted); }
        input[type="text"], input[type="number"] { padding: 10px; }
        button { padding: 10px 20px; cursor: pointer; }
        .history-item { position: relative; border: 1px solid var(--border); background: var(--surface); padding: 15px; margin-bottom: 10px; border-radius: 5px; }
        /* Pin the row actions to the top-right of the whole item so they sit
           on the title's row, not below it. The padding-right on text
           content keeps it from sliding under the buttons on narrow widths. */
        .history-item > .row-actions { position: absolute; top: 12px; right: 12px; }
        /* Reserve horizontal room for the pinned action-group on every
           sibling that could render alongside the buttons (title, meta
           block). The buffer is generous enough that wrapped URL lines
           stay clear of the buttons on the first couple of lines. */
        .history-item > .item-title,
        .history-item > .meta { padding-right: 110px; }
        /* Force long URLs / filenames to break inside the meta block. */
        .history-item .meta { overflow-wrap: anywhere; word-break: break-word; }
        .row-actions { display: flex; gap: 6px; }
        .stop-btn, .continue-btn { padding: 0 12px; height: 32px; color: white; border: none; border-radius: 4px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; line-height: 1; font-size: 1em; }
        .stop-btn { background-color: #e74c3c; }
        .stop-btn:hover { background-color: #c0392b; }
        .continue-btn { background-color: #f39c12; }
        .continue-btn:hover { background-color: #d68910; }
        .stop-btn .icon, .continue-btn .icon { width: 14px; height: 14px; display: block; }
        .warn-icon { display: inline-block; width: 0; height: 0; border-left: 9px solid transparent; border-right: 9px solid transparent; border-bottom: 16px solid #f1c40f; position: relative; vertical-align: middle; margin-right: 8px; }
        .warn-icon::after { content: '!'; position: absolute; left: 50%; top: 4px; transform: translateX(-50%); color: #000; font-weight: bold; font-size: 11px; line-height: 1; font-family: Arial, sans-serif; }
        .reload-btn { padding: 6px 12px; background-color: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .reload-btn:hover { background-color: #2980b9; }
        .delete-btn { padding: 6px 12px; background-color: #7f8c8d; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .delete-btn:hover { background-color: #5d6d6e; }
        .copy-btn { padding: 6px 12px; background-color: #16a085; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .copy-btn:hover { background-color: #117a65; }
        .meta { margin-top: 8px; font-size: 0.9em; color: var(--muted); }
        .meta div { margin-top: 2px; }
        .meta .filename { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
        .speed { margin-top: 6px; font-size: 0.9em; color: var(--muted); }
        /* Kebab menu */
        .menu-wrap { position: relative; }
        .kebab-btn { padding: 6px 10px; background-color: transparent; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 1.1em; line-height: 1; }
        .kebab-btn:hover { background-color: var(--surface-3); }
        .kebab-menu { display: none; position: absolute; right: 0; top: calc(100% + 4px); background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; box-shadow: 0 2px 8px var(--menu-shadow); min-width: 140px; z-index: 10; }
        .kebab-menu.open { display: block; }
        .kebab-menu button { display: block; width: 100%; text-align: left; padding: 8px 12px; background: none; border: none; color: var(--fg); cursor: pointer; font-size: 0.95em; }
        .kebab-menu button:hover { background-color: var(--surface-3); }
        .kebab-menu button.danger { color: var(--error-fg); }
        /* Toolbar alignment: place the Clear button inline with the <summary> */
        .history-summary { display: flex; justify-content: space-between; align-items: center; cursor: pointer; list-style: none; }
        .history-summary::-webkit-details-marker { display: none; }
        .history-summary::before { content: '▶'; display: inline-block; margin-right: 8px; font-size: 0.8em; transition: transform 0.15s; }
        details[open] > .history-summary::before { transform: rotate(90deg); }
        .history-summary .title { font-weight: bold; flex: 1; }
        .progress-bar-bg { width: 100%; background-color: var(--progress-bg); border-radius: 5px; margin-top: 10px;}
        .progress-bar-fill { height: 20px; background-color: #4caf50; border-radius: 5px; width: 0%; transition: width 0.4s ease;}
        .progress-bar-fill.cancelled, .progress-bar-fill.interrupted { background-color: #e74c3c; }
        .progress-bar-fill.error { background-color: #c0392b; }
        .history-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .clear-btn { padding: 8px 14px; background-color: #95a5a6; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .clear-btn:hover { background-color: #7f8c8d; }
        .pref-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
        .pref-row label { width: 180px; }
        /* Make selects and text inputs inside the Preferences panel share
           the same box dimensions so the column lines up visually. */
        .pref-row input[type="text"],
        .pref-row input[type="number"],
        .pref-row select {
            height: 40px; padding: 0 10px; font-size: 1em; line-height: 1.2;
            border: 1px solid var(--border); border-radius: 4px;
            background: var(--surface); color: var(--fg);
            box-sizing: border-box;
        }
        .pref-row select { padding-right: 28px; }
        .pref-actions { display: flex; justify-content: flex-end; margin-top: 20px; }
        /* Match Download button styling — the user-agent default look. */
        #saveBtn { display: inline-flex; align-items: center; gap: 6px; }
        #downloadForm button[type="submit"] { display: inline-flex; align-items: center; gap: 6px; }
        .eta { margin-top: 4px; font-size: 0.9em; color: var(--muted); }
        /* Active-row progress: bar + ETA/speed on the same line. */
        .progress-row { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
        .progress-row .progress-bar-bg { flex: 1; margin: 0; }
        .progress-inline { font-size: 0.9em; color: var(--muted); white-space: nowrap; flex-shrink: 0; }
        /* Tabs */
        .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
        .tab { padding: 10px 18px; background: none; border: 1px solid transparent; border-bottom: none; border-radius: 5px 5px 0 0; cursor: pointer; font-size: 1em; color: var(--muted); margin-bottom: -1px; }
        .tab:hover { color: var(--fg); }
        .tab.active { background: var(--tab-bg); border-color: var(--border); color: var(--fg); font-weight: bold; }
        .tab .badge { display: inline-block; min-width: 18px; padding: 1px 6px; margin-left: 6px; border-radius: 9px; background: var(--link); color: white; font-size: 0.8em; font-weight: bold; text-align: center; }
        .tab-panel { display: none; }
        .tab-panel.active { display: block; }
        .tab-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .tab-header h3 { margin: 0; }
        .pager { display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 12px; color: var(--muted); font-size: 0.95em; }
        .pager button { padding: 4px 12px; font-size: 1.1em; line-height: 1; background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; min-width: 36px; }
        .pager button:disabled { opacity: 0.4; cursor: default; }
        .pager button:hover:not(:disabled) { background: var(--surface-3); }
        .empty { color: var(--muted-2); padding: 20px 0; }
        /* Item title — prominent header derived from the page title yt-dlp
           returns. Truncates with an ellipsis when too long. */
        .item-title { font-weight: 600; font-size: 1.05em; color: var(--fg); margin-bottom: 6px; padding-right: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* Segmented action group: Play and Kebab share a border so they look
           like one control with an extra menu attached on the right. */
        .action-group { display: inline-flex; align-items: stretch; }
        /* Default styling for neutral segment buttons (play, kebab). Colored
           buttons like .stop-btn / .continue-btn opt out of these defaults
           by virtue of the :not() and keep their own background. */
        .action-group > button:not(.stop-btn):not(.continue-btn),
        .action-group > .menu-wrap > .kebab-btn {
            border: 1px solid var(--border); background-color: transparent; color: var(--muted);
            cursor: pointer; padding: 0 10px; font-size: 1em; line-height: 1;
            display: inline-flex; align-items: center; justify-content: center;
            border-radius: 0;
            height: 32px; box-sizing: border-box;
        }
        .action-group > button:not(.stop-btn):not(.continue-btn):hover,
        .action-group > .menu-wrap > .kebab-btn:hover { background-color: var(--surface-3); }
        /* Colored buttons drop their own border-radius so the group can apply
           the segmented one, and lose their right border so it merges flat. */
        .action-group > .stop-btn,
        .action-group > .continue-btn { border-radius: 0; height: 32px; box-sizing: border-box; }
        /* Make the kebab wrap stretch to the same height and not overflow.
           Without this, .menu-wrap (position:relative) paints above the play
           button and intercepts clicks on the camera's right edge. */
        .action-group > .menu-wrap { display: inline-flex; }
        .action-group > .menu-wrap > .kebab-btn { width: 100%; }
        /* Rounded outer corners; flat inner edge between Play and Kebab.
           Specificity bumped with .action-group repeated so these rules win
           over the base .action-group > button block above. */
        .action-group.action-group > :first-child > button,
        .action-group.action-group > button:first-child { border-radius: 4px 0 0 4px; }
        .action-group.action-group > :last-child > button,
        .action-group.action-group > button:last-child  { border-radius: 0 4px 4px 0; border-left: none; }
        .action-group.action-group > :only-child > button,
        .action-group.action-group > button:only-child  { border-radius: 4px; border-left: 1px solid var(--border); }
        /* When a colored button (Stop/Continue) leads the group, the kebab on
           its right gets a faint white border-left so the seam is visible on
           the colored background without clashing. */
        .action-group > .stop-btn + .menu-wrap > .kebab-btn,
        .action-group > .continue-btn + .menu-wrap > .kebab-btn { border-left-color: var(--border); }
        .action-group .icon { width: 18px; height: 18px; display: block; }
        /* Kebab now uses an SVG glyph, so no font-size hack needed. */
        /* Inline icon used inside primary buttons (Download / Save). */
        .btn-icon { width: 16px; height: 16px; }
        /* Menu items in the kebab dropdown get a matching leading icon. */
        .kebab-menu button { display: flex !important; align-items: center; gap: 8px; }
        .kebab-menu .menu-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--muted); }
        .kebab-menu button.danger .menu-icon { color: var(--error-fg); }
        /* Error details disclosure on error rows. Subtle until expanded. */
        .error-details { margin-top: 10px; }
        .error-details > summary { list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; color: var(--error-fg); font-size: 0.92em; user-select: none; }
        .error-details > summary::-webkit-details-marker { display: none; }
        .error-details .chev { width: 14px; height: 14px; transition: transform 0.15s; color: var(--error-fg); flex-shrink: 0; }
        .error-details[open] > summary .chev { transform: rotate(-180deg); }
        .error-text { margin: 8px 0 0; padding: 8px 10px; background: var(--error-bg); border: 1px solid var(--error-border); border-radius: 4px; color: var(--error-text); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; }
        /* Player overlay */
        .player-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 100; align-items: center; justify-content: center; }
        .player-backdrop.open { display: flex; }
        .player-box { position: relative; max-width: 90vw; max-height: 90vh; }
        .player-box video { display: block; max-width: 90vw; max-height: 90vh; background: black; border-radius: 4px; }
        .player-close { position: absolute; top: -36px; right: 0; background: transparent; color: white; border: none; font-size: 1.6em; cursor: pointer; line-height: 1; }
        .player-title { position: absolute; top: -32px; left: 0; color: #ddd; font-size: 0.95em; max-width: calc(90vw - 40px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
    </style>
</head>
<body>
    <!-- Octicon-style icon set: 16x16 viewBox, currentColor, stroke 1.6.
         Designed to read consistently at the small sizes used in toolbars
         and inline buttons. -->
    <svg width="0" height="0" style="position:absolute" aria-hidden="true">
        <defs>
            <symbol id="i-download" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 2.5v7.2"/><path d="M4.3 6.2L8 9.9l3.7-3.7"/><path d="M2.8 13.2h10.4"/>
                </g>
            </symbol>
            <symbol id="i-save" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2.5 2.5h8.5l2.5 2.5v8.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/>
                    <path d="M4.5 2.5v3.5h6v-3.5"/>
                    <rect x="4.5" y="9" width="7" height="5"/>
                </g>
            </symbol>
            <symbol id="i-external" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9.5 2.5h4v4"/>
                    <path d="M13.5 2.5l-6 6"/>
                    <path d="M12 9v3.5a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1H7"/>
                </g>
            </symbol>
            <symbol id="i-chevron" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 6l3 3 3-3"/>
                </g>
            </symbol>
            <symbol id="i-camera" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="1.5" y="4.5" width="8" height="7" rx="1"/>
                    <path d="M9.5 7.5l5-2.5v6l-5-2.5z"/>
                </g>
            </symbol>
            <symbol id="i-copy" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="5" y="5" width="9" height="9" rx="1.2"/>
                    <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2"/>
                </g>
            </symbol>
            <symbol id="i-trash" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M2.5 4h11"/>
                    <path d="M6 4V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V4"/>
                    <path d="M3.5 4l.7 9a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-9"/>
                    <path d="M6.5 7v4"/><path d="M9.5 7v4"/>
                </g>
            </symbol>
            <symbol id="i-play" viewBox="0 0 16 16">
                <g fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
                    <path d="M5 3.5v9l8-4.5z"/>
                </g>
            </symbol>
            <symbol id="i-sync" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/>
                    <path d="M13.5 2v3h-3"/>
                </g>
            </symbol>
            <symbol id="i-kebab" viewBox="0 0 16 16">
                <g fill="currentColor">
                    <circle cx="8" cy="3" r="1.4"/>
                    <circle cx="8" cy="8" r="1.4"/>
                    <circle cx="8" cy="13" r="1.4"/>
                </g>
            </symbol>
            <symbol id="i-stop" viewBox="0 0 16 16">
                <rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor"/>
            </symbol>
            <symbol id="i-x" viewBox="0 0 16 16">
                <g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                    <path d="M4 4l8 8"/><path d="M12 4l-8 8"/>
                </g>
            </symbol>
        </defs>
    </svg>

    <h2>Download Video</h2>
    <form id="downloadForm" class="form-group" onsubmit="startDownload(event)">
        <input type="url" id="urlInput" placeholder="Enter video URL here..." required>
        <button type="submit"><svg class="btn-icon"><use href="#i-download"/></svg><span>Download</span></button>
    </form>

    <div class="tabs" role="tablist">
        <button class="tab active" data-tab="current" onclick="switchTab('current')">Current<span id="currentBadge" class="badge" style="display: none;">0</span></button>
        <button class="tab" data-tab="history" onclick="switchTab('history')">Download History</button>
        <button class="tab" data-tab="preferences" onclick="switchTab('preferences')">Preferences</button>
    </div>

    <div id="tab-current" class="tab-panel active">
        <div id="activeList"></div>
        <p id="currentEmpty" class="empty">No active downloads. Paste a URL above to start.</p>
    </div>

    <div id="tab-history" class="tab-panel">
        <div class="tab-header">
            <button class="clear-btn" onclick="clearHistory()" style="margin-left:auto;">Clear History</button>
        </div>
        <div id="historyList"></div>
        <div id="historyPager" class="pager" style="display:none;">
            <button id="pagerPrev" onclick="changePage(-1)" aria-label="Previous page">‹</button>
            <span id="pagerInfo"></span>
            <button id="pagerNext" onclick="changePage(1)" aria-label="Next page">›</button>
        </div>
        <p id="historyEmpty" class="empty">No completed downloads yet.</p>
    </div>

    <div id="playerBackdrop" class="player-backdrop" onclick="closePlayer(event)">
        <div class="player-box" onclick="event.stopPropagation()">
            <div id="playerTitle" class="player-title"></div>
            <button class="player-close" onclick="closePlayer()" aria-label="Close player"><svg style="width:24px;height:24px"><use href="#i-x"/></svg></button>
            <video id="playerVideo" controls autoplay></video>
        </div>
    </div>

    <div id="tab-preferences" class="tab-panel">
        <div class="pref-row">
            <label for="prefDir">Download directory</label>
            <input type="text" id="prefDir" style="width: 300px;">
        </div>
        <div class="pref-row">
            <label for="prefFormat">Quality</label>
            <select id="prefFormat" style="width: 320px;">
                <option value="bestvideo+bestaudio/best">Best available (video + audio merged)</option>
                <option value="best">Best single file (no merge needed)</option>
                <option value="bestvideo[height<=2160]+bestaudio/best">Up to 2160p (4K)</option>
                <option value="bestvideo[height<=1440]+bestaudio/best">Up to 1440p (2K)</option>
                <option value="bestvideo[height<=1080]+bestaudio/best">Up to 1080p (Full HD)</option>
                <option value="bestvideo[height<=720]+bestaudio/best">Up to 720p (HD)</option>
                <option value="bestvideo[height<=480]+bestaudio/best">Up to 480p (SD)</option>
                <option value="worstvideo+worstaudio/worst">Smallest file (lowest quality)</option>
                <option value="bestaudio/best">Audio only (best)</option>
                <option value="__custom__">Custom (advanced)</option>
            </select>
        </div>
        <div class="pref-row" id="customFormatRow" style="display: none;">
            <label for="prefFormatCustom">Custom format</label>
            <input type="text" id="prefFormatCustom" style="width: 320px;" placeholder="e.g. bestvideo[ext=mp4]+bestaudio[ext=m4a]">
        </div>
        <div class="pref-row">
            <label for="prefMax">Max concurrent</label>
            <input type="number" id="prefMax" min="1" style="width: 80px;">
        </div>
        <div class="pref-row">
            <label for="prefPlayer">Play videos in</label>
            <select id="prefPlayer" style="width: 320px;">
                <option value="overlay">Overlay on this page</option>
                <option value="new_tab">New browser tab</option>
            </select>
        </div>
        <div class="pref-row">
            <label for="prefTheme">Theme</label>
            <select id="prefTheme" style="width: 320px;">
                <option value="system">System (follow OS setting)</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
            </select>
        </div>
        <div class="pref-actions">
            <button id="saveBtn" onclick="savePreferences()"><svg class="btn-icon"><use href="#i-save"/></svg><span>Save</span></button>
        </div>
    </div>

    <script>
        // Statuses that count as "in flight" (the worker thread is alive).
        const RUNNING_STATUSES = new Set(['starting', 'downloading']);
        // Statuses shown under the Current tab. Cancelled and interrupted
        // stay here so the user can resume them; everything else terminal
        // goes to History.
        const CURRENT_TAB_STATUSES = new Set(['starting', 'downloading', 'cancelled', 'interrupted']);
        const HISTORY_TAB_STATUSES = new Set(['finished', 'error']);
        const TERMINAL_STATUSES = new Set(['finished', 'error', 'cancelled', 'interrupted']);

        function startDownload(event) {
            if (event) event.preventDefault();
            const url = document.getElementById('urlInput').value;
            if (!url) return alert('Please enter a URL');
            fetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url })
            })
            .then(res => res.json())
            .then(() => {
                document.getElementById('urlInput').value = '';
                fetchHistory();
            });
        }

        function stopDownload(id) {
            fetch('/api/stop/' + encodeURIComponent(id), { method: 'POST' })
                .then(() => fetchHistory());
        }

        function reloadDownload(id, url) {
            fetch('/api/remove/' + encodeURIComponent(id), { method: 'POST' })
                .then(() => fetch('/api/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url })
                }))
                .then(() => fetchHistory());
        }

        function continueDownload(id, url) {
            // Real resume: same row id, same output path. yt-dlp's continuedl
            // detects the existing .part file and continues from where the
            // previous worker stopped.
            fetch('/api/resume/' + encodeURIComponent(id), { method: 'POST' })
                .then(() => fetchHistory());
        }

        function deleteDownload(id) {
            // Optimistic UI: close the menu and yank the row immediately, then
            // fire the API call. If the server rejects (e.g. row is somehow
            // active), re-fetch to restore truth.
            closeAllMenus();
            const row = document.querySelector(`[data-row-id="${id}"]`);
            if (row) row.remove();

            fetch('/api/remove/' + encodeURIComponent(id), { method: 'POST' })
                .then(res => {
                    if (!res.ok) fetchHistory();
                })
                .catch(() => fetchHistory());
        }

        function clearHistory() {
            if (!confirm('Remove all completed, cancelled, errored, and interrupted entries?')) return;
            fetch('/api/clear', { method: 'POST' })
                .then(() => fetchHistory());
        }

        // Kebab menu open/close ------------------------------------------------
        // Track which menu (if any) is currently open. While a menu is open we
        // pause history polling so the periodic re-render doesn't destroy the
        // menu's DOM node mid-click.
        let openMenuId = null;
        // Track which error-details panels the user has expanded, so the
        // periodic fetchHistory() re-render doesn't snap them shut.
        const openErrorIds = new Set();
        function onErrorDetailsToggle(id, el) {
            if (el.open) openErrorIds.add(id);
            else openErrorIds.delete(id);
        }

        function closeAllMenus() {
            document.querySelectorAll('.kebab-menu.open').forEach(m => m.classList.remove('open'));
            openMenuId = null;
        }

        function toggleMenu(id, ev) {
            ev.stopPropagation();
            const menu = document.getElementById('menu-' + id);
            if (!menu) return;
            const wasOpen = menu.classList.contains('open');
            closeAllMenus();
            if (!wasOpen) {
                menu.classList.add('open');
                openMenuId = id;
            }
        }

        // Click anywhere outside a menu closes it.
        document.addEventListener('click', (ev) => {
            if (ev.target.closest('.kebab-menu') || ev.target.closest('.kebab-btn')) return;
            closeAllMenus();
        });

        function formatDateTime(epochSeconds) {
            if (epochSeconds == null || isNaN(epochSeconds)) return null;
            const d = new Date(Number(epochSeconds) * 1000);
            if (isNaN(d.getTime())) return null;
            // Locale-aware short date + time, e.g. 26.04.2026, 17:42 (de-DE).
            return d.toLocaleString(undefined, {
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit',
            });
        }

        function formatBytes(n) {
            if (n == null || isNaN(n)) return null;
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0, v = Number(n);
            while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
            return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
        }

        function formatSpeed(bps) {
            const s = formatBytes(bps);
            return s ? s + '/s' : null;
        }

        function formatEta(seconds) {
            if (seconds == null || isNaN(seconds) || seconds < 0) return null;
            const s = Math.round(Number(seconds));
            if (s < 60) return s + 's';
            const m = Math.floor(s / 60);
            const rem = s % 60;
            if (m < 60) return m + 'm ' + rem + 's';
            const h = Math.floor(m / 60);
            const mm = m % 60;
            return h + 'h ' + mm + 'm ' + rem + 's';
        }

        function escapeAttr(s) {
            return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function escapeHtml(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function openUrl(url) {
            closeAllMenus();
            window.open(url, '_blank', 'noopener,noreferrer');
        }

        function copyToClipboard(text, btn) {
            const done = () => {
                if (!btn) return;
                const original = btn.textContent;
                btn.textContent = 'Copied';
                setTimeout(() => { btn.textContent = original; }, 1500);
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
            } else {
                fallback(text, done);
            }
        }

        function fallback(text, done) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) {}
            document.body.removeChild(ta);
        }

        function renderItem(info) {
            const id = info.id;
            const isRunning = RUNNING_STATUSES.has(info.status);
            const isCancelled = info.status === 'cancelled';
            const isTerminal = TERMINAL_STATUSES.has(info.status);
            const isFinished = info.status === 'finished';

            let statusLabel;
            if (isFinished) statusLabel = 'Complete';
            else if (info.status === 'error') statusLabel = 'Error';
            else if (info.status === 'cancelled') statusLabel = 'Cancelled';
            else if (info.status === 'interrupted') statusLabel = 'Interrupted';
            else statusLabel = info.progress;

            const safeUrl = escapeAttr(info.url);

            // ---- Action layout ----
            // Inline: Stop on running rows, Continue on cancelled rows.
            // Everything else goes into the kebab.
            let primary = '';
            const menuItems = [];

            if (isRunning) {
                primary = `<button class="stop-btn" onclick="stopDownload('${id}')"><svg class="icon"><use href="#i-stop"/></svg>Stop</button>`;
            } else if (isCancelled || info.status === 'interrupted') {
                primary = `<button class="continue-btn" onclick="continueDownload('${id}', '${safeUrl}')"><svg class="icon"><use href="#i-play"/></svg>Continue</button>`;
            }

            // Open URL in a new tab — available on every row.
            menuItems.push(`<button onclick="openUrl('${safeUrl}')"><svg class="menu-icon"><use href="#i-external"/></svg>Open URL</button>`);

            if (isTerminal) {
                // Reload only for non-finished terminal rows that don't already
                // have a primary Continue action (i.e. error).
                if (!isFinished && !isCancelled && info.status !== 'interrupted') {
                    menuItems.push(`<button onclick="reloadDownload('${id}', '${safeUrl}')"><svg class="menu-icon"><use href="#i-sync"/></svg>Reload</button>`);
                }
                menuItems.push(`<button onclick="copyToClipboard('${safeUrl}', this)"><svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL</button>`);
                menuItems.push(`<button class="danger" onclick="deleteDownload('${id}')"><svg class="menu-icon"><use href="#i-trash"/></svg>Delete</button>`);
            } else {
                // Active rows: also offer Copy URL for convenience.
                menuItems.push(`<button onclick="copyToClipboard('${safeUrl}', this)"><svg class="menu-icon"><use href="#i-copy"/></svg>Copy URL</button>`);
            }

            // Play button shows for finished rows that have a captured filename.
            // It joins the kebab into a single segmented control.
            const hasPlay = isFinished && info.filename;
            const playBtn = hasPlay
                ? `<button onclick="playVideo('${id}', '${escapeAttr(info.filename.split('/').pop().split('\\\\').pop())}')" aria-label="Play" title="Play"><svg class="icon"><use href="#i-camera"/></svg></button>`
                : '';

            const kebabInner = menuItems.length ? `
                <div class="menu-wrap">
                    <button class="kebab-btn" onclick="toggleMenu('${id}', event)" aria-label="More actions"><svg class="icon"><use href="#i-kebab"/></svg></button>
                    <div id="menu-${id}" class="kebab-menu">${menuItems.join('')}</div>
                </div>` : '';

            // Wrap leading button (Stop/Continue/Play) + Kebab together so they
            // share borders and look unified.
            const leading = primary || playBtn;
            const actions = (leading || menuItems.length)
                ? `<div class="action-group">${leading}${kebabInner}</div>`
                : '';

            // ---- Bottom block ----
            // Active: single-line progress bar with ETA + speed inline.
            // Terminal: status-coloured bar (skipped for errors) + metadata.
            let bottom = '';
            if (isRunning) {
                let width = String(info.progress).replace('%', '');
                if (isNaN(width)) width = 0;
                const speedStr = formatSpeed(info.speed);
                const etaStr = formatEta(info.eta);
                const sizeStr = formatBytes(info.filesize);
                const resStr = info.resolution;
                const inlineParts = [];
                if (etaStr) inlineParts.push(etaStr);
                if (speedStr) inlineParts.push(speedStr);
                const inline = inlineParts.length ? `<span class="progress-inline">${inlineParts.join(' · ')}</span>` : '';
                bottom = `
                    <div class="progress-row">
                        <div class="progress-bar-bg">
                            <div class="progress-bar-fill" style="width: ${width}%;"></div>
                        </div>
                        ${inline}
                    </div>
                    ${(sizeStr || resStr) ? `<div class="meta">${sizeStr ? `<div><strong>Total size:</strong> ${sizeStr}</div>` : ''}${resStr ? `<div><strong>Quality:</strong> ${resStr}</div>` : ''}</div>` : ''}`;
            } else {
                // Terminal states: keep a coloured bar for cancelled/interrupted
                // (where the row visually mirrors its status). Errors get no bar
                // — the dedicated error-details panel speaks for itself.
                if (!isFinished && info.status !== 'error') {
                    let barClass = 'progress-bar-fill';
                    if (info.status === 'cancelled') barClass += ' cancelled';
                    else if (info.status === 'interrupted') barClass += ' interrupted';
                    let width = String(info.progress).replace('%', '');
                    if (isNaN(width)) width = 0;
                    bottom += `
                        <div class="progress-bar-bg">
                            <div class="${barClass}" style="width: ${width}%;"></div>
                        </div>`;
                }
                const meta = [];
                if (info.filename) {
                    const base = info.filename.split('/').pop().split('\\\\').pop();
                    meta.push(`<div><strong>File:</strong> <span class="filename">${base}</span></div>`);
                }
                if (info.resolution) meta.push(`<div><strong>Quality:</strong> ${info.resolution}</div>`);
                const sizeStr = formatBytes(info.filesize);
                if (sizeStr) meta.push(`<div><strong>Size:</strong> ${sizeStr}</div>`);
                const startedStr = formatDateTime(info.created_at);
                if (startedStr) meta.push(`<div><strong>Started:</strong> ${startedStr}</div>`);
                const finishedStr = formatDateTime(info.finished_at);
                if (finishedStr) {
                    const finLabel = info.status === 'finished' ? 'Finished'
                                   : info.status === 'error' ? 'Failed'
                                   : info.status === 'cancelled' ? 'Cancelled'
                                   : 'Ended';
                    meta.push(`<div><strong>${finLabel}:</strong> ${finishedStr}</div>`);
                }
                if (meta.length) bottom += `<div class="meta">${meta.join('')}</div>`;
            }

            const warn = (isCancelled || info.status === 'interrupted') ? '<span class="warn-icon" title="Action required"></span>' : '';

            // Error details: collapsed by default, expandable via chevron.
            // Restore prior open state across periodic re-renders.
            let errorBlock = '';
            if (info.status === 'error' && info.progress) {
                const detail = String(info.progress);
                const openAttr = openErrorIds.has(id) ? ' open' : '';
                errorBlock = `
                    <details class="error-details"${openAttr} ontoggle="onErrorDetailsToggle('${id}', this)">
                        <summary><svg class="chev"><use href="#i-chevron"/></svg><strong>Error details</strong></summary>
                        <pre class="error-text">${escapeHtml(detail)}</pre>
                    </details>`;
            }

            // Display title — prefer the captured page title, fall back to the
            // bare filename (after stripping the path), so older rows from
            // before the title column existed still get a sensible header.
            let displayTitle = info.title || '';
            if (!displayTitle && info.filename) {
                const base = info.filename.split('/').pop().split('\\\\').pop();
                displayTitle = base.replace(/\.[^.]+$/, '');
            }
            const titleRow = displayTitle
                ? `<div class="item-title" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}</div>`
                : '';

            // URL + Status as meta rows (same visual treatment as File /
            // Quality / Size). Rendered above the `bottom` meta so the
            // identifying info leads the item.
            const headMeta = `<div class="meta">
                <div>${warn}<strong>URL:</strong> ${escapeHtml(info.url)}</div>
                <div><strong>Status:</strong> ${info.status} (${statusLabel})</div>
            </div>`;

            return `
                <div class="history-item" data-row-id="${id}">
                    <div class="row-actions">${actions}</div>
                    ${titleRow}
                    ${headMeta}
                    ${bottom}
                    ${errorBlock}
                </div>
            `;
        }

        // History pagination state.
        const HISTORY_PAGE_SIZE = 10;
        let historyPage = 0;     // zero-based
        let historyTotal = 0;    // count of rows in the History tab

        function changePage(delta) {
            const maxPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
            const next = Math.min(maxPage, Math.max(0, historyPage + delta));
            if (next === historyPage) return;
            historyPage = next;
            fetchHistory();
        }

        function fetchHistory() {
            // Skip the re-render while a kebab menu is open so the click isn't
            // swallowed by DOM replacement. The next tick after the menu closes
            // picks up the latest data.
            if (openMenuId !== null) return;

            fetch('/api/history')
            .then(res => res.json())
            .then(data => {
                // Newest first.
                const reversed = data.slice().reverse();
                const active = reversed.filter(i => CURRENT_TAB_STATUSES.has(i.status));
                const done   = reversed.filter(i => HISTORY_TAB_STATUSES.has(i.status));

                // Clamp pagination after deletes/clears.
                historyTotal = done.length;
                const maxPage = Math.max(0, Math.ceil(historyTotal / HISTORY_PAGE_SIZE) - 1);
                if (historyPage > maxPage) historyPage = maxPage;
                const start = historyPage * HISTORY_PAGE_SIZE;
                const pageItems = done.slice(start, start + HISTORY_PAGE_SIZE);

                document.getElementById('activeList').innerHTML = active.map(renderItem).join('');
                document.getElementById('historyList').innerHTML = pageItems.map(renderItem).join('');

                document.getElementById('currentEmpty').style.display = active.length ? 'none' : '';
                document.getElementById('historyEmpty').style.display = done.length ? 'none' : '';

                // Pager visibility + state.
                const pager = document.getElementById('historyPager');
                if (historyTotal > HISTORY_PAGE_SIZE) {
                    pager.style.display = '';
                    document.getElementById('pagerInfo').textContent =
                        `Page ${historyPage + 1} of ${maxPage + 1} · ${historyTotal} items`;
                    document.getElementById('pagerPrev').disabled = historyPage <= 0;
                    document.getElementById('pagerNext').disabled = historyPage >= maxPage;
                } else {
                    pager.style.display = 'none';
                }

                const badge = document.getElementById('currentBadge');
                if (active.length) {
                    badge.textContent = active.length;
                    badge.style.display = '';
                } else {
                    badge.style.display = 'none';
                }
            });
        }

        // Player -------------------------------------------------------------
        let playerMode = 'overlay';

        function playVideo(id, label) {
            const url = '/api/file/' + encodeURIComponent(id);
            if (playerMode === 'new_tab') {
                window.open(url, '_blank', 'noopener');
                return;
            }
            const video = document.getElementById('playerVideo');
            document.getElementById('playerTitle').textContent = label || '';
            video.src = url;
            document.getElementById('playerBackdrop').classList.add('open');
        }

        function closePlayer(ev) {
            // Backdrop click bubbles here; ignore clicks that originated on the
            // box itself (those call event.stopPropagation in the handler).
            const backdrop = document.getElementById('playerBackdrop');
            const video = document.getElementById('playerVideo');
            video.pause();
            video.removeAttribute('src');
            video.load();
            backdrop.classList.remove('open');
        }

        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && document.getElementById('playerBackdrop').classList.contains('open')) {
                closePlayer();
            }
        });

        // Tabs ---------------------------------------------------------------
        function switchTab(name) {
            document.querySelectorAll('.tab').forEach(t => {
                t.classList.toggle('active', t.dataset.tab === name);
            });
            document.querySelectorAll('.tab-panel').forEach(p => {
                p.classList.toggle('active', p.id === 'tab-' + name);
            });
            closeAllMenus();
        }

        // Quality preset handling -------------------------------------------
        // The <select> exposes curated yt-dlp format strings. If the value
        // currently stored in the DB is one of the presets, select it. Anything
        // else (typed in by an advanced user) shows the Custom field instead.
        function isPresetValue(v) {
            const sel = document.getElementById('prefFormat');
            return Array.from(sel.options).some(o => o.value === v && o.value !== '__custom__');
        }

        function refreshCustomVisibility() {
            const sel = document.getElementById('prefFormat');
            const row = document.getElementById('customFormatRow');
            row.style.display = sel.value === '__custom__' ? '' : 'none';
        }

        // Script is at end of body, so the elements exist already.
        document.getElementById('prefFormat').addEventListener('change', refreshCustomVisibility);

        // Theme handling --------------------------------------------------
        // Three modes: 'light', 'dark', 'system'. The boot script in <head>
        // already applied the cached choice; these helpers keep the UI in
        // sync afterwards and react to live changes.
        function applyTheme(pref) {
            const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            const effective = (pref === 'system') ? (sysDark ? 'dark' : 'light') : pref;
            document.documentElement.setAttribute('data-theme', effective);
            document.documentElement.dataset.themePref = pref;
            try { localStorage.setItem('theme', pref); } catch (e) {}
        }

        // When the user picks 'system', track the OS preference live.
        if (window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const onChange = () => {
                if (document.documentElement.dataset.themePref === 'system') {
                    applyTheme('system');
                }
            };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        }

        function loadPreferences() {
            fetch('/api/preferences').then(r => r.json()).then(p => {
                document.getElementById('prefDir').value = p.download_dir || '';
                document.getElementById('prefMax').value = p.max_concurrent || '';

                const stored = p.format || 'bestvideo+bestaudio/best';
                const sel = document.getElementById('prefFormat');
                if (isPresetValue(stored)) {
                    sel.value = stored;
                    document.getElementById('prefFormatCustom').value = '';
                } else {
                    sel.value = '__custom__';
                    document.getElementById('prefFormatCustom').value = stored;
                }
                refreshCustomVisibility();

                playerMode = (p.player_mode === 'new_tab') ? 'new_tab' : 'overlay';
                document.getElementById('prefPlayer').value = playerMode;

                const theme = ['light', 'dark', 'system'].includes(p.theme) ? p.theme : 'system';
                document.getElementById('prefTheme').value = theme;
                // Reconcile the cached value with the server's authoritative one.
                applyTheme(theme);
            });
        }

        // Apply theme immediately on dropdown change for instant feedback;
        // the choice is persisted only on Save, but the visual switch happens
        // right away as the user picks an option.
        document.getElementById('prefTheme').addEventListener('change', (ev) => {
            applyTheme(ev.target.value);
        });

        function savePreferences() {
            const sel = document.getElementById('prefFormat');
            const fmt = sel.value === '__custom__'
                ? document.getElementById('prefFormatCustom').value.trim()
                : sel.value;

            const body = {
                download_dir: document.getElementById('prefDir').value,
                format: fmt || 'best',
                max_concurrent: document.getElementById('prefMax').value,
                player_mode: document.getElementById('prefPlayer').value,
                theme: document.getElementById('prefTheme').value,
            };
            playerMode = body.player_mode;
            applyTheme(body.theme);
            fetch('/api/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }).then(() => {
                const btn = document.getElementById('saveBtn');
                btn.textContent = 'Saved ✓';
                btn.disabled = true;
                setTimeout(() => {
                    btn.textContent = 'Save';
                    btn.disabled = false;
                }, 4000);
            });
        }

        loadPreferences();

        // Server-push instead of polling --------------------------------
        // The server streams Server-Sent Events on /api/events. Each
        // 'change' event tells us a download row was inserted, updated
        // or deleted -- we react by re-fetching /api/history exactly once.
        // EventSource handles auto-reconnect with backoff, so a brief
        // server restart fixes itself without our help.
        //
        // We coalesce bursts of events (e.g. progress updates firing
        // multiple times per second) into a single fetch using rAF so
        // the UI never re-renders more than once per frame.
        let pendingFetch = false;
        function scheduleFetch() {
            if (pendingFetch) return;
            pendingFetch = true;
            requestAnimationFrame(() => {
                pendingFetch = false;
                fetchHistory();
            });
        }

        function connectEventStream() {
            const es = new EventSource('/api/events');
            es.addEventListener('ready', scheduleFetch);
            es.addEventListener('change', scheduleFetch);
            // EventSource reconnects on its own; this handler is just for
            // diagnostics in the browser console.
            es.addEventListener('error', () => {
                // The browser will retry automatically. Nothing to do.
            });
            return es;
        }

        connectEventStream();
        fetchHistory();  // first paint; the 'ready' event will follow.
    </script>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return render_template_string(HTML_TEMPLATE)


@app.route('/api/download', methods=['POST'])
def add_download():
    data = request.json or {}
    url = data.get('url')
    if not url:
        return jsonify({"error": "URL is required"}), 400

    download_id = str(uuid.uuid4())[:8]
    db_insert_download(download_id, url)

    thread = threading.Thread(target=background_download, args=(url, download_id))
    thread.daemon = True
    thread.start()

    return jsonify({"message": "Download started", "id": download_id})


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

    # Clear stale cancel flag, mark the row as starting, then spawn the worker.
    clear_cancel(download_id)
    db_update_download(download_id, status='starting', progress='0%')
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
    if entry['status'] not in ('starting', 'downloading'):
        return jsonify({"message": "Download is not active", "status": entry['status']}), 200
    request_cancel(download_id)
    return jsonify({"message": "Stop requested", "id": download_id})


@app.route('/api/remove/<download_id>', methods=['POST'])
def remove_download(download_id):
    entry = db_get_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] in ('starting', 'downloading'):
        return jsonify({"error": "Cannot remove an active download. Stop it first."}), 409
    db_delete_download(download_id)
    return jsonify({"message": "Removed", "id": download_id})


@app.route('/api/clear', methods=['POST'])
def clear_history():
    removed = db_clear_terminal()
    return jsonify({"message": "Cleared", "removed": removed})


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
    conditional/range response so the <video> element can seek."""
    entry = db_get_download(download_id)
    if entry is None or entry.get('status') != 'finished':
        abort(404)
    path = entry.get('filename')
    if not path or not os.path.isfile(path):
        abort(404)
    # Confine the served path to the configured download directory so a
    # tampered DB row can't be used to read arbitrary files.
    prefs = db_get_preferences()
    base = os.path.realpath(prefs.get('download_dir', '.'))
    real = os.path.realpath(path)
    if os.path.commonpath([real, base]) != base:
        abort(403)
    return send_file(real, conditional=True)


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

if __name__ == '__main__':
    # debug=True triggers a reloader child process. init_db() runs in both
    # parents and children, but it is idempotent so this is fine.
    # threaded=True is required so the long-lived SSE connection on
    # /api/events doesn't block other requests behind a single worker.
    app.run(debug=True, port=5000, threaded=True)