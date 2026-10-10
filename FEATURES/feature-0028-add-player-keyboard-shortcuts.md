# Add keyboard shortcuts to the built-in player

**Source:** User-requested feature  
**Status:** Implemented  
**Last refined:** 2026-10-04

## Decision summary

Add two keyboard shortcuts while the built-in video player is open:

- `F` requests fullscreen when playback is in the original-size overlay.
- `Space` toggles the current video between playing and paused, both in the
  original-size overlay and in fullscreen.

The shortcuts apply to ordinary and endless playback because both use the
same persistent `#playerVideo` element. They do not apply to videos opened in
a separate browser tab.

## Interaction contract

- Handle `f` and `F` without requiring the video element to have keyboard
  focus. Ignore modified forms using Control, Command, or Alt.
- Enable `F` only while the player presentation is `original`. Once standard
  or native WebKit fullscreen is active, another `F` press must not issue a
  duplicate fullscreen request.
- Use the standard `requestFullscreen()` path and its existing
  `webkitEnterFullscreen()` fallback. A rejected or unsupported request must
  leave original-size playback open and usable.
- Treat unmodified `Space` as play/pause. If the media is paused or ended,
  call `play()`; otherwise call `pause()`.
- Prevent Space from scrolling the page when it operates the player.
- Ignore repeated keydown events so holding a key cannot rapidly toggle
  playback or submit multiple fullscreen requests.
- Keep Space's native behavior when focus is on a visible player button or
  another editable/interactive control. In particular, Space must still
  activate Continue, Retry, Skip, Stop, Return to fullscreen, and Close.
- Do nothing when the built-in player is closed. Preserve existing page and
  dialog keyboard behavior outside the player.

## Playback-state integration

When Space resumes endless playback, observe the promise returned by
`play()` through the existing generation-aware playback controller so
autoplay denial and media failure retain their established recovery paths.
For ordinary playback, consume a rejected play promise without turning it
into an unhandled browser rejection; the native controls remain available.

The shortcuts must not replace the video node, change the current source,
alter launch provenance, create or advance an endless-playback session, or
change the saved **Start videos in full screen** preference.

## Accessibility

The shortcuts supplement rather than replace the visible native video
controls. Player action buttons retain native keyboard semantics and visible
focus. Space is not intercepted while focus is on a player button or editable
player control, and browser fullscreen-exit controls remain available.

## Acceptance criteria

- With an original-size built-in video open, pressing `F` requests fullscreen
  for `#playerVideo` exactly once.
- Pressing `F` while already fullscreen does not request fullscreen again.
- Pressing Space while paused starts playback; pressing it while playing
  pauses playback.
- Space continues to toggle playback after the video enters fullscreen.
- Holding either shortcut does not repeat its action.
- Space on a focused player action button activates that button rather than
  toggling the video.
- Neither shortcut affects the page when the built-in player is closed or the
  configured playback mode opens the video in a separate tab.

## Verification

Browser coverage in `tests/browser/playback.spec.cjs` verifies play/pause in
the original-size overlay, play in fullscreen, entry into fullscreen, and
suppression of a duplicate fullscreen request.

Run:

```bash
python3 tests/browser/run.py playback.spec.cjs --grep "player keyboard shortcuts"
./tests/run-all.sh --unit
```

This specification is documentation-only and does not require another
`VERSION` increment beyond the implementation's existing patch bump.
