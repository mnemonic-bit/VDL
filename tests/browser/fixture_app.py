"""Deterministic Flask fixture used only by the Playwright regression tier."""

import os
import sys
import threading
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import vdl  # noqa: E402
from flask import jsonify, request  # noqa: E402
from tests.support.fake_ytdlp import FakeYoutubeDL  # noqa: E402


vdl.yt_dlp.YoutubeDL = FakeYoutubeDL
vdl.ffprobe_resolution = lambda _path: "360p"
upload_inspection_gate = threading.Event()
upload_inspection_gate.set()


def inspect_uploaded_video(_path):
    upload_inspection_gate.wait(5)
    return "360p"


vdl.inspect_uploaded_video = inspect_uploaded_video
initial_admin = vdl.db_get_initial_admin()
if initial_admin is not None:
    vdl.db_set_initial_admin_password(
        initial_admin["id"], "browser-test-password"
    )


@vdl.app.post("/__test__/reset")
def test_reset():
    upload_inspection_gate.set()
    for row in vdl.db_list_downloads():
        if row["status"] in ("starting", "downloading", "paused"):
            vdl.request_cancel(row["id"])
    with vdl._db_lock, vdl.db() as connection:
        connection.execute("DELETE FROM downloads")
        connection.execute("DELETE FROM preferences")
    with vdl._cancel_lock:
        vdl._cancel_flags.clear()
        vdl._pause_flags.clear()
    with vdl._playback_sessions_lock:
        vdl._playback_sessions.clear()
    vdl.init_db()
    FakeYoutubeDL.reset()
    return jsonify({"ok": True})


@vdl.app.post("/__test__/hold-uploads")
def test_hold_uploads():
    upload_inspection_gate.clear()
    return jsonify({"ok": True})


@vdl.app.post("/__test__/release-uploads")
def test_release_uploads():
    upload_inspection_gate.set()
    return jsonify({"ok": True})


@vdl.app.post("/__test__/hold-downloads")
def test_hold_downloads():
    FakeYoutubeDL.block_downloads = True
    FakeYoutubeDL.release.clear()
    return jsonify({"ok": True})


@vdl.app.post("/__test__/release-downloads")
def test_release_downloads():
    FakeYoutubeDL.release.set()
    return jsonify({"ok": True})


@vdl.app.post("/__test__/row")
def test_row():
    data = request.get_json() or {}
    download_id = data.get("id", "browser1")
    if vdl.db_get_download(download_id) is None:
        owner_name = data.get("downloaded_by", "admin")
        owner = vdl.db_get_user_by_username(owner_name)
        vdl.db_insert_download(
            download_id,
            data.get("url", "https://fixture.invalid/video"),
            owner["id"] if owner else None,
            owner["username"] if owner else owner_name,
        )
    filename = None
    if data.get("file"):
        os.makedirs(os.environ["DOWNLOADS_DIR"], exist_ok=True)
        filename = os.path.join(os.environ["DOWNLOADS_DIR"], data.get("name", "fixture.mp4"))
        with open(filename, "wb") as output:
            output.write(bytes(range(100)))
    updates = {
        key: value for key, value in data.items()
        if key in {
            "status", "progress", "resolution", "filesize", "speed", "eta",
            "title", "finished_at", "formats", "requested_format",
            "downloaded_bytes", "total_bytes",
            "duration_seconds", "media_metadata_probed",
        }
    }
    if filename:
        updates["filename"] = filename
    if data.get("status") in ("finished", "error", "cancelled", "interrupted"):
        updates.setdefault("finished_at", time.time())
    if updates:
        vdl.db_update_download(download_id, **updates)
    if data.get("visibility") in ("public", "private"):
        vdl.db_set_download_visibility(download_id, data["visibility"])
    if data.get("browser_authenticated") is True:
        with vdl._db_lock, vdl.db() as connection:
            connection.execute(
                "UPDATE downloads SET browser_authenticated = 1, "
                "visibility = 'private' WHERE id = ?",
                (download_id,),
            )
    return jsonify(vdl.db_get_download(download_id))


@vdl.app.post("/__test__/preferences")
def test_preferences():
    vdl.db_set_preferences(request.get_json() or {})
    return jsonify(vdl.db_get_preferences())


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    vdl.app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
