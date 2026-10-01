#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
engine=${CONTAINER_ENGINE:-}
if [ -z "$engine" ]; then
    if command -v docker >/dev/null 2>&1; then
        engine=docker
    elif command -v podman >/dev/null 2>&1; then
        engine=podman
    else
        echo "Container tier requires Docker or Podman" >&2
        exit 1
    fi
fi

image=${VDL_IMAGE:-vdl:local}
suffix="$$-$(date +%s)"
name="vdl-smoke-$suffix"
data_volume="vdl-smoke-data-$suffix"
media_volume="vdl-smoke-media-$suffix"
ingest_volume="vdl-smoke-ingest-$suffix"

cleanup() {
    "$engine" rm -f "$name" >/dev/null 2>&1 || true
    "$engine" volume rm "$data_volume" "$media_volume" "$ingest_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [ "${1:-}" = "--build" ]; then
    "$engine" build --pull -t "$image" "$root"
elif [ "${1:-}" != "" ]; then
    echo "Usage: $0 [--build]" >&2
    exit 2
fi

test "$("$engine" run --rm --entrypoint id "$image" -u)" = "10001"
test "$("$engine" run --rm --entrypoint id "$image" -g)" = "10001"
test "$("$engine" run --rm "$image" yt-dlp --version)" = "2026.08.19"
"$engine" run --rm "$image" deno --version >/dev/null
"$engine" run --rm "$image" ffmpeg -version >/dev/null
"$engine" run --rm "$image" ffprobe -version >/dev/null
"$engine" run --rm "$image" python -c \
    'import curl_cffi, yt_dlp_ejs; print("recommended Python extras: ok")'

if "$engine" run --rm --entrypoint sh "$image" -c \
    'command -v chromium || command -v chromium-browser || command -v google-chrome'; then
    echo "Unexpected browser binary in the shipping image" >&2
    exit 1
fi

"$engine" volume create "$data_volume" >/dev/null
"$engine" volume create "$media_volume" >/dev/null
"$engine" volume create "$ingest_volume" >/dev/null
"$engine" run --rm --entrypoint ffmpeg \
    -v "$ingest_volume:/ingest" "$image" \
    -v error -f lavfi -i color=c=black:s=16x16:d=0.2 \
    -c:v mpeg4 -an -y /ingest/watched-folder.mp4
"$engine" run -d --name "$name" \
    -e VDL_INGEST_SCAN_SECONDS=1 -e VDL_INGEST_SETTLE_SECONDS=1 \
    -v "$data_volume:/data" -v "$media_volume:/downloads" \
    -v "$ingest_volume:/ingest:ro" "$image" >/dev/null

for attempt in $(seq 1 40); do
    if "$engine" exec "$name" python -c \
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/health', timeout=1)" \
        >/dev/null 2>&1; then
        break
    fi
    if [ "$attempt" = "40" ]; then
        "$engine" logs "$name" >&2
        echo "Shipping container did not become healthy" >&2
        exit 1
    fi
    sleep 0.25
done

"$engine" exec "$name" python - <<'PY'
import urllib.error
import urllib.request

for path in ('/api/health', '/', '/static/app.js', '/static/styles.css'):
    with urllib.request.urlopen('http://127.0.0.1:5000' + path, timeout=3) as response:
        assert response.status == 200, (path, response.status)
try:
    urllib.request.urlopen('http://127.0.0.1:5000/api/history', timeout=3)
except urllib.error.HTTPError as error:
    assert error.code == 401, error.code
else:
    raise AssertionError('history was available without authentication')
PY

"$engine" exec "$name" python - <<'PY'
import json
import os
import subprocess
import time
import http.cookiejar
import urllib.parse
import urllib.request

base_url = 'http://127.0.0.1:5000'
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(cookies)
)
setup = urllib.request.Request(
    base_url + '/login',
    data=urllib.parse.urlencode({
        'username': 'admin',
        'password': 'container-test-password',
        'password_confirmation': 'container-test-password',
    }).encode(),
    method='POST',
)
opener.open(setup, timeout=3).close()

media_path = '/tmp/upload-smoke.mp4'
subprocess.run(
    [
        'ffmpeg', '-v', 'error', '-f', 'lavfi',
        '-i', 'color=c=black:s=16x16:d=0.2',
        '-c:v', 'mpeg4', '-an', '-y', media_path,
    ],
    check=True,
)
with open(media_path, 'rb') as media:
    payload = media.read()

start = urllib.request.Request(
    base_url + '/api/upload',
    data=json.dumps({
        'filename': 'container-upload.mp4',
        'filesize': len(payload),
    }).encode(),
    headers={'Content-Type': 'application/json'},
    method='POST',
)
with opener.open(start, timeout=3) as response:
    upload_id = json.load(response)['id']
transfer = urllib.request.Request(
    f'{base_url}/api/upload/{upload_id}',
    data=payload,
    headers={'Content-Type': 'video/mp4'},
    method='PUT',
)
opener.open(transfer, timeout=10).close()
with opener.open(base_url + '/api/history') as response:
    uploaded = next(row for row in json.load(response) if row['id'] == upload_id)
