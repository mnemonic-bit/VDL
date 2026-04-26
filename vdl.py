from flask import Flask, render_template_string, request, jsonify
import yt_dlp
import threading
import uuid
import sqlite3
import os
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
        ]:
            if col not in existing_cols:
                conn.execute(ddl)
        # Seed defaults only if missing.
        defaults = {
            "download_dir": ".",
            "format": "best",
            "max_concurrent": "3",
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
                       filename=None, resolution=None, filesize=None):
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
            "filename, resolution, filesize "
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
        if total_bytes > 0:
            percent = (downloaded / total_bytes) * 100
            db_update_download(
                download_id,
                status='downloading',
                progress=f"{percent:.1f}%",
            )
    elif d['status'] == 'finished':
        # 'finished' here means the file was fully written to disk for this
        # format; the post-processor (merge) may still run afterwards. We
        # capture filename + resolution from the info_dict yt-dlp embeds in
        # the hook payload, and re-stat the file at the end of the run to
        # get the final size after any merge.
        info = d.get('info_dict') or {}
        filename = d.get('filename') or info.get('_filename')
        width = info.get('width')
        height = info.get('height')
        resolution = f"{height}p" if height else (info.get('format_note') or info.get('format_id'))
        filesize = (info.get('filesize') or info.get('filesize_approx')
                    or d.get('total_bytes') or d.get('total_bytes_estimate'))
        db_update_download(
            download_id,
            status='finished',
            progress='100%',
            filename=filename,
            resolution=str(resolution) if resolution else None,
            filesize=int(filesize) if filesize else None,
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
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
        .form-group { margin-bottom: 20px; }
        input[type="url"], input[type="text"], input[type="number"] { padding: 10px; box-sizing: border-box; }
        input[type="url"] { width: 70%; }
        button { padding: 10px 20px; cursor: pointer; }
        .history-item { border: 1px solid #ccc; padding: 15px; margin-bottom: 10px; border-radius: 5px; }
        .history-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
        .history-header > div:first-child { flex: 1; word-break: break-all; }
        .row-actions { display: flex; gap: 6px; }
        .stop-btn { padding: 6px 12px; background-color: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .stop-btn:hover { background-color: #c0392b; }
        .reload-btn { padding: 6px 12px; background-color: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .reload-btn:hover { background-color: #2980b9; }
        .delete-btn { padding: 6px 12px; background-color: #7f8c8d; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .delete-btn:hover { background-color: #5d6d6e; }
        .copy-btn { padding: 6px 12px; background-color: #16a085; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .copy-btn:hover { background-color: #117a65; }
        .meta { margin-top: 8px; font-size: 0.9em; color: #555; }
        .meta div { margin-top: 2px; }
        .meta .filename { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
        .progress-bar-bg { width: 100%; background-color: #f3f3f3; border-radius: 5px; margin-top: 10px;}
        .progress-bar-fill { height: 20px; background-color: #4caf50; border-radius: 5px; width: 0%; transition: width 0.4s ease;}
        .progress-bar-fill.cancelled, .progress-bar-fill.interrupted { background-color: #e74c3c; }
        .progress-bar-fill.error { background-color: #c0392b; }
        .history-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .clear-btn { padding: 8px 14px; background-color: #95a5a6; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .clear-btn:hover { background-color: #7f8c8d; }
        details { margin-bottom: 20px; border: 1px solid #ddd; border-radius: 5px; padding: 10px 15px; }
        details summary { cursor: pointer; font-weight: bold; }
        .pref-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
        .pref-row label { width: 180px; }
    </style>
</head>
<body>
    <h2>Download Video</h2>
    <form id="downloadForm" class="form-group" onsubmit="startDownload(event)">
        <input type="url" id="urlInput" placeholder="Enter video URL here..." required>
        <button type="submit">Download</button>
    </form>

    <details>
        <summary>Preferences</summary>
        <div class="pref-row">
            <label for="prefDir">Download directory</label>
            <input type="text" id="prefDir" style="width: 300px;">
        </div>
        <div class="pref-row">
            <label for="prefFormat">yt-dlp format</label>
            <input type="text" id="prefFormat" style="width: 300px;">
        </div>
        <div class="pref-row">
            <label for="prefMax">Max concurrent</label>
            <input type="number" id="prefMax" min="1" style="width: 80px;">
        </div>
        <div class="pref-row">
            <button onclick="savePreferences()">Save preferences</button>
            <span id="prefStatus" style="margin-left: 10px; color: #27ae60;"></span>
        </div>
    </details>

    <div id="activeSection" style="display: none;">
        <h3>Current Downloads</h3>
        <div id="activeList"></div>
    </div>

    <details id="historySection" open style="display: none;">
        <summary><strong>Download History</strong></summary>
        <div class="history-toolbar" style="margin-top: 10px;">
            <span></span>
            <button class="clear-btn" onclick="clearHistory()">Clear completed</button>
        </div>
        <div id="historyList"></div>
    </details>

    <p id="emptyState" style="color: #888;">No downloads yet. Paste a URL above to start.</p>

    <script>
        const ACTIVE_STATUSES = new Set(['starting', 'downloading']);
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

        function deleteDownload(id) {
            fetch('/api/remove/' + encodeURIComponent(id), { method: 'POST' })
                .then(() => fetchHistory());
        }

        function clearHistory() {
            if (!confirm('Remove all completed, cancelled, errored, and interrupted entries?')) return;
            fetch('/api/clear', { method: 'POST' })
                .then(() => fetchHistory());
        }

        function formatBytes(n) {
            if (n == null || isNaN(n)) return null;
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0, v = Number(n);
            while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
            return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
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
            const isActive = ACTIVE_STATUSES.has(info.status);
            const isTerminal = TERMINAL_STATUSES.has(info.status);
            const isFinished = info.status === 'finished';

            let statusLabel;
            if (isFinished) statusLabel = 'Complete';
            else if (info.status === 'error') statusLabel = 'Error';
            else if (info.status === 'cancelled') statusLabel = 'Cancelled';
            else if (info.status === 'interrupted') statusLabel = 'Interrupted';
            else statusLabel = info.progress;

            const safeUrl = escapeAttr(info.url);
            let actions = '';
            if (isActive) {
                actions += `<button class="stop-btn" onclick="stopDownload('${id}')">Stop</button>`;
            }
            if (info.status === 'cancelled' || info.status === 'error' || info.status === 'interrupted') {
                actions += `<button class="reload-btn" onclick="reloadDownload('${id}', '${safeUrl}')">Reload</button>`;
            }
            if (isFinished) {
                actions += `<button class="copy-btn" onclick="copyToClipboard('${safeUrl}', this)">Copy Link</button>`;
            }
            if (isTerminal) {
                actions += `<button class="delete-btn" onclick="deleteDownload('${id}')">Delete</button>`;
            }

            // Bottom block: progress bar for active/failed rows, metadata for finished rows.
            let bottom;
            if (isFinished) {
                const meta = [];
                if (info.filename) {
                    const base = info.filename.split('/').pop().split('\\\\').pop();
                    meta.push(`<div><strong>File:</strong> <span class="filename">${base}</span></div>`);
                }
                if (info.resolution) meta.push(`<div><strong>Resolution:</strong> ${info.resolution}</div>`);
                const sizeStr = formatBytes(info.filesize);
                if (sizeStr) meta.push(`<div><strong>Size:</strong> ${sizeStr}</div>`);
                bottom = meta.length ? `<div class="meta">${meta.join('')}</div>` : '';
            } else {
                let width = String(info.progress).replace('%', '');
                if (isNaN(width)) width = 0;
                let barClass = 'progress-bar-fill';
                if (info.status === 'cancelled') barClass += ' cancelled';
                else if (info.status === 'interrupted') barClass += ' interrupted';
                else if (info.status === 'error') barClass += ' error';
                bottom = `
                    <div class="progress-bar-bg">
                        <div class="${barClass}" style="width: ${width}%;"></div>
                    </div>`;
            }

            return `
                <div class="history-item">
                    <div class="history-header">
                        <div>
                            <strong>URL:</strong> ${info.url}<br>
                            <strong>Status:</strong> ${info.status} (${statusLabel})
                        </div>
                        <div class="row-actions">${actions}</div>
                    </div>
                    ${bottom}
                </div>
            `;
        }

        function fetchHistory() {
            fetch('/api/history')
            .then(res => res.json())
            .then(data => {
                // Newest first.
                const reversed = data.slice().reverse();
                const active = reversed.filter(i => ACTIVE_STATUSES.has(i.status));
                const done   = reversed.filter(i => TERMINAL_STATUSES.has(i.status));

                document.getElementById('activeList').innerHTML = active.map(renderItem).join('');
                document.getElementById('historyList').innerHTML = done.map(renderItem).join('');

                document.getElementById('activeSection').style.display  = active.length ? '' : 'none';
                document.getElementById('historySection').style.display = done.length   ? '' : 'none';
                document.getElementById('emptyState').style.display =
                    (active.length || done.length) ? 'none' : '';
            });
        }

        function loadPreferences() {
            fetch('/api/preferences').then(r => r.json()).then(p => {
                document.getElementById('prefDir').value = p.download_dir || '';
                document.getElementById('prefFormat').value = p.format || '';
                document.getElementById('prefMax').value = p.max_concurrent || '';
            });
        }

        function savePreferences() {
            const body = {
                download_dir: document.getElementById('prefDir').value,
                format: document.getElementById('prefFormat').value,
                max_concurrent: document.getElementById('prefMax').value,
            };
            fetch('/api/preferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }).then(() => {
                const s = document.getElementById('prefStatus');
                s.textContent = 'Saved';
                setTimeout(() => s.textContent = '', 2000);
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


@app.route('/api/preferences', methods=['GET', 'POST'])
def preferences():
    if request.method == 'GET':
        return jsonify(db_get_preferences())
    data = request.json or {}
    allowed = {'download_dir', 'format', 'max_concurrent'}
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