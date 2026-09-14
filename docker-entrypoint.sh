#!/bin/sh
set -eu

# The package is installed for the opt-in profile, but discovery stays off in
# ordinary deployments so it cannot make provider calls or change extraction.
if [ -n "${VDL_POT_PROVIDER_URL:-}" ]; then
    unset YTDLP_NO_PLUGINS
else
    export YTDLP_NO_PLUGINS=1
fi

for directory in /data /downloads; do
    if [ ! -d "$directory" ] || [ ! -w "$directory" ]; then
        echo "VDL cannot write to $directory; make it writable by UID/GID 10001:10001" >&2
        exit 1
    fi
done

exec "$@"
