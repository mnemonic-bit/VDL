# Feature 2: Runtime UI and API version visibility

**Status:** Proposed and ready for implementation  
**Last refined:** 2026-09-14

## Decision summary

Add one canonical application release number in a root-level `VERSION` file and
show the two copies a maintainer actually needs to compare:

- **UI version:** embedded into the server-rendered page and attached to the
  URLs of its static assets;
- **API version:** returned by the running backend from `/api/health` and read
  by the page at startup and during the existing health check.

The footer displays both values as `UI v0.1.0 · API v0.1.0`. If they differ,
the page shows a compact version-mismatch warning and asks the maintainer to
refresh. This makes a stale open page or stale cached asset visible instead of
showing one backend-derived value and implying that both halves match.

`0.1.0` is the initial versioned release. Later releases update `VERSION` in
the same change that implements the behavior requiring the bump. The
implementation also updates `AGENTS.md` with the mandatory bump policy so an
agent cannot consider a feature, bug fix, or breaking change complete while
the old version remains in place.

## Why this scope

The application currently has no release identifier in the page or its JSON
responses. A maintainer can inspect a container's dependency versions, but
cannot tell from the browser which VDL source release served the page or which
backend process now answers its requests.

A single value rendered twice from the current backend would only identify the
API. It would not reveal that an already-open page belongs to the previous
deployment. Keeping the UI's version in the HTML document and retrieving the
API's version over HTTP preserves that distinction while retaining one release
number for this single-image application.

## Goals

- Make the active UI and API release numbers visible without opening developer
  tools.
- Make the API version available to command-line and container operators.
- Detect when a page from one release is talking to an API from another.
- Keep the version source independent of Git, which is absent from the runtime
  image.
- Ensure cached JavaScript and CSS are tied to the UI release that rendered
  their page.
- Keep the existing health-check contract backward compatible.

## Non-goals

- Versioning individual HTTP endpoints or introducing URL namespaces such as
  `/api/v1`.
- Giving the UI and API independent release schedules. They are shipped from
  the same repository and container image.
- Exposing the yt-dlp, Python, Deno, ffmpeg, database-schema, or dependency-lock
  versions in the page.
- Deriving a release number from `.git`, file modification times, or the
  SQLite database.
- Adding a package manager, frontend build step, or JavaScript module system.
- Automatically refreshing the page when versions differ. A forced refresh
  could interrupt edits or other user interaction.

## Version semantics and source of truth

Add the repository-root `VERSION` file containing exactly one SemVer-compatible
application version
and a trailing newline:

```text
0.1.0
```

The number identifies the complete VDL release. The labels `UI` and `API`
describe where that release number was observed; they are not separate API
protocol and frontend-package versions.

At startup, `vdl.py` reads `VERSION` relative to `__file__`, strips the trailing
whitespace, validates the value, and stores it in an immutable module-level
`APP_VERSION`. A missing, unreadable, empty, or invalid file is a startup error.
Silently reporting `unknown` would defeat the operational purpose of the
feature and could allow a broken container build to pass unnoticed.

The accepted format is SemVer: `MAJOR.MINOR.PATCH`, with optional prerelease and
build metadata. Examples include `1.4.0`, `2.0.0-rc.1`, and
`2.0.0+build.184`. Do not add a runtime environment override: the page, API,
source checkout, and built image must not be able to claim different releases
through deployment configuration.

### Agent instruction and bump policy

As part of implementing this feature, add a concise, always-loaded rule to
`AGENTS.md` telling every agent to update `VERSION` in the same change as a
completed behavior change:

- implementing a feature increments `MINOR` and resets `PATCH` to zero;
- fixing a bug increments `PATCH`;
- introducing a breaking change, including an incompatible API change,
  increments `MAJOR` and resets `MINOR` and `PATCH` to zero; and
- when one change fits more than one category, apply only the highest-impact
  bump: `MAJOR` before `MINOR`, and `MINOR` before `PATCH`.

