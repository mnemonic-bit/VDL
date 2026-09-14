#!/bin/sh
# Compatibility entry point retained for existing README/bookmarks.
exec "$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/tests/container/smoke.sh" "$@"
