## 70. [Open] Player controls stay visible and lack direct playback actions

**Severity:** Medium — persistent controls obstruct the video, and expected
playback interactions are missing or unnecessarily verbose.

**Status:** Reported on 2026-10-30. Repository reference: commit `462915b`,
version `0.50.4`. This report records the user's observations and requested
behavior; no browser reproduction or implementation diagnosis was performed.

**Related:** [Bug 0041 — History video previews and player overlays](bug-0041-history-video-previews-were-redundant-and-firefox-incompatible.md)
previously specified hiding the close control after two seconds. This request
keeps the current title/Close header and specifies a shared three-second idle
delay for both the header and the bottom controls. See also
[Bug 0066 — Custom player controls](bug-0066-custom-controls-home-seek-does-not-reach-zero-in-github-actions.md)
for existing seek and keyboard regression coverage.

### Reported behavior

- The top header containing the video's title and **X / Close** control stays
  visible after the player has been idle for about three seconds.
- The bottom bar containing Play/Pause, volume, and other playback controls
  also remains visible instead of moving out of the video area.
- In fullscreen, the top header and bottom controls reserve vertical space,
  framing and reducing the video's height instead of overlaying a video that
  already occupies the full available screen area.
- Clicking the video surface does not provide the expected Play/Pause toggle
  that the Space key provides.
- The playback-rate combobox has an unwanted visible **Speed** label in front
  of the rate factors.
- The player needs a button to enable endless playback of the current video.

### Reproduction

1. Open a playable video in the application player and start playback.
2. Move the pointer over the player to expose its controls, then leave it
   stationary without interacting for more than three seconds.
3. Observe whether the title/Close header and bottom playback bar hide.
4. Click an unobstructed part of the video once while playing, then again
   while paused. Compare the result with pressing Space in the player.
5. Inspect the playback-rate combobox and its visible label.
6. Look for a control to repeat this same video indefinitely, and check what
   happens when the video reaches its end.
7. Enter fullscreen with the controls visible. Compare the video's bounds
   before and after the three-second idle delay, then reveal the controls
   again. Observe whether the bars reduce the available video height or their
   visibility changes the video's size or position.

### Expected behavior and acceptance criteria

1. **Hide both control areas after three seconds of inactivity.** During
   playback, the top title/Close header fades out, while the bottom playback
   bar slides downward completely out of sight. Hiding starts approximately
   three seconds after the last relevant player interaction. Hidden controls
   must not leave an opaque strip or an invisible pointer-blocking overlay
   over the video.
2. **Reveal controls on renewed activity.** Pointer movement over the player
   reveals both areas and resets the idle timer. Controls remain usable while
   the user operates them, including seeking, adjusting volume, choosing a
   playback rate, or using keyboard focus. Preserve keyboard access to Close
   and playback actions, and respect reduced-motion preferences.
3. **Toggle playback by clicking the video.** One primary-button click on the
   video surface pauses a playing video or resumes a paused one, using the
   same playback action as Space. It toggles exactly once per click. Clicking
   the header, Close, buttons, ranges, or the rate combobox must only perform
   that control's own action; dragging a range must not toggle playback.
4. **Show only rate factors in the speed selector.** Remove the visible
   **Speed** prefix/label. Retain the supported rate choices and current
   selection, displaying factors such as `1×` and `1.5×`. Keep an accessible
   name for assistive technology without restoring the visible label.
5. **Add an endless-playback toggle for this video.** A dedicated player
   button enables or disables repeating the currently open video. Its active
   state is visible and accessible, for example through a toggle button's
   pressed state. When enabled, reaching the end restarts the same video and
   continues until disabled or the player is closed. This is single-video
   repeat, separate from playlist advancement, Shuffle, or Shuffle Clips.
   Disabling repeat restores the normal end-of-video behavior; it does not
   change the global playback mode or other videos' playback preferences.
6. **Use the final fullscreen video size immediately.** On entering fullscreen,
   size the video against the entire fullscreen viewport, with the title/Close
   header and bottom controls layered over it. Neither bar may reserve layout
   height or add padding that shrinks the video. The video must already have
   its final size and position while the controls are visible; fading/sliding
   them away after three seconds, or revealing them again, must not resize,
   shift, or reframe it. Preserve the video's aspect ratio and existing fit
   behavior; any letterboxing should follow from the video's proportions,
   rather than space reserved for the controls.

### Regression coverage and completion

- Add browser checks for visibility before the idle deadline, both distinct
  hide animations after it, and immediate reveal/reset on renewed activity.
  Exercise the normal overlay and fullscreen player, with keyboard focus and
  reduced-motion preferences included.
- In fullscreen, compare video bounds with controls visible, hidden, and
  revealed again. Verify stable size and position throughout, with no height
  reserved for either bar. Cover matching-screen, wide, and portrait aspect
  ratios so legitimate letterboxing is distinguished from control-induced
  margins.
- Verify real media state for video-surface clicks and Space, including one
  toggle per click and no extra toggle from interacting with player controls.
- Verify the selector has factor-only visible text, retains an accessible
  name, and still changes the real media playback rate.
- Verify repeat-on restarts the same video at its end and keeps playing,
  repeat-off restores normal completion, and other playback modes remain
  unaffected. Cover closing the player and opening another video so repeat
  cannot accidentally leak into unrelated playback.
- Before resolving the eventual code change, apply its own version bump and
  run the relevant browser checks plus `./tests/run-all.sh --unit`, with
  `vdl.py` line coverage meeting the required 90% minimum.

This change creates the report and ledger entry only. Application code and
`VERSION` remain unchanged; runtime tests are not claimed for this report.
