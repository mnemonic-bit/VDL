## 61. Playback account-switch tests fail in GitHub Actions after Shuffle Clips

**Severity:** Medium — blocks the browser-test CI gate; production impact is
not established.

**Status:** Resolved and verified locally in version `0.49.3` on 2026-10-28.
Both affected tests pass repeatedly and within the complete browser run.
That run has a separate upload-stop timeout, detailed below. The original
GitHub Actions artifacts were unavailable, but a controlled local reproduction
established the account-switch race described below.

**Related feature:** [Feature 0045 — Shuffle Clips](../FEATURES/feature-0045-add-shuffle-clips-playback.md),
implemented in version `0.48.0`. The failing run's exact commit, application
version, and workflow URL were not supplied.

### Reported behavior

The browser suite finished with **2 failed, 263 passed (4.2m)** and process
exit code **1**. Both failures are in
[`tests/browser/playback.spec.cjs`](../tests/browser/playback.spec.cjs), during
the return to the original admin account after switching to a temporary user
in the same browser context.

| Test | Failure location in supplied log | Observed failure |
| --- | --- | --- |
| `playback mode is scoped to account and survives sign-out on this browser` | Test starts at line 401; failure at line 422 | `page.goto('/')` is interrupted by another navigation to `/login`. |
| `Shuffle Clips remembers explicit invocation even on failure and remains account scoped` | Test starts at line 548; assertion at line 587 through helper line 53 | `#endlessPlaybackButton` is absent when its accessible label should be `Shuffle Clips`; assertion times out after 3000 ms. |

The first error is:

```text
Error: page.goto: Navigation to "http://127.0.0.1:37897/" is interrupted by another navigation to "http://127.0.0.1:37897/login"
Call log:
  - navigating to "http://127.0.0.1:37897/", waiting until "load"
```

The second error is:

```text
Error: expect(locator).toHaveAttribute(expected) failed
Locator: locator('#endlessPlaybackButton')
Expected: "Shuffle Clips"
Timeout: 3000ms
Error: element(s) not found
```

The missing element does not establish an incorrect stored mode. The second
failure's final URL and page contents are unknown without its artifacts.
The two failures are tracked together because they exercise the same account
switching flow; a shared cause has not been demonstrated.

### Reproduction scenarios

Use the isolated browser fixture with its seeded admin account and a finished
video. The existing tests exercise these steps:

1. As admin, choose **Shuffle** in the first test, or **Shuffle Clips** in the
   second. Confirm the main playback button reflects that explicit choice.
2. For Shuffle Clips, intercept playback-session creation with a controlled
   HTTP 400 `no_shuffle_candidates` response. Confirm the mode survives the
   failed invocation and a reload, and that the main button retries
   `shuffle_clips` rather than selecting another mode.
3. Create a temporary normal user through `/api/users`.
4. POST `/logout`, POST `/login` for the temporary user using `page.request`,
   then navigate the browser to `/`. Confirm the new account defaults to
   **Play All**.
5. POST `/logout`, POST `/login` for admin using `page.request`, then navigate
   to `/` again.
6. Confirm admin's original mode is restored: **Shuffle** or **Shuffle Clips**.
   Both reported failures occur at this return-to-admin stage.

After installing the documented browser-test dependencies, run from the
repository root:

```bash
python3 tests/browser/run.py playback.spec.cjs \
    --grep 'playback mode is scoped to account|Shuffle Clips remembers explicit invocation' \
    --repeat-each=10
```

Set `VDL_PYTHON` if Flask and yt-dlp are installed in a different Python
environment. This is a proposed focused reproduction command; it was not run
while writing this report. The failure frequency and whether suite order
affects it remain unknown.

**Expected:** After successful sign-in, navigation settles on the authenticated
Library with the playback button present. The temporary account starts with
Play All, and signing back in as admin restores that account's saved choice.
An explicitly invoked Shuffle Clips choice remains saved even when session
creation fails.

**Actual:** CI either aborts navigation because another navigation targets
`/login`, or cannot find the playback button when checking the restored mode.

### Evidence and investigation needed

The supplied output names these artifact directories:

```text
test-results/playback-playback-mode-is--2a69a-es-sign-out-on-this-browser/
test-results/playback-Shuffle-Clips-rem-fe2c7--and-remains-account-scoped/
```

Each contains `test-failed-1.png`, `error-context.md`, and `trace.zip` according
to the log. Their contents were not supplied or inspected. After downloading
the CI artifacts, inspect both traces with `npx playwright show-trace`.