For example, `1.4.2` becomes `1.5.0` after a feature, `1.4.3` after a bug fix,
or `2.0.0` after a breaking change. This project applies the breaking-change
rule even while the major version is zero.

The `AGENTS.md` instruction must make the version update a completion
criterion, not optional release housekeeping. Documentation, tests, formatting,
and refactors that do not change shipped behavior do not independently require
a bump. The initial addition of versioning bootstraps `VERSION` at `0.1.0`;
after that file exists, every shipped behavior change follows the policy above.

## Data flow

```text
                          root VERSION
                               |
                  read and validate at startup
                               |
                         vdl.APP_VERSION
                         /               \
                        v                 v
        GET / renders UI version      GET /api/health
        into the HTML document        returns API version
                 |                           |
                 +------------+--------------+
                              v
                 UI v0.1.0 · API v0.1.0
                   (warn when they differ)
```

## Backend behavior

### Page render

Pass `APP_VERSION` to `templates/index.html` as `ui_version`. The rendered
document owns this value for its lifetime; JavaScript must not replace it with
the API response.

Use the version as a query parameter on both static asset URLs:

```html
<link rel="stylesheet"
      href="{{ url_for('static', filename='styles.css', v=ui_version) }}">
<script src="{{ url_for('static', filename='app.js', v=ui_version) }}"></script>
```

This does not require renamed files or a build manifest. A new release receives
new asset URLs, while repeated visits within one release may use the browser
cache.

Return the page with `Cache-Control: no-store`. The HTML is the record of the
UI release and must be obtained from the running process on navigation. The
versioned static files themselves may retain Flask's normal caching behavior.

### Health response

Extend the existing `GET /api/health` response without removing or renaming
`ok`:

```json
{
  "ok": true,
  "version": "0.1.0"
}
```

The additional key is backward compatible with the Docker health check, which
continues to require only HTTP 200 and `ok: true`. The health route remains
cheap and local: reading the version must not touch SQLite, the filesystem,
yt-dlp, or an external service per request because `APP_VERSION` was loaded at
startup.

Return `/api/health` with `Cache-Control: no-store` so an intermediary cannot
hide a backend replacement behind an old version response. A separate
`/api/version` endpoint is unnecessary while health already provides the
required runtime identity.

## Page behavior

Add a small, muted footer after the tab panels and before `app.js`:

```text
UI v0.1.0 · API checking…
```

Requirements:

- The UI value is present in the initial HTML and remains visible even when
  JavaScript fails or the API is unavailable.
- On page startup, request `/api/health`, validate that `version` is a non-empty
  string, and replace `checking…` with the API value.
- Reuse the existing 30-second health request to refresh the API value. Do not
  add a second polling timer.
- When the API value equals the UI value, render both in the normal muted footer
  style.
- When they differ, add a warning style and visible text such as `version
  mismatch — refresh`. Put the same explanation in an accessible status
  message; do not communicate the mismatch through colour alone.
- When health succeeds but has no usable `version` key, show `API unknown` and
  the mismatch warning. This covers a new UI temporarily reaching an older
  backend during a deployment.
- When the request fails, show `API unavailable`. The existing server banner
  remains the primary connection warning.
- Do not automatically reload, dismiss the mismatch, or write either version
  to `localStorage`.

Render the UI value with Jinja's normal autoescaping and assign API text with
`textContent`, not `innerHTML`. Style the footer exclusively with the existing
theme custom properties so it works in light and dark modes.

## Container and packaging behavior

The Dockerfile currently copies only an allow-listed set of runtime files.
Add `VERSION` to that allow-list so `APP_VERSION` resolves identically in a
native checkout and at `/app/VERSION` in the image. Keep application code and
the version file read-only in the final image.

Do not calculate the version with `git describe` during a container build:

- `.git/` is intentionally excluded from the build context;
- the same source archive must produce the same declared release number; and
- builds from release tarballs must work without Git metadata.

No Compose variable, volume, database migration, or new Python dependency is
required.

## Deliverables

- `VERSION` — canonical application release number, initially `0.1.0`.
- `vdl.py` — startup loading/validation, template value, response cache policy,
  and the extended `/api/health` payload.
