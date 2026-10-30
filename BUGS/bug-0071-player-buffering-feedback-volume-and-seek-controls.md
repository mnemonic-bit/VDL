## 71. [Resolved] Player buffering feedback, volume reveal, and 10-second seek controls

**Severity:** Medium — buffering feedback is unclear and common playback
actions occupy unnecessary space or lack direct controls.

**Status:** Fixed and verified locally in version `0.50.6` on 2026-10-30. Originally reported
against commit `1674bbe`, version `0.50.5`, without a browser reproduction.

**Related:** [Bug 0070 — Player controls and playback actions](bug-0070-player-controls-stay-visible-and-lack-direct-playback-actions.md)
and [Feature 0047 — Custom player controls](../FEATURES/feature-0047-add-custom-player-controls.md).

### Reported behavior

- When a video needs data before starting or continuing playback, the
  buffering message appears near the bottom of the picture instead of in
  the middle. There is no waiting spinner like the Download dialog shows
  while waiting for metadata.
- The volume slider remains visible alongside the speaker symbol instead
  of appearing only when needed.
- The bottom bar lacks buttons beside Play/Pause to rewind or advance the
  current video by ten seconds.

### Reproduction

1. Open a playable video in the built-in player. Delay its media response or
   use network throttling so playback must wait for data before starting.
2. Observe the buffering message's position and whether a spinner appears.
3. Start playback, then seek into an unbuffered area or delay subsequent
   media data until playback must buffer again. Observe the same feedback
   while waiting to continue, and its dismissal when playback recovers.
4. Reveal the bottom controls. Move the pointer away from the speaker, then
   hover over it and move onto the volume slider to adjust the level.
5. Inspect the controls beside Play/Pause for rewind/forward ten-second
   actions. Repeat in fullscreen.

### Expected behavior and acceptance criteria

1. **Center buffering feedback over the video.** While waiting for data to
   start or continue playback, show a centered waiting spinner with the word
   **Buffering** immediately below it. Center the stack within the video
   area in both the overlay and fullscreen, including when the playlist
   queue is open. Match the Download dialog's metadata-waiting spinner and
   use the application's theme colors and reduced-motion behavior. The
   feedback must not shift or resize the video or obstruct the bottom
   playback controls.
2. **Reflect actual buffering state.** Show feedback for initial buffering
   and interruptions, including buffering after a seek. Remove it once the
   active video can continue. Ordinary user pause must not show a waiting
   spinner. Closing the player or loading another video clears stale
   feedback. Keep errors and recovery actions usable and distinct from
   buffering. Expose the buffering status accessibly without repeated
   announcements on every media event.
3. **Reveal volume on speaker hover.** Keep the speaker button visible when
   the bottom bar is shown, but hide the volume slider by default. Hovering
   over the speaker reveals the slider. Keep it visible while the pointer
   moves onto it and throughout adjustment; hide it after the pointer leaves
   the combined speaker/slider area and interaction ends. Preserve the
   speaker's mute/unmute action. Keyboard focus must also reveal the slider
   and retain it while focused; provide a usable reveal path on touch
   devices without hover. Retain the existing device-volume limitation hint
   on platforms that cannot adjust volume programmatically.
4. **Add rewind and forward ten-second buttons beside Play/Pause.** Put both
   actions in the bottom bar next to the existing Play/Pause control, with
   clear icons, tooltips, and accessible names such as **Rewind 10 seconds**
   and **Forward 10 seconds**. Each activation seeks the current video by
   minus or plus ten seconds from its current position. Clamp to valid
   seekable bounds and disable the actions when seeking is unavailable.
   Preserve playing/paused state and the existing explicit-seek behavior
   for configured playback boundaries. These actions must not invoke
   Previous/Next video navigation or double-toggle playback through click
   bubbling. Repeated activations should apply one seek per activation.
5. **Preserve the existing player interactions.** Apply these controls to
   direct playback and session modes, retaining the three-second idle hide
   behavior, fullscreen layout, keyboard access, and volume/mute state across
   video transitions. Keep controls usable at narrow widths and in both
   themes.

### Source observations and implementation pointers

- `static/app.js` handles direct-playback `waiting` and selected `stalled`
  events with `showPlayerTransition('Buffering…', [])`. The shared
  `showPlayerTransition()` currently sets status text and recovery actions;
  `templates/index.html` contains no spinner in `playerTransition`.
- Contrary to the reported lower placement, current `.player-transition`
  CSS already uses `top: 50%` and `translateY(-50%)`, introduced by Bug 0070.
  Verify the affected deployment and actual rendered bounds before
  attributing the placement to current source. The missing buffering
  spinner remains evident in the reviewed markup.
- The Download dialog's `optionsSpinner` and `.options-spinner` provide the
  reference appearance and reduced-motion behavior.
