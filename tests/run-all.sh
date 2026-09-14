#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
image=${VDL_IMAGE:-vdl:local}

usage() {
    echo "Usage: $0 --unit|--browser|--media|--container|--all" >&2
    exit 2
}

python_runner() {
    selected=${VDL_PYTHON:-}
    if [ -z "$selected" ]; then
        selected=$(command -v python 2>/dev/null || command -v python3 2>/dev/null || true)
    fi
    if [ -n "$selected" ] && "$selected" -c 'import flask, yt_dlp' >/dev/null 2>&1; then
        "$selected" "$@"
        return
    fi
    engine=${CONTAINER_ENGINE:-$(command -v docker 2>/dev/null || command -v podman 2>/dev/null || true)}
    if [ -z "$engine" ]; then
        echo "Install requirements.txt in VDL_PYTHON, or provide Docker/Podman." >&2
        exit 1
    fi
    if ! "$engine" image inspect "$image" >/dev/null 2>&1; then
        echo "Building missing fallback image $image" >&2
        "$engine" build --pull -t "$image" "$root"
    fi
    "$engine" run --rm \
        -e "VDL_RUN_MEDIA=${VDL_RUN_MEDIA:-0}" \
        -e "VDL_REQUIRE_MEDIA_TOOLS=${VDL_REQUIRE_MEDIA_TOOLS:-0}" \
        -v "$root:/workspace:ro" -w /workspace "$image" python "$@"
}

run_unit() {
    python_runner -m unittest discover -s tests -v
}

run_browser() {
    python3 "$root/tests/browser/run.py"
}

run_media() {
    VDL_RUN_MEDIA=1
    VDL_REQUIRE_MEDIA_TOOLS=1
    export VDL_RUN_MEDIA VDL_REQUIRE_MEDIA_TOOLS
    python_runner -m unittest tests.integration.test_real_media -v
}

run_container() {
    "$root/tests/container/smoke.sh" --build
}

case "${1:-}" in
    --unit) run_unit ;;
    --browser) run_browser ;;
    --media) run_media ;;
    --container) run_container ;;
    --all)
        run_unit
        run_browser
        run_media
        run_container
        ;;
    *) usage ;;
esac