- Record the failing commit and inspect each failure's final URL, screenshot,
  and DOM to establish whether the second failure also ends on the login page.
- Inspect logout/login responses, redirects, session-cookie changes, and
  concurrent browser requests around each account switch. Establish what
  initiates the competing navigation before assigning a cause.
- Compare focused repeated runs with the full suite on the CI environment.
  Distinguish an application authentication/navigation defect from missing
  synchronization in the test setup.

The existing test source confirms the account-switch sequence, but the log
alone does not prove a storage regression, authentication failure, timing race,
or defect in clip selection/playback. The local investigation and repair are
recorded below.

### Acceptance criteria

- Reproduce and explain the competing navigation and missing-button failure,
  using the CI traces or an equivalent captured reproduction.
- Both existing tests pass repeatedly and within the complete browser suite,
  with successful sign-in and authenticated navigation verified.
- Preserve per-account, per-browser mode isolation and restoration across
  reload/sign-out/sign-in, including persistence after failed Shuffle Clips
  invocation. Keep the label, icon, and tooltip assertions.
- Address the demonstrated cause without suppressing the tests, weakening
  their assertions, or relying on arbitrary sleeps.
- If a code fix is made, apply its own version bump and run
  `./tests/run-all.sh --unit` with at least **90% `vdl.py` line coverage**,
  plus the relevant browser tests, before marking this bug resolved.

### Local reproduction and cause

The original focused command passed all 20 invocations locally. Its request
log nevertheless showed protected Library reads returning 401 between the
API-only logout and login calls. A controlled browser reproduction held a real
unauthenticated `/api/library` response until after a successful admin login.
Releasing it left the browser on `/login`, and the playback-button assertion
failed with the same `element(s) not found` symptom as the supplied CI log.
The captured network trace showed a 302 login response and a delayed 401
response carrying an expired session cookie. A protected API read returned
200 immediately after login, then 401 after the held response was delivered;
even an explicit navigation to `/` subsequently redirected to `/login`.
Repeating the controlled scenario with the browser switch helper unloaded
the old page before the next login: delivering the stale response preserved
the new session, the API returned 200, and the playback button was present.

The tests changed the shared browser-context cookie jar through `page.request`
while the previous Library document, its SSE reconciliation, and asset-demand
requests were still running. `apiFetch()` navigates to `/login` on 401, which
can compete with the test's `page.goto('/')`. The authentication guard also
clears the session on unauthenticated requests; a late 401 response can expire
the cookie issued by the intervening login. Either ordering breaks the
assumption that successful API login means the browser has settled on the
authenticated Library. This local reproduction establishes the test setup
race; the original hosted-runner artifacts remain unavailable.

### Resolution

Both account-switch scenarios use the shared `switchAccount()` browser helper.
It submits the existing Sign out form, waits for the Sign in page, submits the
credentials through that page, checks the login response, and verifies the
Library URL, displayed username, and visible playback button. The previous
Library is unloaded before a new login begins. The Shuffle test also closes
its player with Escape before opening the account menu.

The original assertions for account isolation, restored mode, label, icon,
tooltip, reload persistence, and failed Shuffle Clips invocation remain in
place. The fix adds no arbitrary sleeps or authentication bypasses. Version
`0.49.3` records this test-code fix.

### Validation

- Both existing account-switch tests passed ten consecutive Chromium runs
  each (**20 passed**) with the original playback-mode assertions intact.
- The controlled delayed-401 reproduction failed on the API-only switch
  sequence and passed after unloading the old Library through the browser
  switch helper. Its test code and captured failure artifacts were kept in
  `/tmp/vdl-0061-repro.spec.cjs` and `/tmp/vdl-0061-evidence/` for local diagnosis.
- `VDL_PYTHON=/tmp/vdl-bug59-py312/bin/python ./tests/run-all.sh --unit`
  passed on Python 3.12: **381 tests**, six skipped, and **91.6%** `vdl.py`
  line coverage (5,053/5,516; required minimum 90%).
- The complete Chromium browser suite finished with **278 passed and one
  separate failure**: `an in-progress upload can be stopped and removed from
  Current downloads` timed out opening the stopped upload's menu at
  `upload-drop.spec.cjs:126`. Both BUG-0061 tests passed within this run. The
  upload-stop test passed **five consecutive isolated reruns** without any
  upload-code changes. The full browser gate was not completely green. The
  next hosted GitHub Actions run must confirm the account-switch fix in CI.
