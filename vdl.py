from flask import Flask, render_template_string, request, jsonify, send_file, abort
import yt_dlp
import threading
import uuid
import sqlite3
import os
import re
import time
from contextlib import contextmanager

app = Flask(__name__)

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
        ]:
            if col not in existing_cols:
                conn.execute(ddl)
        # Seed defaults only if missing.
        defaults = {
            "download_dir": ".",
            "format": "best",
            "max_concurrent": "3",
            "player_mode": "overlay",
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


def db_update_download(download_id, *, status=None, progress=None,
                       filename=None, resolution=None, filesize=None,
                       speed=None, eta=None):
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
    if not fields:
        return
    values.append(download_id)
    with _db_lock, db() as conn:
        conn.execute(
            f"UPDATE downloads SET {', '.join(fields)} WHERE id = ?",
            values,
        )


def db_get_download(download_id):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM downloads WHERE id = ?", (download_id,)
        ).fetchone()
        return dict(row) if row else None


def db_delete_download(download_id):
    with _db_lock, db() as conn:
        cur = conn.execute("DELETE FROM downloads WHERE id = ?", (download_id,))
        return cur.rowcount


def db_clear_terminal():
    placeholders = ",".join("?" * len(TERMINAL_STATUSES))
    with _db_lock, db() as conn:
        cur = conn.execute(
            f"DELETE FROM downloads WHERE status IN ({placeholders})",
            TERMINAL_STATUSES,
        )
        return cur.rowcount


