# Feature 1: Docker packaging and browser-ready download support

**Status:** Proposed, refined, and ready for implementation  
**Last refined:** 2026-09-14  
**Representative failure:** `https://www.youtube.com/watch?v=G3jvn7n-68Y`

## Decision summary

Ship the feature in three stages:

1. **Implement now:** replace the nonstandard `Dockerfile.vdl` seed with a
   conventional, hardened VDL image. Pin yt-dlp to `2026.08.19`, install its
   recommended dependencies, and add persistent storage, health checks, and
   smoke tests.
2. **Implement as an optional runtime profile:** package the BgUtils PO-token
   plugin and define its HTTP provider as a dormant Compose service. It is only
   enabled through an explicit environment variable and `pot` profile, and its
   port is never published to the host.
3. **Defer:** do not install Chromium or a browser automation library yet. Keep
   a documented seam for a future browser provider, but only implement it after
   an up-to-date yt-dlp image and the optional PO-token provider have both been
   shown insufficient for a representative URL.

This is intentionally **browser-ready**, not a browser image in the first
release. The supplied YouTube failure is evidence for updating yt-dlp, not for
adding Chromium.

## Why this scope

The local `downloads.db` contains nine attempts for the representative URL.
Six attempts on 2026-05-17 finished, while attempts on 2026-09-07 (two) and
2026-09-13 (one) failed with `unable to download video data: HTTP Error 403:
Forbidden`. Every row contains the same 31 extracted formats. This means page
and format extraction completed; the failure happened while fetching selected
media data. The environment used for diagnosis had yt-dlp `2026.03.17`.

