from flask import Flask, render_template_string, request, jsonify
import yt_dlp
import threading
import uuid

app = Flask(__name__)
downloads = {}


class DownloadCancelled(Exception):
    """Raised from the progress hook to abort an in-flight yt-dlp download."""
    pass


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
        input[type="url"] { width: 70%; padding: 10px; }
        button { padding: 10px 20px; cursor: pointer; }
        .history-item { border: 1px solid #ccc; padding: 15px; margin-bottom: 10px; border-radius: 5px; }
        .history-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
        .history-header > div:first-child { flex: 1; word-break: break-all; }
        .stop-btn { padding: 6px 12px; background-color: #e74c3c; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .stop-btn:hover { background-color: #c0392b; }
        .reload-btn { padding: 6px 12px; background-color: #3498db; color: white; border: none; border-radius: 4px; cursor: pointer; }
        .reload-btn:hover { background-color: #2980b9; }
        .progress-bar-bg { width: 100%; background-color: #f3f3f3; border-radius: 5px; margin-top: 10px;}
        .progress-bar-fill { height: 20px; background-color: #4caf50; border-radius: 5px; width: 0%; transition: width 0.4s ease;}
        .progress-bar-fill.cancelled { background-color: #e74c3c; }
        .progress-bar-fill.error { background-color: #c0392b; }
    </style>
</head>
<body>
    <h2>Download Video</h2>
    <form id="downloadForm" class="form-group" onsubmit="startDownload(event)">
        <input type="url" id="urlInput" placeholder="Enter video URL here..." required>
        <button type="submit">Download</button>
    </form>

    <h3>Download History</h3>
    <div id="historyList"></div>

    <script>
        const ACTIVE_STATUSES = new Set(['starting', 'downloading']);

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
            // Remove the old cancelled entry, then start a fresh download.
            fetch('/api/remove/' + encodeURIComponent(id), { method: 'POST' })
                .then(() => fetch('/api/download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: url })
                }))
                .then(() => fetchHistory());
        }

        function fetchHistory() {
            fetch('/api/history')
            .then(res => res.json())
            .then(data => {
                const list = document.getElementById('historyList');
                list.innerHTML = '';

                Object.entries(data).reverse().forEach(([id, info]) => {
                    const isActive = ACTIVE_STATUSES.has(info.status);
                    let progressText;
                    if (info.status === 'finished') progressText = 'Complete';
                    else if (info.status === 'error') progressText = 'Error';
                    else if (info.status === 'cancelled') progressText = 'Cancelled';
                    else progressText = info.progress;

                    let width = String(progressText).replace('%', '');
                    if (isNaN(width)) width = info.status === 'finished' ? 100 : 0;

                    let barClass = 'progress-bar-fill';
                    if (info.status === 'cancelled') barClass += ' cancelled';
                    else if (info.status === 'error') barClass += ' error';

                    const safeUrl = info.url.replace(/'/g, "\\'");
                    let actionButton = '';
                    if (isActive) {
                        actionButton = `<button class="stop-btn" onclick="stopDownload('${id}')">Stop</button>`;
                    } else if (info.status === 'cancelled' || info.status === 'error') {
                        actionButton = `<button class="reload-btn" onclick="reloadDownload('${id}', '${safeUrl}')">Reload</button>`;
                    }

                    list.innerHTML += `
                        <div class="history-item">
                            <div class="history-header">
                                <div>
                                    <strong>URL:</strong> ${info.url}<br>
                                    <strong>Status:</strong> ${info.status} (${progressText})
                                </div>
                                ${actionButton}
                            </div>
                            <div class="progress-bar-bg">
                                <div class="${barClass}" style="width: ${width}%;"></div>
                            </div>
                        </div>
                    `;
                });
            });
        }

        setInterval(fetchHistory, 1000);
        fetchHistory();
    </script>
</body>
</html>
"""


def progress_hook(d, download_id):
    """
    Called repeatedly by yt-dlp during a download.
    Raises DownloadCancelled if the user clicked Stop, which yt-dlp
    propagates as a DownloadError and aborts the transfer cleanly.
    """
    entry = downloads.get(download_id)
    if entry is None:
        return

    if entry.get('cancel_requested'):
        raise DownloadCancelled()

    if d['status'] == 'downloading':
        total_bytes = d.get('total_bytes') or d.get('total_bytes_estimate', 0)
        downloaded = d.get('downloaded_bytes', 0)
        if total_bytes > 0:
            percent = (downloaded / total_bytes) * 100
            entry['progress'] = f"{percent:.1f}%"
            entry['status'] = 'downloading'

    elif d['status'] == 'finished':
        entry['progress'] = "100%"
        entry['status'] = 'finished'


def background_download(url, download_id):
    ydl_opts = {
        'format': 'best',
        'outtmpl': f'%(title)s_{download_id}.%(ext)s',
        'progress_hooks': [lambda d: progress_hook(d, download_id)],
        'quiet': True,
        'noprogress': True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except DownloadCancelled:
        downloads[download_id]['status'] = 'cancelled'
        downloads[download_id]['progress'] = 'Cancelled by user'
    except yt_dlp.utils.DownloadError as e:
        # yt-dlp wraps our DownloadCancelled in a DownloadError; detect that case.
        if downloads[download_id].get('cancel_requested'):
            downloads[download_id]['status'] = 'cancelled'
            downloads[download_id]['progress'] = 'Cancelled by user'
        else:
            downloads[download_id]['status'] = 'error'
            downloads[download_id]['progress'] = str(e)
    except Exception as e:
        downloads[download_id]['status'] = 'error'
        downloads[download_id]['progress'] = str(e)


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
    downloads[download_id] = {
        "url": url,
        "status": "starting",
        "progress": "0%",
        "cancel_requested": False,
    }

    thread = threading.Thread(target=background_download, args=(url, download_id))
    thread.daemon = True
    thread.start()

    return jsonify({"message": "Download started", "id": download_id})


@app.route('/api/stop/<download_id>', methods=['POST'])
def stop_download(download_id):
    entry = downloads.get(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404

    if entry['status'] not in ('starting', 'downloading'):
        return jsonify({"message": "Download is not active", "status": entry['status']}), 200

    entry['cancel_requested'] = True
    return jsonify({"message": "Stop requested", "id": download_id})


@app.route('/api/remove/<download_id>', methods=['POST'])
def remove_download(download_id):
    entry = downloads.get(download_id)
    if entry is None:
        return jsonify({"error": "Unknown download id"}), 404

    # Only allow removal of finished/cancelled/errored entries to avoid
    # orphaning a running thread.
    if entry['status'] in ('starting', 'downloading'):
        return jsonify({"error": "Cannot remove an active download. Stop it first."}), 409

    downloads.pop(download_id, None)
    return jsonify({"message": "Removed", "id": download_id})


@app.route('/api/history', methods=['GET'])
def get_history():
    # Hide the internal cancel flag from clients.
    return jsonify({
        k: {kk: vv for kk, vv in v.items() if kk != 'cancel_requested'}
        for k, v in downloads.items()
    })


if __name__ == '__main__':
    app.run(debug=True, port=5000)