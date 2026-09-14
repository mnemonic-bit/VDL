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
url=${1:-https://www.youtube.com/watch?v=G3jvn7n-68Y}

echo "date_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "image=$image"
echo "url=$url"
"$engine" run --rm "$image" yt-dlp --verbose --test --no-playlist \
    -f 'best[height<=360]/worst' -o '/tmp/%(id)s.%(ext)s' "$url"
