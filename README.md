# VDL

A lightweight local video-downloader UI powered by yt-dlp. VDL provides a
browser interface for choosing formats, tracking concurrent downloads, pausing
or resuming work, importing local videos by dropping them onto the page,
organising entries with tags, and playing completed media.
Live progress arrives over Server-Sent Events without browser polling.

[![Latest release](https://img.shields.io/github/v/release/mnemonic-bit/VDL?display_name=tag&sort=semver)](https://github.com/mnemonic-bit/VDL/releases/latest)
[![Main pipeline](https://github.com/mnemonic-bit/VDL/actions/workflows/main.yml/badge.svg?branch=main&event=push)](https://github.com/mnemonic-bit/VDL/actions/workflows/main.yml?query=branch%3Amain+event%3Apush)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Container: GHCR](https://img.shields.io/badge/container-GHCR-blue?logo=github)](https://github.com/mnemonic-bit/VDL/pkgs/container/vdl)

![VDL download form and navigation](overlay-initial.png)

VDL is intended for a trusted local operator. It stores history and preferences
in SQLite, writes media to a configurable directory, supports light and dark
themes, and ships as a hardened non-root container for `linux/amd64` and
`linux/arm64`.

## Prerequisites

The recommended deployment needs Docker Engine with Compose. Podman works with
a Compose provider. Native use needs Python 3, the packages in
`requirements.txt`, and ffmpeg/ffprobe. A current Chromium, Firefox, or WebKit-
based browser is sufficient for the UI; browser playback still depends on codec
support in that browser.

The footer shows the release observed in the loaded UI and the release reported
by the active API. A mismatch asks you to refresh, which makes stale pages or
mixed deployments visible. The server also prints both values to its console
when it starts. Maintainers update the root `VERSION` file when cutting a
behavior-changing release according to the policy in `AGENTS.md`.

## Run with Docker Compose

The default deployment publishes port 5000 on all host interfaces and stores
media and SQLite state in independent named volumes:

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

Published multi-platform images are available from GHCR:

```bash
docker pull ghcr.io/mnemonic-bit/vdl:latest
docker run --rm -p 127.0.0.1:5000:5000 \
  -v vdl-downloads:/downloads -v vdl-data:/data \
  ghcr.io/mnemonic-bit/vdl:latest
```

`latest` and `main` move. For reproducible deployment and rollback, use an
immutable `v<VERSION>` or full Git commit SHA tag from the
[package](https://github.com/mnemonic-bit/VDL/pkgs/container/vdl). Each
published platform image has GitHub-native provenance and an SPDX SBOM
attestation. Verify them with GitHub CLI:

```bash
gh attestation verify oci://ghcr.io/mnemonic-bit/vdl:v0.4.1 \
  --repo mnemonic-bit/VDL
amd64_digest=$(docker buildx imagetools inspect \
  ghcr.io/mnemonic-bit/vdl:v0.4.1 --raw | \
  jq -r '.manifests[] | select(.platform.architecture == "amd64") | .digest')
gh attestation verify "oci://ghcr.io/mnemonic-bit/vdl@$amd64_digest" \
  --repo mnemonic-bit/VDL \
  --predicate-type https://spdx.dev/Document/v2.3
```

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
`requirements-container.txt` for both `manylinux_2_17_x86_64` and
`manylinux_2_17_aarch64`, run `./tests/container/check-lock.sh`, rebuild with
`--pull`, run the smoke checks, then recreate the service. Do not run
`yt-dlp -U`, `pip install -U`, or a Deno updater inside a running container.
Rollback starts the previous image against the same two volumes; this feature
adds no database migration.

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
Compose port binds to `0.0.0.0`, so anyone who can reach the host port can use
the app. Restrict access to a trusted network or place it behind an authenticated
reverse proxy with request limits and an SSRF policy before exposing it publicly.

Only download media you are authorised to access and use. VDL does not bypass
DRM or access controls, and operators remain responsible for applicable site
terms and copyright law.

## Verification

The permanent regression suite is split into explicit tiers:

```bash
./tests/run-all.sh --unit
./tests/run-all.sh --browser
./tests/run-all.sh --media
./tests/run-all.sh --container
./tests/run-all.sh --all
```

`--all` is the release gate. See [`tests/README.md`](tests/README.md) for
dependencies, expected-failure policy, and the macOS manual check.

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

## Project status and support

VDL is a sole-maintainer project, released under the [MIT License](LICENSE).
Public issues are available through structured forms for reproducible bugs and
feature requests. Triage and maintenance are best effort, with no guaranteed
response or resolution time; duplicate, unsupported, or insufficiently
actionable reports may be closed. External pull requests and shared governance
are not part of the current maintenance model.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not
through a public issue. Maintainer-only GitHub setup and release safeguards are
recorded in [.github/REPOSITORY_SETTINGS.md](.github/REPOSITORY_SETTINGS.md).

## Future browser provider

This release is browser-ready, not a browser image. Reconsider Chromium only if
a current pinned yt-dlp with EJS, Deno, curl impersonation, and ffmpeg still
fails, the optional provider is demonstrably reached and remains insufficient,
the URL works from a browser on the same network, and the cause is genuinely
browser-solvable rather than DRM, authentication, rate limiting, or removal.
That work needs a separate design for browser concurrency, timeouts, sandboxing,
memory, cleanup, ephemeral cookies, and secret redaction.