def db_list_downloads():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, url, status, progress, created_at, "
            "filename, resolution, filesize, speed, eta "
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
        if total_bytes > 0:
            percent = (downloaded / total_bytes) * 100
            db_update_download(
                download_id,
                status='downloading',
                progress=f"{percent:.1f}%",
                speed=float(speed) if speed else None,
                eta=int(eta) if eta else None,
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
        db_update_download(
            download_id,
            status='finished',
            progress='100%',
            filename=filename,
            resolution=resolution,
            filesize=int(filesize) if filesize else None,
            speed=0.0,  # use 0 (not None) so the column is touched and cleared
            eta=0,
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
                db_update_download(
                    download_id,
                    filename=final_path,
                    filesize=os.path.getsize(final_path),
                )
    except DownloadCancelled:
        db_update_download(download_id, status='cancelled', progress='Cancelled by user')
    except yt_dlp.utils.DownloadError as e:
        if is_cancel_requested(download_id):
            db_update_download(download_id, status='cancelled', progress='Cancelled by user')
        else:
            db_update_download(download_id, status='error', progress=str(e))
    except Exception as e:
        db_update_download(download_id, status='error', progress=str(e))
    finally:
        clear_cancel(download_id)


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
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; box-sizing: border-box; }
        *, *::before, *::after { box-sizing: border-box; }
        .form-group { margin-bottom: 20px; display: flex; gap: 8px; width: 100%; }
        .form-group input[type="url"] { flex: 1; padding: 10px; }
        input[type="text"], input[type="number"] { padding: 10px; }
        button { padding: 10px 20px; cursor: pointer; }
        .history-item { border: 1px solid #ccc; padding: 15px; margin-bottom: 10px; border-radius: 5px; }
        .history-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
        .history-header > div:first-child { flex: 1; word-break: break-all; }
        .row-actions { display: flex; gap: 6px; }
        .stop-btn { padding: 6px 12px; background-color: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .stop-btn:hover { background-color: #c0392b; }
        .continue-btn { padding: 6px 12px; background-color: #f39c12; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .continue-btn:hover { background-color: #d68910; }
        .warn-icon { display: inline-block; width: 0; height: 0; border-left: 9px solid transparent; border-right: 9px solid transparent; border-bottom: 16px solid #f1c40f; position: relative; vertical-align: middle; margin-right: 8px; }
        .warn-icon::after { content: '!'; position: absolute; left: 50%; top: 4px; transform: translateX(-50%); color: #000; font-weight: bold; font-size: 11px; line-height: 1; font-family: Arial, sans-serif; }
        .reload-btn { padding: 6px 12px; background-color: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .reload-btn:hover { background-color: #2980b9; }
        .delete-btn { padding: 6px 12px; background-color: #7f8c8d; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .delete-btn:hover { background-color: #5d6d6e; }
        .copy-btn { padding: 6px 12px; background-color: #16a085; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .copy-btn:hover { background-color: #117a65; }
        .meta { margin-top: 8px; font-size: 0.9em; color: #555; }
        .meta div { margin-top: 2px; }
        .meta .filename { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
        .speed { margin-top: 6px; font-size: 0.9em; color: #555; }
        /* Kebab menu */
        .menu-wrap { position: relative; }
        .kebab-btn { padding: 6px 10px; background-color: transparent; color: #555; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-size: 1.1em; line-height: 1; }
        .kebab-btn:hover { background-color: #f3f3f3; }
        .kebab-menu { display: none; position: absolute; right: 0; top: calc(100% + 4px); background: white; border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.12); min-width: 140px; z-index: 10; }
        .kebab-menu.open { display: block; }
        .kebab-menu button { display: block; width: 100%; text-align: left; padding: 8px 12px; background: none; border: none; cursor: pointer; font-size: 0.95em; }
        .kebab-menu button:hover { background-color: #f3f3f3; }
        .kebab-menu button.danger { color: #c0392b; }
        /* Toolbar alignment: place the Clear button inline with the <summary> */
        .history-summary { display: flex; justify-content: space-between; align-items: center; cursor: pointer; list-style: none; }
        .history-summary::-webkit-details-marker { display: none; }
        .history-summary::before { content: '▶'; display: inline-block; margin-right: 8px; font-size: 0.8em; transition: transform 0.15s; }
        details[open] > .history-summary::before { transform: rotate(90deg); }
        .history-summary .title { font-weight: bold; flex: 1; }
        .progress-bar-bg { width: 100%; background-color: #f3f3f3; border-radius: 5px; margin-top: 10px;}
        .progress-bar-fill { height: 20px; background-color: #4caf50; border-radius: 5px; width: 0%; transition: width 0.4s ease;}
        .progress-bar-fill.cancelled, .progress-bar-fill.interrupted { background-color: #e74c3c; }
        .progress-bar-fill.error { background-color: #c0392b; }
        .history-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .clear-btn { padding: 8px 14px; background-color: #95a5a6; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .clear-btn:hover { background-color: #7f8c8d; }
        .pref-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
        .pref-row label { width: 180px; }
        .eta { margin-top: 4px; font-size: 0.9em; color: #555; }
        /* Tabs */
        .tabs { display: flex; gap: 0; border-bottom: 1px solid #ccc; margin-bottom: 20px; }
        .tab { padding: 10px 18px; background: none; border: 1px solid transparent; border-bottom: none; border-radius: 5px 5px 0 0; cursor: pointer; font-size: 1em; color: #555; margin-bottom: -1px; }
        .tab:hover { color: #000; }
        .tab.active { background: white; border-color: #ccc; color: #000; font-weight: bold; }
        .tab .badge { display: inline-block; min-width: 18px; padding: 1px 6px; margin-left: 6px; border-radius: 9px; background: #3498db; color: white; font-size: 0.8em; font-weight: bold; text-align: center; }
        .tab-panel { display: none; }
        .tab-panel.active { display: block; }
        .tab-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .tab-header h3 { margin: 0; }
        .empty { color: #888; padding: 20px 0; }
        .play-btn { padding: 6px 10px; background-color: transparent; color: #555; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-size: 1em; line-height: 1; }
        .play-btn:hover { background-color: #f3f3f3; }
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
    <h2>Download Video</h2>
    <form id="downloadForm" class="form-group" onsubmit="startDownload(event)">
        <input type="url" id="urlInput" placeholder="Enter video URL here..." required>
        <button type="submit">Download</button>
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
            <h3>Download History</h3>
            <button class="clear-btn" onclick="clearHistory()">Clear History</button>
        </div>
        <div id="historyList"></div>
        <p id="historyEmpty" class="empty">No completed downloads yet.</p>
    </div>

    <div id="playerBackdrop" class="player-backdrop" onclick="closePlayer(event)">
        <div class="player-box" onclick="event.stopPropagation()">
            <div id="playerTitle" class="player-title"></div>
            <button class="player-close" onclick="closePlayer()" aria-label="Close player">×</button>
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
            <select id="prefFormat" style="width: 320px; padding: 10px;">
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
            <select id="prefPlayer" style="width: 320px; padding: 10px;">
                <option value="overlay">Overlay on this page</option>
                <option value="new_tab">New browser tab</option>
            </select>
        </div>
        <div class="pref-row">
            <button id="saveBtn" onclick="savePreferences()">Save</button>
        </div>
    </div>

    <script>
        // Statuses that count as "in flight" (the worker thread is alive).
        const RUNNING_STATUSES = new Set(['starting', 'downloading']);
        // Statuses shown under the Current tab. Cancelled stays here so the
        // user can resume it; everything else terminal goes to History.
        const CURRENT_TAB_STATUSES = new Set(['starting', 'downloading', 'cancelled']);
        const HISTORY_TAB_STATUSES = new Set(['finished', 'error', 'interrupted']);
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
                primary = `<button class="stop-btn" onclick="stopDownload('${id}')">Stop</button>`;
            } else if (isCancelled) {
                primary = `<button class="continue-btn" onclick="continueDownload('${id}', '${safeUrl}')">Continue</button>`;
            }

            if (isTerminal) {
                // Reload only for non-finished terminal rows that don't already
                // have a primary Continue action (i.e. error/interrupted).
                if (!isFinished && !isCancelled) {
                    menuItems.push(`<button onclick="reloadDownload('${id}', '${safeUrl}')">Reload</button>`);
                }
                menuItems.push(`<button onclick="copyToClipboard('${safeUrl}', this)">Copy URL</button>`);
                menuItems.push(`<button class="danger" onclick="deleteDownload('${id}')">Delete</button>`);
            }

            // Play button shows for finished rows that have a captured filename.
            if (isFinished && info.filename) {
                const fileLabel = info.filename.split('/').pop().split('\\\\').pop();
                primary = `<button class="play-btn" onclick="playVideo('${id}', '${escapeAttr(fileLabel)}')" aria-label="Play" title="Play">🎥</button>` + primary;
            }

            const kebab = menuItems.length ? `
                <div class="menu-wrap">
                    <button class="kebab-btn" onclick="toggleMenu('${id}', event)" aria-label="More actions">⋮</button>
                    <div id="menu-${id}" class="kebab-menu">${menuItems.join('')}</div>
                </div>` : '';

            // ---- Bottom block ----
            // Active: progress bar + speed; terminal: metadata block (when present).
            let bottom = '';
            if (isRunning) {
                let width = String(info.progress).replace('%', '');
                if (isNaN(width)) width = 0;
                const speedStr = formatSpeed(info.speed);
                const etaStr = formatEta(info.eta);
                bottom = `
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill" style="width: ${width}%;"></div>
                    </div>
                    ${speedStr ? `<div class="speed"><strong>Speed:</strong> ${speedStr}</div>` : ''}
                    ${etaStr ? `<div class="eta"><strong>Time remaining:</strong> ${etaStr}</div>` : ''}`;
            } else {
                // Terminal states: keep a coloured bar for non-finished failures so
                // the row visually matches its status, plus any captured metadata.
                if (!isFinished) {
                    let barClass = 'progress-bar-fill';
                    if (info.status === 'cancelled') barClass += ' cancelled';
                    else if (info.status === 'interrupted') barClass += ' interrupted';
                    else if (info.status === 'error') barClass += ' error';
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
                if (info.resolution) meta.push(`<div><strong>Resolution:</strong> ${info.resolution}</div>`);
                const sizeStr = formatBytes(info.filesize);
                if (sizeStr) meta.push(`<div><strong>Size:</strong> ${sizeStr}</div>`);
                if (meta.length) bottom += `<div class="meta">${meta.join('')}</div>`;
            }

            const warn = isCancelled ? '<span class="warn-icon" title="Action required"></span>' : '';

            return `
                <div class="history-item" data-row-id="${id}">
                    <div class="history-header">
                        <div>
                            ${warn}<strong>URL:</strong> ${info.url}<br>
                            <strong>Status:</strong> ${info.status} (${statusLabel})
                        </div>
                        <div class="row-actions">${primary}${kebab}</div>
                    </div>
                    ${bottom}
                </div>
            `;
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

                document.getElementById('activeList').innerHTML = active.map(renderItem).join('');
                document.getElementById('historyList').innerHTML = done.map(renderItem).join('');

                document.getElementById('currentEmpty').style.display = active.length ? 'none' : '';
                document.getElementById('historyEmpty').style.display = done.length ? 'none' : '';

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
            });
        }

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
            };
            playerMode = body.player_mode;
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
        setInterval(fetchHistory, 1000);
        fetchHistory();
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
    """Restart the worker for a cancelled download, keeping the same id so
    yt-dlp's continuedl logic finds and reuses the existing .part file."""
    entry = db_get_download(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404
    if entry['status'] != 'cancelled':
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
    allowed = {'download_dir', 'format', 'max_concurrent', 'player_mode'}
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
    app.run(debug=True, port=5000)