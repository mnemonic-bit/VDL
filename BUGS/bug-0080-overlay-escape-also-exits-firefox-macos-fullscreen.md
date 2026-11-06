## 80. [Open] Overlay Escape also exits Firefox macOS application fullscreen

**Severity:** Medium — dismissing playback unexpectedly changes the browser
window's presentation and interrupts the user's fullscreen workflow.

**Status:** Open. Reported on 2026-11-06; analyzed against commit `a5cb65a`,
version `0.51.4`. The uncanceled Escape event is reproduced in Chromium and
Firefox on Linux. The macOS window transition is reporter-observed and still
requires native verification. No application fix is included in this report.

**Affected environment:** Firefox on macOS, with the browser window in
application fullscreen and video playing in VDL's overlay. The reporter's
Firefox, macOS, and deployed VDL versions were not supplied.

**Related:** [Feature 0008](../FEATURES/feature-0008-fix-macos-fullscreen-escape.md)
records the same overlay/fullscreen concern and is marked implemented.
[Bug 0046](bug-0046-info-tag-selection-closed-popover-and-escape-exited-fullscreen.md)
fixed an uncanceled Escape event in History Info, but the current player branch
still lacks cancellation.
[Bug 0045](bug-0045-fullscreen-escape-ignored-playback-launch-mode.md)
covers the separate behavior of leaving a video element's fullscreen mode.

### Reproduction

1. Open VDL in Firefox on macOS and put the **browser window** into native
   application fullscreen using the green window control or the browser's
   fullscreen menu command.
2. Select **Overlay** playback and disable **Start videos in full screen**.
3. Open a finished video and leave it playing in the overlay, with the VDL
   page visible around the player. Do not enter the player's fullscreen mode.
4. Press Escape once.

**Actual, reported:** Playback stops and the overlay closes, but Firefox also
leaves macOS application fullscreen.

**Expected:** The same Escape press stops playback and closes only the overlay.
Firefox remains in its existing application fullscreen state.

Application fullscreen and the Fullscreen API are separate states. This case
does not require a fullscreen video element or a non-null
`document.fullscreenElement`; checking that property alone cannot establish
whether the macOS browser window stayed fullscreen.

### Source evidence and diagnosis