Upstream reported the same `android_vr` media-download 403 in issue
[#17456](https://github.com/yt-dlp/yt-dlp/issues/17456). The maintainer closed it
with “update to version 2026.08.19 or later.” The
[2026.08.19 release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)
removed `android_vr` from the default YouTube clients through
[#17461](https://github.com/yt-dlp/yt-dlp/pull/17461). It is therefore reasonable
to infer that an updated yt-dlp is the direct fix to validate first.

yt-dlp's version-matched dependency documentation says that `ffmpeg`,
`ffprobe`, `yt-dlp-ejs`, and a supported JavaScript runtime are highly
recommended; EJS is required for full YouTube support, Deno is the recommended
runtime, and `curl_cffi` is the recommended browser-request impersonation
backend for sites that use TLS fingerprinting. The documented installation is
`yt-dlp[default,curl-cffi]`.
[Source: yt-dlp 2026.08.19 README](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md#dependencies)

## Goals

- Build and run VDL with the conventional commands `docker build .` and
  `docker compose up`.
- Fix the known `android_vr` failure by shipping yt-dlp `2026.08.19`.
- Include the dependencies needed for current YouTube challenge solving and
  media post-processing: EJS, Deno, `curl_cffi`, ffmpeg, and ffprobe.
- Run the application as a fixed, unprivileged user with a real init process.
- Persist downloaded media and SQLite state independently of container
  replacement.
- Expose a cheap local health check that does not depend on YouTube or another
  Internet service.
- Provide a reproducible external smoke test for the representative URL.
- Make PO-token support explicit, optional, and isolated from the host network.
- Leave a clean operational path for a future browser provider without adding
  browser weight or instability now.

## Non-goals

- Installing Chromium, Chrome, Playwright, Selenium, nodriver, or Xvfb in the
  initial VDL image.
- Using a browser to transfer media data. yt-dlp remains responsible for the
  download so existing progress, pause, cancel, merge, and resume behavior is
  preserved.
- Automatically retrying every yt-dlp failure through a browser or PO-token
  provider.
- Capturing or storing browser cookies, login credentials, or authorization
  headers.
- Bypassing DRM, paywalls, CAPTCHAs, geographic restrictions, or access
  controls.
- Making the unauthenticated VDL UI safe for public Internet exposure.
- Turning the Flask development server into a multi-process deployment. That
  would require a separate design because workers and pause/cancel state are
  in-process.

## Architecture

```text
Host browser
    |
    | 127.0.0.1:5000 by default
    v
+-------------------------- VDL container ---------------------------+
| tini -> python vdl.py                                            |
|                                                                  |
| yt-dlp 2026.08.19                                                |
|   + yt-dlp-ejs -> Deno 2.9.5                                    |
|   + curl_cffi browser-request impersonation                      |
|   + ffmpeg / ffprobe post-processing                             |
|                                                                  |
| /data/downloads.db <persistent>   /downloads <persistent>         |
+-------------------------------+----------------------------------+
                                |
                                | only when VDL_POT_PROVIDER_URL is set
                                v
                 +----------------------------------+
                 | BgUtils provider (profile: pot)  |
                 | http://bgutil-provider:4416      |
                 | no host-published port           |
                 +----------------------------------+
```

Compose service discovery uses service names on the project network, so VDL
can reach `bgutil-provider:4416` without a host port. The network must retain
its normal external gateway because both services need outbound Internet
access; the isolation boundary is the absence of a published provider port,
not `internal: true`.
[Source: Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)

## Stage 1 — runnable, hardened VDL image

### Container contents

The standard `Dockerfile` must:

- use a maintained Python 3.12 slim Debian base, pinned to an image digest for
  reproducible releases;
- install `ffmpeg` (which supplies ffmpeg and ffprobe), `ca-certificates`, and
  `tini` with `--no-install-recommends`, then remove package-manager indexes;
- install `yt-dlp[default,curl-cffi]==2026.08.19` from a committed container
  dependency lock;
- copy Deno `2.9.5` from a versioned official Deno `bin` image in a multi-stage
  build, with both source images recorded by digest;
- copy only `vdl.py`, `templates/`, `static/`, and the dependency metadata into
  the runtime image;
- create an unprivileged `vdl` user and group with fixed UID/GID `10001`;
- make `/downloads`, `/data`, the user's home, and any required cache directory
  writable by that user, while keeping application code read-only;
- set `DOWNLOADS_DIR=/downloads`, `DOWNLOADS_DB=/data/downloads.db`,
  `HOST=0.0.0.0`, `PORT=5000`, and `FLASK_DEBUG=0`;
- set `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1`,
  `DENO_NO_UPDATE_CHECK=1`, and `DENO_NO_PROMPT=1`;
- run as `USER 10001:10001`;
- use `tini` as PID 1 and execute `python vdl.py`; and
- declare a `HEALTHCHECK` against `/api/health` on the configured `PORT` (5000
  by default) using the Python standard library, so a second HTTP client is not
  required.

Docker health checks can distinguish an unresponsive web process from a merely
running process and expose `starting`, `healthy`, and `unhealthy` states.
[Source: Dockerfile `HEALTHCHECK`](https://docs.docker.com/reference/dockerfile/#healthcheck)
Tini also anticipates future browser child processes by forwarding signals and
reaping abandoned children; Compose describes these as the two responsibilities
of a container init process.
[Source: Compose `init`](https://docs.docker.com/reference/compose-file/services/#init)

The yt-dlp `2026.08.19` package metadata requires Deno `>=2.6.6` and pins Deno
`2.9.5` for its own locked builds, so `2.9.5` is the initial VDL pin rather than
an arbitrary latest version.
[Source: yt-dlp 2026.08.19 package metadata](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/pyproject.toml)
Deno publishes official `bin` image variants and documents `deno --version` as
the installation check.
[Source: Deno installation](https://docs.deno.com/runtime/getting_started/installation/)

### Dependency locking

Keep the broad developer-facing `requirements.txt` only if it remains useful
outside containers. Add a container-specific input and generated lock (for
example, `requirements-container.in` and `requirements-container.txt`) with:

```text
Flask
yt-dlp[default,curl-cffi]==2026.08.19
bgutil-ytdlp-pot-provider==2.0.0
```

The generated lock must pin all resolved Python packages and include hashes.
The BgUtils package is present for Stage 2 but must be disabled by default as
described below. Do not run `yt-dlp -U`, `pip install -U`, or Deno's updater at
container startup; dependency changes happen by rebuilding a reviewed image.

### Runtime and storage

`compose.yaml` must define:

- one `vdl` service built from `Dockerfile`;
- `127.0.0.1:${VDL_PORT:-5000}:5000` as the default port mapping;
- named volumes mounted at `/downloads` and `/data`;
- `restart: unless-stopped`;
- `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]` if they pass
  the download and ffmpeg smoke tests; and
- `VDL_POT_PROVIDER_URL: ${VDL_POT_PROVIDER_URL:-}`.

Do not add both Compose `init: true` and an image-level tini entrypoint. The
image-level entrypoint makes direct `docker run` and Compose behave the same.

Named volumes are the documented default because Docker initializes their
ownership from the image. Bind mounts remain supported, but the operator must
make both host directories writable by UID/GID `10001` before startup. Removing
the container must not remove either volume; `docker compose down -v` remains
an explicitly destructive operation.

### Build context

Add `.dockerignore` and exclude at least:

```text
.git/
.venv/
__pycache__/
*.py[cod]
downloads.db
media/
feature-audit/
tests/
*.log
```

Do not exclude `templates/`, `static/`, the dependency lock, or documentation
needed by image metadata. Docker recommends using `.dockerignore` to keep
irrelevant files out of the build context.
[Source: Docker build best practices](https://docs.docker.com/build/building/best-practices/#exclude-with-dockerignore)

### Existing Dockerfile

The current working tree has `Dockerfile.vdl` as a runnable seed but no
conventional root `Dockerfile`; older repository notes also refer to a tooling
image that is no longer present. At implementation time there must be exactly
one conventional, runnable application `Dockerfile` at the repository root.
Remove or archive `Dockerfile.vdl` and update stale references so
`docker build .` is unambiguous.

## Stage 2 — optional BgUtils PO-token profile

YouTube can require Proof-of-Origin tokens for some clients; absent tokens may
lead to 403 responses. yt-dlp currently recommends a provider plugin rather
than manually copying short-lived, content-bound tokens.
[Source: yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)

This fallback must be present but dormant:

- Pin both the Python plugin and server image to BgUtils `2.0.0`. The provider
  documentation says the versions should match.
- Define `bgutil-provider` under the Compose profile `pot` using the versioned
  Deno-flavor image (and pin its digest in the implemented Compose file).
- Do not define `ports:` for the provider. An optional `expose: ["4416"]` is
  documentation only; peer services can already reach that container port.
- Give the provider an init process, a health check, conservative resource
  limits, dropped capabilities, and `no-new-privileges` where supported by its
  published image.
- Default `VDL_POT_PROVIDER_URL` to an empty string. Empty means no provider,
  no provider network call, and no change to ordinary yt-dlp behavior.
- When the variable is non-empty, validate it once at startup and merge
  `youtubepot-bgutilhttp:base_url=<value>` into the yt-dlp extractor arguments
  used by both probe and download operations. Preserve any existing extractor
  arguments.
- Ensure the plugin is disabled before yt-dlp is imported when the variable is
  empty. A small container entrypoint may set the documented
  `YTDLP_NO_PLUGINS` environment switch; when the URL is present, it must unset
  that switch before starting Python.
- Do not automatically enable the provider solely because a download failed.
  The container operator opts into it for the whole deployment.

The provider's documentation describes the two-part plugin/server design, the
default HTTP port `4416`, the `base_url` argument, and the versioned
`2.0.0-deno` image. It also warns that PO tokens do not guarantee a bypass.
[Source: BgUtils 2.0.0 README](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/blob/2.0.0/README.md)

Normal startup remains:

```bash
docker compose up --build -d
```

Explicit PO-token startup is:

```bash
VDL_POT_PROVIDER_URL=http://bgutil-provider:4416 \
    docker compose --profile pot up --build -d
```

The BgUtils HTTP server is unauthenticated. Its maintainers warn that broad
publication can allow untrusted clients to generate tokens, consume resources,
and potentially achieve remote code execution. It must never be published to
the host or placed on a shared ingress network.
[Source: BgUtils server warning](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/blob/2.0.0/README.md)

## Stage 3 — deferred Chromium/browser provider

Do not add a browser in this feature. Re-open this stage only when all of the
following are true:

1. The failure reproduces on the then-current supported yt-dlp image with EJS,
   Deno, curl impersonation, and ffmpeg available.
2. The optional PO-token provider is enabled and its logs prove it was reached.
3. The URL is playable from a normal browser on the same network identity.
4. The failure has a clear browser-solvable cause, such as JavaScript session
   bootstrap, rather than DRM, authentication, rate limiting, or a removed
   video.

The current `yt-dlp-getpot-wpc` project calls itself experimental, requires
Chrome/Chromium, and launches a browser while yt-dlp runs.
[Source: WPC README](https://github.com/coletdjnz/yt-dlp-getpot-wpc)
As inspected on 2026-09-14, its browser configuration hard-codes
`headless=False`.
[Source: WPC provider source](https://github.com/coletdjnz/yt-dlp-getpot-wpc/blob/main/yt_dlp_plugins/extractor/getpot_wpc.py)
It also has an open report that nodriver instances are not closing or being
reused.
[Source: WPC issue #1](https://github.com/coletdjnz/yt-dlp-getpot-wpc/issues/1)
Running it in a headless container would therefore require a virtual display
such as Xvfb; that is an inference from the headed configuration, not a feature
claimed by the provider.

A future browser implementation requires its own refinement covering:

- a provider that genuinely supports headless Chromium;
- a one-browser-job semaphore to cap memory use;
- navigation and overall job timeouts;
- guaranteed context/process cleanup on success, error, and cancellation;
- Chromium sandbox and seccomp behavior under a non-root user;
- `/dev/shm` sizing and container memory limits;
- ephemeral, mode-`0600` cookie storage, followed by guaranteed deletion; and
- redaction of cookies, tokens, authorization headers, and signed media URLs
  from logs, SQLite, and SSE events.

## Deliverables

- `Dockerfile` — the runnable application image.
- `.dockerignore` — a minimal build context without runtime/user data.
- `compose.yaml` — VDL service, persistent volumes, and optional `pot` profile.
- Container dependency input and fully resolved lock with hashes.
- A small entrypoint/bootstrap only if needed to keep plugins truly dormant.
- Minimal `vdl.py` configuration seam for `VDL_POT_PROVIDER_URL`, shared by
  probe and download option construction.
- Documentation for build, start, stop, upgrade, backup, bind-mount ownership,
  LAN exposure, health inspection, and optional PO-token startup.
- Automated static/container smoke script that checks binaries and versions.
- A best-effort network smoke command for the representative YouTube URL.
- Removal or archival of misleading legacy Dockerfiles.

No frontend changes are required.

## Acceptance criteria

### Image and runtime

- `docker build -t vdl:local .` succeeds from a clean checkout.
- The final image contains no source tree beyond the files VDL needs at
  runtime and runs as UID/GID `10001:10001`.
- `docker run --rm vdl:local yt-dlp --version` prints `2026.08.19`.
- `deno --version`, `ffmpeg -version`, and `ffprobe -version` succeed inside
  the image.
- Python can import `yt_dlp_ejs` and `curl_cffi` inside the image.
- yt-dlp verbose output detects Deno and does not emit the missing-JavaScript-
  runtime warning for YouTube.
- The `curl_cffi` request handler/impersonation targets are visible in yt-dlp
  diagnostics.
- The container runs as non-root, becomes healthy, and returns JSON containing
  `"ok": true` from `/api/health`.
- Stopping the container terminates Flask and leaves no child process behind.

### Application behavior and persistence

- The UI loads through the Compose port and an ordinary direct download still
  progresses through SSE without polling.
- A merged video download proves ffmpeg is usable and the stored file is
  playable through `/api/file/<id>`.
- Pause, unpause, cancel, resume, rename, remove, and partial-artifact cleanup
  behave the same as a native run.
- Recreating the container without deleting volumes preserves history,
  preferences, completed media, and resumable partials.
- A fresh deployment creates `/data/downloads.db` and writes media beneath
  `/downloads` without root-owned output.
- The default Compose deployment binds only to host loopback.

### Representative 403

- A byte-limited yt-dlp download of
  `https://www.youtube.com/watch?v=G3jvn7n-68Y` reaches the media downloader and
  completes without the reported `android_vr` 403 at validation time.
- The VDL UI can download the same URL with its normal default format path.
- Save the verbose smoke output with the release evidence. The output must show
  yt-dlp `2026.08.19`, Deno, and the selected non-`android_vr` default clients.
- This external check must not run during `docker build` or serve as the
  container health check. If the URL later becomes unavailable for an unrelated
  reason, record that fact and use a second known-public URL while retaining
  the original regression evidence.

### Optional provider

- With `VDL_POT_PROVIDER_URL` empty, the provider container is absent, the
  plugin is disabled, and no request is attempted to port 4416.
- With the `pot` profile and provider URL enabled, the provider becomes healthy,
  the VDL container resolves `bgutil-provider`, and yt-dlp verbose output lists
  `bgutil:http-2.0.0` as an external PO-token provider.
- Both probing and downloading receive the configured `base_url` without
  overwriting other extractor arguments.
- No provider port appears in `docker compose ps` host publications.
- Disabling the profile returns VDL to exactly the normal Stage 1 behavior.

### Deferred browser

- Chromium/Chrome, Playwright, Selenium, nodriver, WPC, and Xvfb are absent from
  the initial image.
- Documentation explains the evidence required to reopen Stage 3 and does not
  claim that a headless browser is already available.

## Verification commands

The implementation should make the following workflow pass:

```bash
docker build --pull -t vdl:local .

docker run --rm vdl:local yt-dlp --version
docker run --rm vdl:local deno --version
docker run --rm vdl:local ffmpeg -version
docker run --rm vdl:local ffprobe -version
docker run --rm vdl:local python -c \
    'import curl_cffi, yt_dlp_ejs; print("recommended Python extras: ok")'

docker compose up -d --build
docker compose ps
curl --fail --silent http://127.0.0.1:5000/api/health
docker compose exec vdl id

docker run --rm vdl:local yt-dlp --verbose --test --no-playlist \
    -f 'best[height<=360]/worst' -o '/tmp/%(id)s.%(ext)s' \
    'https://www.youtube.com/watch?v=G3jvn7n-68Y'

docker compose down
docker compose up -d
curl --fail --silent http://127.0.0.1:5000/api/history

VDL_POT_PROVIDER_URL=http://bgutil-provider:4416 \
    docker compose --profile pot up -d --build
docker compose ps
docker compose logs --no-color vdl bgutil-provider
```

Manual checks remain necessary for the UI lifecycle because the repository has
no browser automation suite. Network smoke checks should be labelled with the
date, public egress IP environment, yt-dlp version, and URL result so a future
site change is distinguishable from a container regression.

## Security and operational risks

- **Unauthenticated arbitrary URL input:** the current app can fetch operator-
  supplied URLs and has no authentication. Bind to loopback by default. LAN or
  Internet exposure requires a separately reviewed authenticated reverse proxy,
  request limits, and SSRF policy.
- **Third-party extractors and plugins:** yt-dlp loads plugins as Python code
  and explicitly performs no trust checks. Only install reviewed, pinned
  packages from their expected source.
  [Source: yt-dlp plugin warning](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md#plugins)
- **Provider attack surface:** BgUtils is an unauthenticated token-generation
  service. Keep it un-published, profile-gated, and resource-limited.
- **Supply chain:** pin base images and the provider by digest, lock Python
  artifacts with hashes, use `docker build --pull` during scheduled updates,
  and scan the resulting image before release.
- **Volume permissions:** a bind mount owned by the wrong host UID will make
  downloads or SQLite fail. Fail startup with a clear message if `/data` or
  `/downloads` is not writable.
- **Disk growth:** media and partial files live outside the container lifecycle.
  Document capacity monitoring, backup policy for `/data`, and cleanup behavior
  for `/downloads`.
- **External instability:** YouTube behavior, PO-token enforcement, signed
  media URLs, and provider behavior can change independently of VDL. A passing
  build cannot guarantee future downloads.
- **Legal and policy obligations:** containerization does not change the
  operator's responsibility to respect copyright, licenses, website terms, and
  applicable law.

## Maintenance and update policy

The image is immutable. Never self-update yt-dlp, Deno, the plugin, or the
provider at runtime.

Review dependencies at least monthly and immediately after a repeatable
extractor failure:

1. Check the latest yt-dlp stable release, its YouTube changes, known issues,
   and EJS/runtime requirements.
2. Update the exact yt-dlp pin and regenerate the hashed Python lock.
3. Update Deno only to a version allowed by the selected yt-dlp release; record
   the exact pin and image digest.
4. If Stage 2 is supported, update the BgUtils Python plugin and server image
   together, keeping their versions matched.
5. Refresh Python and Deno base-image digests, rebuild with `--pull`, and scan
   for vulnerabilities.
6. Run binary/import checks, the representative network smoke, a merged media
   download, lifecycle checks, and the persistence check.
7. Record the test date and promote the image only after those checks pass.

yt-dlp warns that stable releases can become stale as sites change and exposes
nightly builds for newer fixes.
[Source: yt-dlp update policy](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md#update)
VDL should still prefer a reviewed exact stable pin. A nightly build is an
explicit emergency diagnostic or temporary release candidate, never an
unbounded production dependency.

## Rollout

1. **Build-only:** land the standard image, dependency lock, `.dockerignore`,
   and static version checks. Do not expose or deploy it yet.
2. **Local parity:** run Compose with fresh named volumes and verify the full
   native download lifecycle plus data persistence.
3. **403 validation:** run the dated, verbose byte-limited check and a UI
   download for the representative URL.
4. **Default deployment:** operate Stage 1 without any provider and watch image
   health, worker exits, download errors, disk growth, and file ownership.
5. **Optional provider pilot:** enable the `pot` profile only if a current
   failure or missing format calls for it. Confirm the provider is never host-
   published and compare behavior with it disabled.
6. **Browser decision:** open a separate feature only if the Stage 3 entry
   criteria are met. Do not silently expand this image to include Chromium.

Rollback consists of stopping the new container and starting the previous
known-good image against the same `/data` and `/downloads` volumes. Because the
feature does not change the database schema solely for containerization, this
rollback must not require a database downgrade.
