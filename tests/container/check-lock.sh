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
    python_version=$1
    abi=$2
    architecture=$3
    platform=$4
    destination="$downloads/$python_version-$architecture"
    mkdir "$destination"

    "$python" -m pip download \
        --disable-pip-version-check \
        --dest "$destination" \
        --only-binary=:all: \
        --platform "$platform" \
        --implementation cp \
        --python-version "$python_version" \
        --abi "$abi" \
        --require-hashes \
        -r "$root/requirements-container.txt"
}

check_platform 3.12 cp312 amd64 manylinux_2_17_x86_64
check_platform 3.12 cp312 arm64 manylinux_2_17_aarch64
check_platform 3.14 cp314 amd64 manylinux_2_17_x86_64
check_platform 3.14 cp314 arm64 manylinux_2_17_aarch64

echo "Container dependency lock resolves for Python 3.12 and 3.14 on linux/amd64 and linux/arm64"