assert uploaded['status'] == 'finished', uploaded
assert uploaded['source_type'] == 'upload', uploaded
assert uploaded['resolution'] == '16p', uploaded
for _attempt in range(20):
    with opener.open(base_url + '/api/history') as response:
        watched = next(
            (
                row for row in json.load(response)
                if row['title'] == 'watched-folder'
            ),
            None,
        )
    if watched is not None:
        break
    time.sleep(0.25)
assert watched is not None, 'watched-folder.mp4 was not ingested'
assert watched['status'] == 'finished', watched
assert watched['source_type'] == 'upload', watched
assert watched['resolution'] == '16p', watched
remove = urllib.request.Request(
    f'http://127.0.0.1:5000/api/remove/{upload_id}',
    data=b'',
    method='POST',
)
opener.open(remove, timeout=3).close()
PY

"$engine" exec "$name" python - <<'PY'
import json
import http.cookiejar
import sqlite3
import time
import urllib.parse
import urllib.request

base_url = 'http://127.0.0.1:5000'
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(cookies)
)
login = urllib.request.Request(
    base_url + '/login',
    data=urllib.parse.urlencode({
        'username': 'admin',
        'password': 'container-test-password',
    }).encode(),
    method='POST',
)
opener.open(login, timeout=3).close()

request = urllib.request.Request(
    base_url + '/api/preferences',
    data=json.dumps({'theme': 'dark'}).encode(),
    headers={'Content-Type': 'application/json'},
)
opener.open(request, timeout=3).close()
with open('/downloads/persist.mp4', 'wb') as output:
    output.write(b'persistent media')
with sqlite3.connect('/data/downloads.db') as connection:
    connection.execute(
        "INSERT INTO downloads(id, url, status, progress, created_at, filename, finished_at) "
        "VALUES (?, ?, 'finished', '100%', ?, ?, ?)",
        ('persist1', 'https://fixture.invalid/persist', time.time(), '/downloads/persist.mp4', time.time()),
    )
PY

"$engine" rm -f "$name" >/dev/null
"$engine" run -d --name "$name" \
    -e VDL_INGEST_SCAN_SECONDS=1 -e VDL_INGEST_SETTLE_SECONDS=1 \
    -v "$data_volume:/data" -v "$media_volume:/downloads" \
    -v "$ingest_volume:/ingest:ro" "$image" >/dev/null
for attempt in $(seq 1 40); do
    if "$engine" exec "$name" python -c \
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/health', timeout=1)" \
        >/dev/null 2>&1; then
        break
    fi
    sleep 0.25
done
"$engine" exec "$name" python - <<'PY'
import json
import http.cookiejar
import urllib.parse
import urllib.request

base_url = 'http://127.0.0.1:5000'
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(cookies)
)
login = urllib.request.Request(
    base_url + '/login',
    data=urllib.parse.urlencode({
        'username': 'admin',
        'password': 'container-test-password',
    }).encode(),
    method='POST',
)
opener.open(login, timeout=3).close()

with opener.open(base_url + '/api/preferences') as response:
    assert json.load(response)['theme'] == 'dark'
with opener.open(base_url + '/api/history') as response:
    history = json.load(response)
assert any(row['id'] == 'persist1' for row in history)
assert sum(row['title'] == 'watched-folder' for row in history) == 1, history
with opener.open(base_url + '/api/file/persist1') as response:
    assert response.read() == b'persistent media'
PY

# Mount only test code; application code remains the immutable /app payload
# from the shipping image while the generated media stays temporary.
"$engine" run --rm \
    -e VDL_RUN_MEDIA=1 -e VDL_REQUIRE_MEDIA_TOOLS=1 \
    -e PYTHONPATH=/app:/workspace \
    -v "$root/tests:/workspace/tests:ro" \
    -w /app "$image" python -m unittest -v \
    tests.integration.test_real_media.RealMediaIntegrationTest.test_dash_merge_stored_path_playback_rename_and_removal

# Exercise the shipping application's lifecycle and partial-file cleanup
# through the same deterministic seams as the fast tier. Mounting only tests
# ensures these checks cannot accidentally substitute workspace app code for
# the immutable code installed in the image.
"$engine" run --rm \
    -e PYTHONPATH=/app:/workspace \
    -v "$root/tests:/workspace/tests:ro" \
    -w /app "$image" python -m unittest -v \
    tests.test_download_lifecycle.DownloadLifecycleTest.test_pause_unpause_and_stop_apply_only_to_active_workers \
    tests.test_download_lifecycle.DownloadLifecycleTest.test_resume_accepts_only_resumable_rows_and_keeps_the_id \
    tests.test_cancelled_cleanup.CancelledDownloadCleanupTest.test_remove_cancelled_download_deletes_its_partial_files \
    tests.test_cancelled_cleanup.CancelledDownloadCleanupTest.test_remove_uses_worker_directory_after_preference_changes

echo "VDL shipping-container smoke checks passed for $image"
