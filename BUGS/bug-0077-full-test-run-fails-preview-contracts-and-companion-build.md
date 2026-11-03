## 77. [Resolved] Full test run fails preview contracts and companion container build

**Severity:** Medium — two browser failures block the deterministic gate;
an additional container check cannot validate companion package states.
A user-visible thumbnail or preview defect has not been established.

**Status:** Fixed and verified locally in version `0.51.2` on 2026-11-03.
Originally reproduced locally on 2026-11-03 at commit
`097fb56cf7f79230b58f7fe34d5013458cae178c`, version `0.51.1`.
No fix was attempted during that original run. This report groups the failures
from one complete test run; it does not establish a shared cause between the browser assertions and
the container build failure.

### Results and scope

The four default tiers were run separately so the browser failure did not
prevent media and shipping-container checks from running. JavaScript tests,
extension validation, dependency-lock validation, preview-maintenance container
checks, and companion package-state checks were also run.

| Check | Result |
| --- | --- |
| Python unit/coverage tier, Python 3.12.14 | 437 discovered: 430 passed, 7 media tests skipped; `vdl.py` coverage **92.1%** (5,243/5,692; minimum 90%) |
| Chromium browser tier, Playwright 1.63.0 | **2 failed, 422 passed**, 13.2 minutes; exit code 1 |
| Separate native media tier | All 7 tests passed |
| JavaScript tests | All 20 tests passed |
| Shipping-container smoke checks | Passed with a freshly built image |
| Preview-maintenance container checks | Passed |
| Container dependency lock | Passed for Python 3.12/3.14 on amd64/arm64 |
| CodeQL pin and extension checks | Passed; extension lint emitted one Firefox Android compatibility warning |
| Companion signed/unsigned package-state check | Failed while building the unsigned fixture image; signed fixture was not reached |

Browser fixtures and native media tests used the existing Python 3.11.2
environment; the coverage tier used an isolated Python 3.12.14 environment.
Node.js was 22.23.4. Container checks used Podman 4.3.1 on linux/amd64.
Additional Firefox/WebKit browser runs and the optional arm64 companion
container run were not performed.

### Failure 1: thumbnail cache-header assertion

