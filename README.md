# VDL

A lightweight Flask video-downloader UI powered by yt-dlp. The browser UI is
served locally and live progress arrives over Server-Sent Events.

## Run with Docker Compose

The default deployment binds only to host loopback and stores media and SQLite
state in independent named volumes:

```bash
docker compose up --build -d
docker compose ps
curl --fail --silent http://127.0.0.1:5000/api/health
```

Open <http://127.0.0.1:5000>. Set `VDL_PORT` to change the host port without
changing the container's health check:

```bash
VDL_PORT=8080 docker compose up --build -d
```

Stop containers with `docker compose down`. This preserves `vdl-data` and
`vdl-downloads`; `docker compose down -v` intentionally deletes both volumes.

Podman can build and run the same image. A Compose provider (`podman-compose`
or Docker Compose) is required to use `compose.yaml` through Podman.

## Build and run directly

```bash
docker build --pull -t vdl:local .
docker run --rm -p 127.0.0.1:5000:5000 \
  -v vdl-downloads:/downloads -v vdl-data:/data vdl:local
```

The image contains yt-dlp `2026.08.19`, Deno `2.9.5`, EJS, curl-cffi,
ffmpeg, and ffprobe. It runs through tini as fixed UID/GID `10001:10001` and
does not contain Chromium or a browser automation package.

## Optional PO-token provider

The BgUtils plugin is installed but disabled by default. To opt into its
isolated HTTP provider for the whole deployment, enable both the profile and
the application setting:

```bash
VDL_POT_PROVIDER_URL=http://bgutil-provider:4416 \
  docker compose --profile pot up --build -d
docker compose ps
docker compose logs --no-color vdl bgutil-provider
```

The provider has no host-published port. An empty `VDL_POT_PROVIDER_URL` means
plugin discovery is disabled and ordinary yt-dlp behavior is unchanged. PO
tokens may help with some YouTube responses, but they do not bypass access
controls and do not guarantee a successful download.

## Storage, backup, and upgrades

List the concrete named-volume locations with `docker volume inspect`. Back up
both volumes while VDL is stopped; `/data` contains download history and
preferences, while `/downloads` contains completed media and resumable partials.

Upgrades are immutable and reviewed: update image digests and dependency pins,
update `requirements-container.constraints`, regenerate
`requirements-container.txt`, rebuild with `--pull`, run the smoke
checks, then recreate the service. Do not run `yt-dlp -U`, `pip install -U`, or
a Deno updater inside a running container. Rollback starts the previous image
against the same two volumes; this feature adds no database migration.

Bind mounts are supported in place of the named volumes, but both host paths
must already be writable by UID/GID 10001:

```bash
sudo install -d -o 10001 -g 10001 /srv/vdl/data /srv/vdl/downloads
docker run --rm -p 127.0.0.1:5000:5000 \
  -v /srv/vdl/data:/data -v /srv/vdl/downloads:/downloads vdl:local
```

The entrypoint fails with a clear ownership error instead of starting a server
that cannot create its database or media files.

## Network exposure

The UI accepts arbitrary operator-supplied URLs and has no authentication. The
Compose port therefore binds to `127.0.0.1`. LAN or Internet exposure requires
a separately reviewed authenticated reverse proxy, request limits, and an SSRF
policy; changing the bind address alone is not a safe public deployment.

## Verification

Build and inspect the local image with:

```bash
./scripts/container-smoke.sh --build
```

The script supports Podman through `CONTAINER_ENGINE=podman`. It checks the
runtime UID, pinned yt-dlp version, Deno, ffmpeg/ffprobe, Python extras, and the
absence of a browser. The external regression smoke is intentionally separate
from builds and health checks:

```bash
./scripts/network-smoke.sh |& tee "vdl-network-smoke-$(date -u +%Y%m%d).log"
```

It records the UTC date, image, URL, verbose yt-dlp diagnostics, and result for
the representative `G3jvn7n-68Y` failure. Since public sites change, a later
unrelated removal or restriction should be recorded rather than treated as a
container build failure.

Inspect image health with `docker inspect --format '{{json .State.Health}}'`
or the equivalent Podman command. `/api/health` is local-only and does not call
YouTube or the optional provider.

## Native development

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip -r requirements.txt
python vdl.py
```

Native development defaults to <http://127.0.0.1:5000>. ffmpeg remains an
external system dependency.

## Future browser provider

This release is browser-ready, not a browser image. Reconsider Chromium only if
a current pinned yt-dlp with EJS, Deno, curl impersonation, and ffmpeg still
fails, the optional provider is demonstrably reached and remains insufficient,
the URL works from a browser on the same network, and the cause is genuinely
browser-solvable rather than DRM, authentication, rate limiting, or removal.
That work needs a separate design for browser concurrency, timeouts, sandboxing,
memory, cleanup, ephemeral cookies, and secret redaction.
