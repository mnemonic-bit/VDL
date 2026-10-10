## 45. [Resolved] Fullscreen Escape ignored the playback launch mode

**Severity:** Medium

**Status:** Resolved and verified in version `0.30.6` on 2026-10-04.

The player can open a video in its original-size overlay or request full screen
immediately, according to the saved **Start videos in full screen** preference.
Before this fix, leaving browser full screen always exposed the overlay, even
when full screen was the video's initial presentation.

### Reproduction

1. In Preferences, select **Overlay** playback and enable **Start videos in
   full screen**.
2. Start a finished video by clicking its preview image.
3. After the video opens in browser full screen, press Escape.

**Actual:** The browser left full screen but the video continued playing in
the original-size overlay.

**Expected:** Escape should stop playback and close the player when the video
started in full screen. If the video started in the original-size overlay and
the user subsequently entered full screen with the video controls, Escape
should leave full screen and return to that overlay instead.

### Diagnosis

The player only handled Escape through the page's `keydown` listener. Browsers
handle Escape themselves while an element is full screen and do not reliably
deliver that key event to the page. The resulting `fullscreenchange` event had
no application handler, and the player stored no state distinguishing an
initial full-screen launch from full screen entered later through native video
controls.

### Resolution

Playback now records whether the current overlay session requested full screen
at launch. When the browser reports that document full screen has ended, that
session closes and unloads the video. Sessions launched in the overlay do not
set the flag, so entering and leaving full screen later preserves the overlay.
A rejected or unsupported launch request clears the state, and Safari's media
fullscreen exit event follows the same decision.

### Verification

Browser regressions cover both state transitions:

- Leaving a preference-launched full-screen session closes the overlay and
  removes its media source.
- Leaving full screen entered after overlay playback began keeps the overlay
  and media source active.

The focused Playwright reproduction is:

```bash
python3 tests/browser/run.py playback.spec.cjs --grep "full screen"
```