Test: `Library reload requests the current thumbnail cache version`, starting
at [`tests/browser/history-actions.spec.cjs:12`](../tests/browser/history-actions.spec.cjs#L12).
The initial thumbnail request returns HTTP 200, then the assertion at line 20
fails:

```text
Error: expect(received).toContain(expected)
Expected substring: "max-age=0"
Received string:    "private, no-cache"
```

**Expected:** The regression test and endpoint agree on the intended cache
contract, and the test verifies that reloading the Library requests the current
thumbnail version.

**Actual:** The test stops at the cache-header assertion before reaching its
subsequent reload/version checks. This result alone does not demonstrate that
the browser displays a stale thumbnail.

### Failure 2: hover-preview URL assertion

Test: `hover previews wait before loading and only play one montage at a time`,
starting at [`tests/browser/history-actions.spec.cjs:526`](../tests/browser/history-actions.spec.cjs#L526).
The final reported failure is the source assertion at line 572:

```text
Error: expect(locator).toHaveAttribute(expected) failed
Locator: locator('[data-row-id="hover01"] .history-preview').locator('.history-preview-video')
Expected: "/api/preview/hover01?v=5"
Received: "/api/preview/hover01?asset=56c54c475d9818b91e63efc6d19d2796"
Timeout: 3000ms
```

**Expected:** The test verifies the current preview URL contract while
preserving its delayed-loading and single-montage playback checks.

**Actual:** The element uses an asset identifier rather than the expected
numeric cache version. The preceding poll for one playback invocation passes;
the run does not establish a hover-playback failure. Assertions after the
source check are not reached.

The two browser failures show assertion/response mismatches. Whether the tests
are stale or application behavior violates the intended contract still needs
to be determined before changing either implementation or assertions.

### Failure 3: companion package-state build context is incomplete

[`tests/container/check-companion-states.py:37`](../tests/container/check-companion-states.py#L37)
copies an explicit list of backend files into a temporary build context.
That list omits `asset_generation.py` and `preview_maintenance.py`, both of
which the current Dockerfile requires. The first missing source aborts the
unsigned fixture build:

```text
Error: building at STEP "COPY vdl.py asset_generation.py preview_maintenance.py download_bandwidth.py download_history.py docker-entrypoint.sh VERSION ./": checking on sources under "/tmp/vdl-companion-states-n1ghk9k2/context": copier: stat: "/asset_generation.py": no such file or directory
```

Podman exits with status 125 and the Python runner exits with status 1 through
`subprocess.CalledProcessError`. This is a failure in the test's staged build
context: the shipping-container tier built from the complete repository and
passed. Neither signed nor unsigned package-state smoke validation completes
in this additional check.

**Expected:** Both staged package states build with all current application
dependencies and reach their independent smoke checks.

### Diagnosis and fix

The browser assertions predated the delivery contract introduced by
[Feature 0048](../FEATURES/feature-0048-upgrade-preview-caches-gradually-and-add-system-logs.md).
The endpoint deliberately returns `Cache-Control: private, no-cache`, which
requires revalidation before cached bytes are reused. Montage delivery uses
the server-issued asset URL/identity to pin a selected sequence throughout a
hover session, including when maintenance publishes its replacement.
Neither mismatch requires a change to application delivery behavior.

Version `0.51.2` updates the thumbnail test to check the intended cache header,
ETag revalidation with HTTP 304, and current-version requests both when opening
Library and after a page reload. The hover test obtains delivery identities
from the real Library API and checks the exact corresponding URLs. A controlled
browser clock verifies no load/play before 250 ms, followed by playback at the
deadline, while retaining single-montage, favorite-hover, and pointer-exit
checks. No arbitrary sleep is needed in this test.

The companion check now stages `asset_generation.py` and
`preview_maintenance.py` alongside the other runtime sources required by the
Dockerfile. Both unsigned and synthetic-signed amd64 fixture builds and their
independent shipping-container smoke checks pass.

### Reproduction commands

From the repository root, with the documented native, browser, and container
dependencies installed:

```bash
# Default tiers; run individually to collect results after a failure.
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
VDL_PYTHON="$PWD/.venv/bin/python" ./tests/run-all.sh --browser
VDL_PYTHON="$PWD/.venv/bin/python" ./tests/run-all.sh --media
CONTAINER_ENGINE=podman VDL_IMAGE=localhost/vdl-suite-check:local \
    ./tests/run-all.sh --container

# Additional failing package-state check.
CONTAINER_ENGINE=podman .venv/bin/python \
    tests/container/check-companion-states.py

# Focused browser reproduction command for follow-up investigation.
VDL_PYTHON="$PWD/.venv/bin/python" python3 tests/browser/run.py \
    history-actions.spec.cjs \
    --grep 'Library reload requests the current thumbnail cache version|hover previews wait before loading'
```

The default tiers and additional package-state command were run. The focused
browser command above has not been run; isolated repeatability and ordering
effects have not been assessed.

### Evidence

The complete browser log and failure traces were inspected. Local run logs
are under `/tmp/vdl-all-tests/`, including `browser.log`, `unit.log`,
`media.log`, `container.log`, and `companion-states.log`.
Playwright saved `trace.zip`, `error-context.md`, and `test-failed-1.png` in:

```text
tests/browser/test-results/history-actions-Library-re-770e5-ent-thumbnail-cache-version/
tests/browser/test-results/history-actions-hover-prev-01117--play-one-montage-at-a-time/
```

These are generated local artifacts and may be removed by later runs. The
failure messages and run results are recorded above so the report remains
usable without them. The working tree was clean after the test run.

### Acceptance criteria

- Establish the intended thumbnail cache headers and preview URL contract;
  repair the demonstrated mismatch while retaining behavioral coverage for
  cache refresh, delayed loading, and single-montage playback.
- Both affected browser tests pass in isolation and within the complete
  browser suite, without skips, expected-failure markers, or arbitrary sleeps.
- The companion package-state check stages every required application file
  and completes both unsigned and synthetic-signed image smoke checks on
  amd64. Synthetic fixtures do not establish Mozilla signature validity.
- Run the complete deterministic gate and the additional companion check
  before marking this report resolved. Any code fix receives its own version
  bump and passes the Python 3.12 unit gate with at least 90% `vdl.py` coverage.

### Verification of version 0.51.2

- The focused browser reproduction command passed both affected tests. Both
  also passed within the complete Chromium suite: **424 passed**, no failures
  or skips, in 13.0 minutes.
- `VDL_PYTHON=/tmp/vdl-test-py312/bin/python CONTAINER_ENGINE=podman
  VDL_IMAGE=localhost/vdl-bug0077:local ./tests/run-all.sh --all` passed every
  tier: Python unit/coverage, Chromium, all seven native media tests, and a
  freshly built shipping-container smoke check.
- The separate required `./tests/run-all.sh --unit` invocation also passed
  under Python 3.12.14: 437 discovered, 430 passed, seven media tests skipped;
  `vdl.py` line coverage **92.1%** (5,243/5,692; minimum 90%). The media tier
  subsequently ran and passed all seven deferred tests.
- `CONTAINER_ENGINE=podman .venv/bin/python
  tests/container/check-companion-states.py` completed both unsigned and
  synthetic-signed amd64 builds and their independent smoke checks. These
  synthetic fixtures do not establish Mozilla signature validity.
- All 20 JavaScript tests, CodeQL pin checks, extension lint/build/package
  validation, and dependency-lock checks for Python 3.12/3.14 on amd64/arm64
  passed. Extension lint retained its existing Firefox Android compatibility
  warning.

Resolution logs are `/tmp/bug0077-all.log`, `/tmp/bug0077-unit.log`,
`/tmp/bug0077-browser-green.log`, and `/tmp/bug0077-companion-green.log`.
