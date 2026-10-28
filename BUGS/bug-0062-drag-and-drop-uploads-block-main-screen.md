## 62. [Resolved] Drag-and-drop uploads block access to the main screen

**Severity:** High — a local-file import can prevent use of the application
and access to controls for other work.

**Status:** Fixed locally in version `0.49.4` on 2026-10-28. The modal
registration/list-refresh blocking was reproduced before the fix. Confirmation
with large real videos in the affected deployment remains outstanding.

**Related:** [Feature 0021 — Import and export local videos](../FEATURES/feature-0021-import-and-export-local-videos.md)
already requires uploads in Current downloads and interaction after
registration. [Bug 0047](bug-0047-upload-overlay-remained-open-after-drag-left-page.md)
concerns leaving the page before dropping; this report concerns interaction
after a drop.

### Reported behavior and expected result

Uploading a larger video by dragging it into VDL blocked the UI for as long as
the upload took. The user wants the upload added to the download list and the
main screen available immediately. The same behavior must support multiple
videos added in a single drag.

**Expected:** Dropping files dismisses the drop overlay immediately. Every
dropped video gets its own entry in Current downloads, with preparation,
upload progress, and completion or failure feedback. Registration, transfer,
and validation continue while the user browses the library, starts other
work, or opens Current downloads. One slow file must not hold the screen or
hide access to its siblings.

### Reproduction in the affected deployment

1. Sign in and drag a large local video onto the main page.
2. Drop it and immediately try to browse the library, open New download, or
   open Current downloads before the upload completes.
3. Check whether an upload entry appears with its filename and byte progress.
4. Repeat with multiple videos selected in one desktop drag, including a
   large file and a smaller file. Check that each has a separate entry and
   that the page stays usable while any file is pending.

**Reported actual:** The upload blocks access to the UI until it completes.
The multiple-file case is a required acceptance scenario; the user did not
report a separate observation for it.

Record deployed API/UI versions, browser, file sizes, and the pending requests
when confirming this report. These details were not supplied. In particular,
distinguish `POST /api/upload` registration, `PUT /api/upload/<id>` transfer,
and collection reads. File size alone does not establish which request keeps
the overlay open.

### Controlled local reproduction

A temporary Playwright spec exercised real document-level file drag/drop
events against the isolated Flask browser fixture. Four-byte synthetic files
were sufficient: the UI defect depends on a pending request, so a large real
video is unnecessary for this minimal reproduction. Playwright routing held
one request boundary at a time; upload validation was not exercised.

| Scenario | Observed result |
| --- | --- |
| One file; hold its `PUT /api/upload/<id>` request | Overlay closes; Current downloads opens with the upload row. |
| One file; hold `POST /api/upload` registration | Overlay remains modal at `Preparing upload…`; hidden assertion fails after 1000 ms. |
| Two files; accept first registration, hold second registration and first transfer | Overlay remains modal at preparation for the second file; first row cannot be reached through the UI. |
| Two files; accept both registrations, hold both transfers | Overlay closes; Current downloads opens with two distinct rows. |
| One file; accept registration, hold transfer and subsequent `/api/current-downloads` read | Overlay remains modal; hidden assertion fails after 1000 ms. |

The command used for the repeated investigation was:

```bash
VDL_PYTHON=/workspace/myrepo/.venv/bin/python \
    python3 tests/browser/run.py upload-report-repro.spec.cjs --repeat-each=2
```

Result: **6 failed, 4 passed (21.0s)**, exit code 1. All three blocking
scenarios failed in both runs with `Expected: hidden; Received: visible`.
Both transfer-only controls passed in both runs.

The spec was temporary and removed after the investigation; this command
records the executed experiment, not an existing permanent test target.
To recreate the failing cases in `tests/browser/upload-drop.spec.cjs`, use its
existing `DataTransfer`/`File` drop setup, hold the indicated route with an
unresolved promise, and assert `#uploadDropOverlay` becomes hidden before
releasing that request. For the two-file registration case, let the first
POST reach the fixture, hold the second POST, and hold the first PUT.
For the passing controls, also click Current downloads and assert one or two
rows respectively while the PUT requests remain pending.

### Cause established in version `0.49.3`