- `templates/index.html` — versioned asset URLs and the visible UI/API footer.
- `static/app.js` — initial and recurring API-version reconciliation.
- `static/styles.css` — responsive, light/dark footer and mismatch styling.
- `Dockerfile` — copy `VERSION` into the runtime image.
- `AGENTS.md` — an always-loaded instruction requiring agents to apply the
  feature/minor, fix/patch, and breaking/major bump policy before declaring an
  implementation complete.
- Automated tests for version loading, page rendering, and the health contract.
- A short README release note explaining where the version is displayed and
  that maintainers bump `VERSION` when cutting a release.

## Acceptance criteria

### Source and startup

- A clean checkout contains `VERSION` with `0.1.0` and one trailing newline.
- `APP_VERSION` is loaded relative to `vdl.py`, not the process working
  directory.
- Starting or importing VDL from a different working directory still resolves
  the version.
- A missing, empty, or malformed version file fails immediately with an error
  that names `VERSION` and explains the expected format.
- There is no environment variable that can override the declared release.
- `AGENTS.md` states the bump policy, its precedence for mixed changes, and
  that updating `VERSION` is required in the same change as the implementation.

### API

- `GET /api/health` returns HTTP 200 and exactly the existing health state plus
  the application version: `{"ok": true, "version": "0.1.0"}`.
- The response has a no-store cache policy.
- Existing image and Compose health checks continue to pass unchanged.
- Repeated health requests do not read `VERSION` again.

### UI

- With JavaScript disabled, the page still visibly shows `UI v0.1.0` and an
  API placeholder.
- With a matching backend, the footer shows
  `UI v0.1.0 · API v0.1.0` without a warning.
- If the health response reports `0.2.0`, the page keeps
  `UI v0.1.0`, shows `API v0.2.0`, and displays the refresh warning.
- A successful health response without a version shows `API unknown`; a failed
  health request shows `API unavailable`.
- The footer remains legible on narrow screens and in both themes.
- The rendered CSS and JavaScript URLs contain `?v=0.1.0` (parameter order is
  not significant).
- No new health interval, frontend dependency, duplicated SVG, hard-coded theme
  colour, or browser-storage entry is introduced.

### Container

- `docker build -t vdl:local .` includes `/app/VERSION` in the final image.
- The file contains the same version returned by the container's
  `/api/health` endpoint and shown by a freshly loaded page.
- Changing only `VERSION` changes the page's static asset URLs on the next
  build.

## Verification

Add focused unit tests and run the full suite:

```bash
python -m unittest discover -s tests -v
```

The Flask test client should verify the health JSON, cache headers, rendered UI
version, and versioned asset URLs. Test the version loader with temporary
missing, empty, valid prerelease, and malformed files without modifying the
real `VERSION` during the test.

After building the image, verify the three independently observable values:

```bash
docker build -t vdl:local .
docker run --rm vdl:local python -c \
    'from pathlib import Path; print(Path("/app/VERSION").read_text().strip())'

docker compose up -d
curl --fail --silent http://127.0.0.1:5000/api/health
curl --fail --silent http://127.0.0.1:5000/ | grep -F 'UI v0.1.0'
```

Finally, leave the page open while replacing the backend with a deliberately
different test version. Within one health interval the footer must show both
values and the mismatch warning. Refresh the page and confirm the warning
clears and the UI value advances.

## Rollout and maintenance

Land the feature with `VERSION` set to `0.1.0` and the bump instruction present
in `AGENTS.md`. For every later behavior-changing implementation:

1. Change `VERSION` once according to the agent bump policy.
2. Build the immutable image from that commit.
3. Confirm the file, `/api/health`, and a freshly loaded page agree.
4. Record the version with the image tag used for deployment.

During a rolling replacement, a mismatch can be expected briefly for an open
tab. A mismatch that remains after a normal refresh indicates a stale cache,
proxy, or mixed deployment and should be investigated. Rollback requires only
starting the prior image; this feature has no persistent-data or database
compatibility impact.