- The player markup puts `playerVolume` directly beside `playerMute`;
  `.player-volume-control` and `#playerVolume` currently provide no hover
  reveal behavior. Existing `updatePlayerListening()` owns volume changes.
- `commitPlayerSeek()` already validates and clamps seeks to seekable
  ranges. Route the new actions through the existing seeking behavior and
  control-state guards. Existing `playerPrevious` and `playerNext` navigate
  between videos and do not supply the requested ten-second actions.

### Regression coverage and completion

- Use controlled media delays for initial loading and mid-playback
  buffering. Assert the spinner/text order, centered rendered bounds, and
  disappearance on recovery in overlay and fullscreen. Include a paused
  control case and closing/reopening so stale feedback cannot leak.
- Verify the volume slider is initially hidden, appears on speaker hover,
  remains usable while crossing into and dragging it, and hides after
  leaving. Cover keyboard focus, touch access, mute behavior, and actual
  media-volume changes.
- Use real media to verify both ten-second actions while playing and
  paused, repeated clicks, start/end clamping, and unavailable seeking.
  Assert the active video remains the same and that control clicks do not
  trigger the video-surface Play/Pause handler.
- Exercise narrow layouts, both themes, reduced motion, fullscreen, and
  existing control auto-hide behavior. Before resolving the eventual code
  change, apply its own version bump and run relevant browser checks plus
  `./tests/run-all.sh --unit`, verifying at least 90% `vdl.py` line coverage.

### Implementation and verification

Browser regressions reproduced missing initial buffering feedback, the always
visible volume slider, and the absent seek buttons. The existing centered
status-panel positioning was retained; rendered bounds now verify the spinner
and text stack is centered over the video, including fullscreen and an open
playlist queue. The spinner reuses the Download dialog's theme colors and
reduced-motion styling.

Initial loads explicitly show buffering. Native waiting, seek, recovery, pause,
and playback-progress events maintain the feedback for direct and session
playback. The status text changes only when the message changes, avoiding
repeated live-region announcements. Loading another video or closing clears
stale feedback. Unsupported media can emit an error on its `<source>` child
without a video error event; that path now replaces buffering with recovery
actions as well.

Volume opens above the speaker on hover, keyboard focus, or touch. Its position
keeps the bar stationary during reveal, and its bounds stay inside the narrow
player. Active drags retain it even outside the combined area. Keyboard reveal
persists across the speaker-to-slider focus handoff so Tab cannot skip the
range. The speaker still toggles mute; device-volume hints and listening
preferences retain their existing behavior.

Rewind and Forward buttons flank Play/Pause and use `commitPlayerSeek()` for
seekable-range clamping and explicit intro/outro-boundary behavior. Disabled
states follow media capability and recovery/navigation guards. Browser checks
record one clock write per activation, no extra Play/Pause events, and the
same media source after repeated seeks. Forward clamping stops one millisecond
before exact EOF because WebKit can emit `ended` even during a paused seek to
the exact duration, advancing a session unexpectedly.

`tests/browser/player-buffering-actions.spec.cjs` covers delayed initial media,
incrementally delivered real WebM frames after an unbuffered seek, direct and
playlist buffering, fullscreen, both themes, reduced motion, pause, recovery,
close/reopen, hover, keyboard, pointer dragging, touch, narrow controls, and
playing/paused ten-second seeks in direct, sequential, and playlist modes.
The incremental-frame cases require WebM MediaSource support and explicitly
skip on engines without it.

All **16 new browser regressions passed in Chromium, Firefox, and WebKit**.
Run them with:

```sh
python3 tests/browser/run.py player-buffering-actions.spec.cjs
VDL_TEST_BROWSER=firefox python3 tests/browser/run.py player-buffering-actions.spec.cjs
VDL_TEST_BROWSER=webkit python3 tests/browser/run.py player-buffering-actions.spec.cjs
```

Synthetic playback harnesses hold native media requests so their simulated
events and clocks cannot race native decoder errors from placeholder bytes.
Real-media checks continue to exercise native buffering and source failures.
All **110** checks in the playback, crossfade, playlists, Shuffle Clips,
skip-video-edges, and duration-filter suites passed after this isolation.

The unit gate passed with Python 3.12.14 (**397 tests**, six skipped), with
**92.0% `vdl.py` line coverage** (`5139/5588`, minimum 90%):

```sh
./tests/run-all.sh --unit
```

The broader player interaction run reproduced Bug 0072's existing intermediate
animation-sampling failures in normal-motion overlay and fullscreen cases.
Both cases reached the expected hidden state before failing their intermediate
sample assertion. The reduced-motion idle checks and fullscreen sizing,
playback, repeat, focus, and drag checks passed.
