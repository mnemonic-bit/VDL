#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
python=${VDL_LOCK_PYTHON:-python3}
downloads=$(mktemp -d "${TMPDIR:-/tmp}/vdl-container-locks.XXXXXX")

cleanup() {
    rm -rf -- "$downloads"
}
trap cleanup EXIT INT TERM

check_platform() {
    architecture=$1
    platform=$2
    destination="$downloads/$architecture"
    mkdir "$destination"

    "$python" -m pip download \
        --disable-pip-version-check \
        --dest "$destination" \
        --only-binary=:all: \
        --platform "$platform" \
        --implementation cp \
        --python-version 3.12 \
        --abi cp312 \
        --require-hashes \
        -r "$root/requirements-container.txt"
}

check_platform amd64 manylinux_2_17_x86_64
check_platform arm64 manylinux_2_17_aarch64

echo "Container dependency lock resolves for linux/amd64 and linux/arm64"
