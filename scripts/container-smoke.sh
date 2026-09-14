#!/bin/sh
set -eu

engine=${CONTAINER_ENGINE:-}
if [ -z "$engine" ]; then
    if command -v docker >/dev/null 2>&1; then
        engine=docker
    elif command -v podman >/dev/null 2>&1; then
        engine=podman
    else
        echo "Neither Docker nor Podman is installed" >&2
        exit 1
    fi
fi

image=${VDL_IMAGE:-vdl:local}

if [ "${1:-}" = "--build" ]; then
    "$engine" build --pull -t "$image" .
fi

test "$("$engine" run --rm --entrypoint id "$image" -u)" = "10001"
test "$("$engine" run --rm "$image" yt-dlp --version)" = "2026.08.19"
"$engine" run --rm "$image" deno --version
"$engine" run --rm "$image" ffmpeg -version
"$engine" run --rm "$image" ffprobe -version
"$engine" run --rm "$image" python -c \
    'import curl_cffi, yt_dlp_ejs; print("recommended Python extras: ok")'

if "$engine" run --rm --entrypoint sh "$image" -c \
    'command -v chromium || command -v chromium-browser || command -v google-chrome'; then
    echo "Unexpected browser binary in the Stage 1 image" >&2
    exit 1
fi

echo "VDL container smoke checks passed for $image"