- [`showUploadOverlay()`](../static/app.js#L539) calls `showModal()`. The
  underlying page is inert while the full-viewport dialog stays open; an
  asynchronous request alone does not restore page interaction.
- [`uploadDroppedVideos()`](../static/app.js#L603) registers files sequentially,
  awaiting each `registerDroppedVideo()` while the modal displays preparation.
  A delayed registration holds the modal and delays registration of later
  siblings. Escape is prevented while `uploadInProgress` is true.
- After all registrations, it awaits `fetchHistory()` before scheduling
  dismissal. That refresh awaits both Library and Current downloads reads.
  A slow read therefore also delays returning interaction to the user.
- Even after those requests resolve, a modal success message adds a fixed
  900 ms delay before dismissal.
- Transfer itself is already separate:
  [`registerDroppedVideo()`](../static/app.js#L585) starts the asynchronous
  PUT and returns its completion promise inside an object. The registration
  loop does not await transfer completion. `Promise.allSettled()` waits for
  transfers only after scheduling overlay dismissal.
- The backend already supports separate registration and transfer:
  [`start_video_upload()`](../vdl.py#L5582) creates an upload row and returns
  HTTP 202; [`receive_video_upload()`](../vdl.py#L5619) writes chunks and
  publishes persisted byte progress before marking successful files finished.

These observations confirm a modal lifecycle defect around registration and
refresh. They do not establish that the current code waits for every video
byte before closing the overlay, nor explain the exact deployed trigger of
the original large-file report.

### Proposed repair scope

Dismiss the drag overlay when files are dropped and move preparation into
individual Current downloads entries. Represent files awaiting registration
locally if necessary, then reconcile each with its server ID without duplicate
rows. Keep registration and list refresh independent of page availability.
Use a nonmodal confirmation if needed. Reuse the existing upload registration,
streaming, progress, Stop, and SSE reconciliation paths.

Process all files from the drop's `FileList`. A pending or rejected file must
not prevent accepted siblings from being visible and controllable. Each
failure needs its filename and useful feedback; it must not reopen a blocking
overlay or discard successful files. Background work here means work within
the open application tab; surviving a tab close is outside this report.

### Acceptance criteria and regression coverage

- A single-file or multiple-file drop closes the drag overlay immediately,
  without awaiting registration, collection reads, transfer, or validation.
  Feedback after a drop does not take modal focus or automatically open the
  Current downloads drawer.
- Every dropped video is represented once in Current downloads, including
  while registration is pending, and contributes correctly to its count.
  Reconciliation preserves the row's identity and file association.
- Each upload shows its own filename, preparation state, uploaded bytes and
  progress. Only successfully transferred and validated files move to History.
- The user can browse the library, open New download, and open or close Current
  downloads while files are registering, transferring, or being validated.
- Multiple videos from one drop proceed independently: a slow or failed file
  does not block access to other uploads or suppress successful siblings.
- Stop remains usable per active upload; stopping one does not stop siblings.
  Cancelled entries remain deletable. Uploads retain their existing lack of
  Pause/Continue and URL-specific actions.
- Registration, transfer, and validation failures identify the affected file
  without blocking the page. Further file drops remain possible while earlier
  uploads are pending.
- Add deterministic browser regressions for the five request-boundary cases
  above, mixed batch success/failure, a later drop during pending registration,
  per-file Stop, and successful completion into History. Assert actual clicks
  on page controls while requests remain pending, as well as overlay closure.
- Verify a genuinely large video and multiple real videos in the affected
  deployment, recording API/UI versions and browser. Existing upload tests
  cover a single-file import, drag exit, and Stop, but do not cover delayed
  registration, delayed collection reads, or a multiple-file drop.

### Repair

The drop handler closes the drag overlay synchronously and creates a preparation
entry for every dropped file before starting any registration. Accepting the
drop closes row menus so their reconciliation guard cannot hide preparation. Registrations
run independently, and later drops remain available. Each browser-generated
128-bit hex ID is validated and retained by the upload API; duplicate IDs are
rejected without replacing existing entries. Current downloads merges these
local entries with server snapshots by ID, retaining the same row when SSE
arrives before registration acknowledges it and when collection reads are slow.

Per-file rows show the original filename, preparation/transfer/validation state,
uploaded bytes, percentage, and failure feedback. Browser upload progress is
coalesced before rendering. Only server-confirmed validated media enters the
Library. Failed files remain individually removable without suppressing
successful siblings, reopening the overlay, or opening Current downloads.

Stop during preparation records cancellation locally and applies it when the
server acknowledges registration, without starting the transfer. Deleting that
entry also removes the server registration once acknowledged. Stopping a
registered upload with no receiver now publishes `cancelled` immediately so
it can be removed; active receivers retain their existing cancellation cleanup.

### Verification

The permanent browser regressions in `tests/browser/upload-drop.spec.cjs`
exercise held registrations and transfers, delayed collection reads, a second
file and later drop during registration, SSE before acknowledgement, stable row
identity, a drop while a row menu is open, mixed registration/transfer failure
and successful publication,
validation, and per-file Stop/Delete. They click page controls while requests
are pending and verify that no drop automatically opens Current downloads.
All **12 upload browser tests passed** against the final implementation,
including the menu-open regression. The initial delayed-registration regression
failed with the modal still visible before the implementation and passed after
the fix. The menu-open variant initially left the badge at zero and passed once
accepted drops closed row menus.

Unit regressions cover ID validation and collisions, compatibility with callers
that omit the optional ID, and Stop before transfer followed by rejected transfer
and successful removal. The no-receiver cancellation test failed before its
backend repair. The required unit gate passed on Python 3.12: **384 tests, 6 skipped**, with
**91.6% vdl.py line coverage (5064/5527; minimum 90%)**. Command:

```bash
PYTHONPATH="$PWD/.venv/lib/python3.11/site-packages" \
    VDL_PYTHON="$(command -v python3.12)" ./tests/run-all.sh --unit
```

Python 3.12 used the installed pure-Python application dependencies from the
existing environment; the earlier Python 3.11 run passed its tests but measured
86.6%, below the gate. Python 3.12 matches the GitHub Actions coverage runtime.

An isolated real-app smoke check on Chromium `153.0.8010.12`, API/UI `0.49.4`,
uploaded a 103,692,962-byte AVI and two 94,167-byte MP4 videos in one drop.
All three appeared during preparation; the overlay and drawer stayed closed,
page controls remained clickable after registration was released, and all three
completed native ffprobe validation and appeared in the Library at 360p/240p.
This verifies a local large-file and multiple-real-video batch, not the
reporter's deployed instance.

The full Chromium run finished with **286 passed, 2 failed (7.9 minutes)**.
The failures were the initial-Library retry-count assertion (four reads rather
than three) and the real fullscreen-crossfade completion timeout. Both also
had intermittent failures in the first focused reruns. A clean HEAD checkout
passed three focused runs of each. The upload reconciliation now returns the
existing collection array unchanged when no local uploads are pending, limiting
the new merge to its intended scope. With that adjustment, **all six focused
checks passed** (three runs of each); the full suite was not repeated after
this final scope adjustment.