- The document `keydown` listener in
  [`static/app.js`](../static/app.js#L6955) respects `defaultPrevented`, then
  calls `closePlayer()` when Escape finds `#playerBackdrop.open`. That branch
  does **not** call `ev.preventDefault()`. Neighboring branches for dialogs,
  Settings, Current Downloads, the account menu, and History Info do.
- [`handlePlayerShortcut()`](../static/app.js#L6931) handles Space and F, so
  it does not consume Escape before the document listener reaches that branch.
- [`closePlayer()`](../static/app.js#L6135) pauses and unloads the video,
  removes the overlay's open state, and restores focus. It receives no keyboard
  event and does not cancel the triggering event. Its `document.exitFullscreen()`
  call is guarded by a fullscreen element matching a player element. That guard
  is false in the reproduced overlay case.
- Mozilla's [Bug 1732367 description](https://bugzilla.mozilla.org/show_bug.cgi?id=1732367#c0)
  explicitly identifies websites handling Escape without `preventDefault()`
  as a cause of unintended macOS fullscreen exits. This supports the missing
  cancellation as the likely explanation for the reported second action;
  native verification remains necessary for the reporter's browser version.

The demonstrated defect is that VDL handles Escape but leaves the browser
default action available. Closing the DOM overlay successfully does not mean
the key was consumed. The absence of cancellation matches the defect already
fixed for History Info in Bug 0046.

### Diagnostic verification

A temporary Playwright probe opened the real overlay through the finished
video's Play action, installed a bubbling `window.keydown` observer after the
application's document listener, and sent a trusted key with
`page.keyboard.press('Escape')`. It asserted both that the overlay closed and
that the handled event had `defaultPrevented === true`.

The probe was run against each browser using the existing isolated fixture:

```bash
VDL_PYTHON="$PWD/.venv/bin/python" VDL_TEST_BROWSER=chromium \
  .venv/bin/python tests/browser/run.py escape-report-probe.spec.cjs
VDL_PYTHON="$PWD/.venv/bin/python" VDL_TEST_BROWSER=firefox \
  .venv/bin/python tests/browser/run.py escape-report-probe.spec.cjs
```

Both runs failed the cancellation assertion with `Expected: true; Received:
false`. Both observed the same state after the application handler:

```json
{"defaultPrevented":false,"cancelable":true,"trusted":true,"overlayOpen":false,"paused":true,"sources":0,"documentFullscreen":null}
```

The temporary spec was removed after diagnosis; the commands above record
that investigation rather than name a permanent regression test. To inspect
the event again without adding a test file, run this in the browser console
before opening the overlay, then focus the page and press Escape:

```javascript
window.addEventListener('keydown', function inspectOverlayEscape(event) {
    if (event.key !== 'Escape') return;
    console.log({
        defaultPrevented: event.defaultPrevented,
        overlayOpen: document.getElementById('playerBackdrop').classList.contains('open'),
        paused: document.getElementById('playerVideo').paused,
        sources: document.querySelectorAll('#playerVideo source').length,
        documentFullscreen: document.fullscreenElement,
    });
    window.removeEventListener('keydown', inspectOverlayEscape);
});
```

The existing overlay-close test in
[`playback.spec.cjs`](../tests/browser/playback.spec.cjs#L65) only checks that
Escape removes the open class. The two adjacent fullscreen-exit tests use a
synthetic Fullscreen API harness. None of those three assertions detects an
uncanceled overlay Escape or verifies a native macOS window transition.
History Info already has a suitable cancellation assertion in
[`tags.spec.cjs`](../tests/browser/tags.spec.cjs#L73).

All three existing playback checks passed in each browser during this
investigation (six passing checks in total), using this command with
`VDL_TEST_BROWSER` set to `chromium` and then `firefox`:

```bash
VDL_PYTHON="$PWD/.venv/bin/python" VDL_TEST_BROWSER=firefox \
  .venv/bin/python tests/browser/run.py playback.spec.cjs \
  --grep 'overlay playback assigns MIME|Escape closes playback that started|Escape returns manually entered'
```

These passing checks establish the coverage gap, not resolution of this bug.
The full unit/coverage gate was not run for this documentation-only change.

### Proposed repair and acceptance criteria

Cancel the handled Escape event with `ev.preventDefault()` before
`closePlayer()` in the existing player branch. Keep cancellation scoped to an
open player and retain the existing `defaultPrevented` guard for controls
that consume the key themselves. Confirm this change against the original
native reproduction before calling the bug fixed.

1. In Firefox on macOS, with the browser window fullscreen and video in the
   overlay, one Escape press closes the overlay, pauses/unloads playback, and
   leaves the browser window fullscreen. Repeat with focus on the player
   container and its playback, seek, volume, and close controls.
2. An automated regression opens the real player and observes the trusted
   Escape event after document handling. Require `defaultPrevented === true`,
   a closed overlay, paused media, and no remaining source. Run in Chromium
   and Firefox; this checks cancellation, not native macOS fullscreen.
3. Escape still closes overlay playback in an ordinary browser window.
   With no player or other dismissible application layer open, VDL does not
   globally suppress the browser's Escape behavior.
4. Preserve Bug 0045's launch-mode semantics: leaving initially fullscreen
   playback closes the player; leaving fullscreen entered later returns to
   the overlay. Preserve inner controls' already-handled Escape behavior.
5. Before completing a code fix, run `./tests/run-all.sh --unit` and verify
   at least **90% `vdl.py` line coverage**, plus the focused browser tests and
   the native Firefox/macOS reproduction. The fix needs its own PATCH bump;
   this documentation-only report leaves `VERSION` unchanged.
