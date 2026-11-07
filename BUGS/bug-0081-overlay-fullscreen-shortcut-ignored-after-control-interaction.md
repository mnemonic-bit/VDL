## 81. Overlay fullscreen shortcut is ignored after interacting with player controls

**Severity:** Medium — a player shortcut stops working during ordinary use;
the reported workaround interrupts playback.

**Status:** Fixed in version `0.53.1`. Reported on 2026-11-07 against repository
commit `f2c391b`, version `0.53.0`; independently reproduced in Chromium on
Linux with focus retained on `#playerPlayPause` after Pause then Play clicks.
The reporter's deployed version, browser, and operating system were not supplied.

**Related:** [Feature 0028](../FEATURES/feature-0028-add-player-keyboard-shortcuts.md)
defines `F` as fullscreen entry without requiring video-element focus.
[Feature 0047](../FEATURES/feature-0047-add-custom-player-controls.md)
introduces the custom player controls. Both feature contracts now clarify
that `F` remains available on player buttons, sliders, and the closed speed
selector while native control keys and editable input keep their behavior.

### Reproduction

1. Open a video in the built-in player's overlay mode, without entering
   fullscreen, and let it play.
2. Interact with the player controls.
3. Without clicking the video content, press `F`.
4. Click the video content itself, then press `F` again.

The reporter did not identify which controls were used in step 2. Record the
specific control and focused element when reproducing; do not assume that
every control triggers the problem.

**Actual, reported:** The first `F` press does not enter fullscreen. Clicking
the video content pauses playback, after which `F` successfully enters
fullscreen.

**Expected:** After using the player controls, pressing `F` enters fullscreen
directly from the overlay without requiring a click on the video content.
Fullscreen entry preserves the current play/pause state.

### Impact and workaround

The shortcut becomes unreliable after normal control interaction. The user
must click the video to make it work again, unintentionally pausing a playing
video and requiring another action to resume playback.

**Reported workaround:** Click the video content, then press `F`; resume
playback if the click paused it.

### Investigation scope

At report time, the two feature specifications differed: Feature 0028 made
`F` independent of video focus and reserved native control handling specifically
for Space; Feature 0047 said not to intercept shortcuts on buttons, sliders, selectors,
or editable fields. Investigate shortcut eligibility after control interaction
and whether retained focus accounts for the reported behavior. This was a
documentation observation before the independent reproduction below.

Clarify `F` handling separately from Space/Enter activation, arrow-key slider
adjustments, and input used by an open selector or editable field. Preserve
those native interactions while making fullscreen entry available after
ordinary player-control use. Do not require a video-surface click to restore
the shortcut.

### Acceptance criteria and verification

1. Reproduce with the actual control sequence and record browser, operating
   system, deployed VDL version, and focused element before pressing `F`.
2. With a video playing in the overlay, interact with the affected control
   and press `F` without clicking the video. The player enters fullscreen
   once and playback remains playing. Repeat while paused; it stays paused.
3. Cover focus after playback buttons, seek and volume sliders, and speed
   selection once its menu is closed. Verify native Space/Enter, arrow-key,
   open-selector, and editable-field behavior remains usable.
4. Preserve entry-only behavior: `F` while already fullscreen does not issue
   another request. Repeated keydowns and Control/Command/Alt combinations
   remain ignored; a closed player does not consume the shortcut.
5. Add a browser regression that interacts with real controls and sends a
   keyboard event without manually refocusing the video or player container.
   Assert fullscreen entry and unchanged playback state. Run the relevant
   player checks in Chromium and Firefox, plus the reporter's browser.
6. Before completing a code fix, run `./tests/run-all.sh --unit` and verify
   at least **90% `vdl.py` line coverage**. The fix requires its own PATCH
   version bump.

### Diagnosis and repair

The document-level shortcut handler applied the same interactive-control
exclusion to `F` and Space. Clicking Pause then Play left the button focused,
so the next `F` returned before requesting fullscreen. The browser regression
failed against version `0.53.0` on Linux x86_64 with Playwright Chromium
`153.0.8010.12`: `document.fullscreenElement` stayed null.
Clicking the video moved focus to the container and toggled playback, explaining
the reported workaround.

The handler now permits `F` on buttons and sliders inside `#playerContainer`
and on the closed `#playerSpeed` selector. It keeps focus in place and uses
the existing entry-only fullscreen path without toggling playback. Space
still belongs to focused controls; Enter and arrows retain native behavior.
Editable fields, other selectors, and open speed menus retain their input.
The speed selector uses native `:open` detection; browsers without that
selector support conservatively retain its native key handling.

### Regression coverage

`tests/browser/player-fullscreen-shortcut.spec.cjs` uses decoded WebM media,
real control interactions, and keyboard events without refocusing the video
or container. It checks both playing and paused states after playback, seek,
volume, and speed interactions; actual fullscreen entry; duplicate-request
suppression; and native-control, editable, repeat, modifier, and closed-player
guards. The reporter's browser remains unavailable for direct verification.

On Linux x86_64, all 11 new regressions pass in Chromium `153.0.8010.12`
and Firefox `155.0`. Together with `custom-controls.spec.cjs` and
`playback.spec.cjs`, 56 relevant cases pass per browser across broad runs
and targeted reruns. Chromium needed one retry for an unrelated download-menu
click timeout; Firefox needed a rerun of the modal-focus test after removing
its obsolete expectation that `F` on the closed speed selector was ignored.

The Python 3.12 unit gate (`./tests/run-all.sh --unit`) passes 525 tests
(9 skipped), with **92.7% `vdl.py` line coverage** (5732/6185 executable
lines; minimum 90%).
