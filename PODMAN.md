# Podman deployment

This host does not provide `podman compose`. Build and replace the container
manually, preserving the named volumes and the previous container for rollback.
Build before stopping the live container to minimise downtime.

## Build and replace

```bash
# Identify the versions and choose an unused rollback name before changing state.
vdl_version="$(tr -d '\n' < VERSION)"
old_version="$(curl -fsS http://127.0.0.1:5000/api/health \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])')"
rollback_name="vdl-previous-${old_version}"
if podman container exists "${rollback_name}"; then
    echo "Choose an unused rollback_name; ${rollback_name} already exists." >&2
    exit 1
fi
install -d ingest

# Build the checked-out source while the current service remains available.
podman build \
    --tag "localhost/vdl:${vdl_version}" \
    --tag localhost/vdl:local \
    .

# Preserve the current container, then start the replacement on all interfaces.
podman stop --time 10 vdl
podman rename vdl "${rollback_name}"
podman run --detach \
    --name vdl \
    --restart unless-stopped \
    --publish 0.0.0.0:5000:5000 \
    --env VDL_COMPANION_HTTP_CIDRS=100.96.0.0/24 \
    --env VDL_POT_PROVIDER_URL= \
    --env VDL_INGEST_DIR=/ingest \
    --env VDL_INGEST_SCAN_SECONDS=10 \
    --env VDL_INGEST_SETTLE_SECONDS=60 \
    --volume vdl-downloads:/downloads \
    --volume vdl-data:/data \
    --volume "$(pwd)/ingest:/ingest:ro" \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    "localhost/vdl:${vdl_version}"
```

The `ingest/` bind-source directory must exist before `podman run`. The named
volumes retain downloads and SQLite state across replacements. Podman's default
OCI image format ignores the Dockerfile `HEALTHCHECK`, so verify the HTTP health
endpoint directly.

## Verify

Completion means the endpoint reports the expected version and the container
is running on all host interfaces:

```bash
curl -fsS http://127.0.0.1:5000/api/health
podman ps --filter name='^vdl$' \
    --format '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}'
podman logs --tail 30 vdl
```
