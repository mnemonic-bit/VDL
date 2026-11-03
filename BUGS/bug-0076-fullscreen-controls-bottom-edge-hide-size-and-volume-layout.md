## 76. [Resolved] Fullscreen controls need immediate bottom-edge hiding, smaller sizing, and an animated inline volume slider

**Severity:** Medium — fullscreen controls obscure too much of the picture,
and the volume reveal overlaps the playback timeline.

**Status:** Fixed and verified locally in version `0.51.1` on 2026-11-03.
Originally reported against commit `4aeeea8`, version `0.51.0`, with supporting
source observations. Browser regressions subsequently reproduced the
bottom-edge and volume-placement failures before the fix.

**Related:** [Bug 0070 — Player controls and playback actions](bug-0070-player-controls-stay-visible-and-lack-direct-playback-actions.md),
[Bug 0071 — Buffering, volume reveal, and seek controls](bug-0071-player-buffering-feedback-volume-and-seek-controls.md),
and [Feature 0047 — Custom player controls](../FEATURES/feature-0047-add-custom-player-controls.md).

### Reported behavior

- Fullscreen controls wait for the inactivity timeout before hiding. Moving
  the pointer to the bottom of the screen should hide them immediately,
  overriding that timeout.
- The controls are visually too large and occupy too much of the picture.
- The backward and forward seek icons contain a redundant **10** in their
  centers. Only the directional icons should be visible.
- Revealing volume places its slider above the speaker, overlapping the
  timeline. It should appear to the speaker's right with an animation.

The request calls the seek actions “1-seconds-forward and -backward.” Current
markup, accessible labels, and regression tests define ten-second actions.
This report treats the requested change as removing the visible numerals;
changing the seek interval is not an acceptance requirement.

### Reproduction

1. Open a playable video in the built-in player and enter fullscreen. Allow
   playback to continue normally without buffering or recovery messages.
2. Move the pointer over the video to reveal the controls. Before the
   three-second timeout expires, move it to the bottom edge of the screen.
   Observe whether the controls hide immediately or remain until idle.
3. Inspect the toolbar height, button spacing, and icon sizes. Inspect the
   numerals inside the backward and forward seek icons.
4. Hover over the speaker to reveal volume. Observe its placement relative
   to the speaker and timeline, and whether its reveal is animated.
5. Repeat volume reveal with keyboard focus and at a narrow player width.

### Expected behavior and acceptance criteria

1. **Bottom-edge movement overrides the fullscreen idle timeout.** During
   normal fullscreen playback, entering the bottom-edge trigger starts
   hiding the controls immediately, without waiting for the remaining idle
   interval. Cancel the pending timer so it cannot interfere with subsequent
   reveal. The request concerns the start of hiding; retain the existing
   hide transition and honor reduced motion. Ordinary pointer activity away
   from that edge retains the existing reveal and three-second idle behavior.
2. **Keep the toolbar usable.** Define the edge trigger narrowly enough that
   moving onto buttons or sliders does not hide them before use. Do not
   interrupt an active slider drag, keyboard interaction, or open speed
   selector, or conceal necessary buffering/recovery actions. Moving back
   into the video reveals the controls normally. Repeated movement along
   the edge must not make them flash back into view through a second
   pointer/mouse listener. Overlay playback retains its current idle rules.
3. **Make the controls visibly smaller.** Reduce the toolbar's visual height,
   icon size, and excess spacing while keeping the timeline, time display,
   speaker, and playback actions legible. Preserve accessible focus and
   usable pointer/touch targets, including Feature 0047's minimum 44-by-44
   CSS-pixel touch targets. Verify the complete image remains fitted as
   before and the toolbar does not overflow at narrow widths. Exact smaller
   dimensions need visual review rather than an arbitrary size in this report.
4. **Use seek icons without visible numerals.** Remove the central **10**
   from both directional icons. Preserve accurate tooltips and accessible
   names, seek amount, clamping, and playing/paused behavior. These remain
   seek actions within the current video, separate from Previous/Next video.
5. **Reveal volume horizontally to the right of the speaker.** Keep the
   slider aligned with the speaker in the button row, without overlapping
   the timeline, other actions, or the player boundary. Animate its reveal,
   for example with horizontal expansion and opacity, rather than abruptly
   switching between hidden and visible. Respect reduced motion. Avoid
   shifting the toolbar vertically or causing distracting control jumps.
6. **Retain volume interaction paths.** Hide volume by default; reveal on
   speaker hover, keyboard focus, and the existing touch interaction. Keep
   it visible while crossing from the speaker onto the slider, while focused,
   and throughout dragging. Hidden volume must not capture pointer input or
   keyboard focus. Preserve mute, actual media-volume updates, device-volume
   limitation hints, and listening state across video transitions.

### Source observations and implementation pointers

- [`static/app.js`](../static/app.js): `PLAYER_CONTROLS_IDLE_MS` is `3000`.
  `showPlayerControls()` reveals the controls and resets that timer;
  `hidePlayerControls()` handles visibility, interaction guards, and inert
  state. `initializePlayerControls()` binds container `pointermove` to
  reveal, and `playerBackdrop` also binds `mousemove` to reveal. Coordinate
  both event paths when introducing bottom-edge behavior.
- [`static/styles.css`](../static/styles.css): `.player-control-button` uses
  44-pixel minimum dimensions and 22-pixel icons; range controls also have
  a 44-pixel minimum height. The separate timeline and button rows, plus
  toolbar padding, contribute to its footprint. Review visual density while
  preserving usable interaction areas.
- `#playerVolume` uses `position: absolute; bottom: 100%; right: 0`, placing
  it above the speaker. Reveal rules switch `display: none` to `block`,
  with no volume reveal transition. Existing keyboard, adjusting, and touch
  classes must continue to work with the new placement and animation.
- [`templates/index.html`](../templates/index.html): shared `i-rewind-10`
  and `i-forward-10` SVG symbols draw their numerals as path segments.
  Removing visible text requires editing those shapes, not the accessible
  button labels. Continue using shared symbols.

### Regression coverage and completion

- Extend [`player-interactions.spec.cjs`](../tests/browser/player-interactions.spec.cjs)
  to enter fullscreen, reveal controls, and move to the bottom edge before
  the timeout. Assert that hiding begins without advancing the idle timer,
  then verify its final rendered state and hit testing. Cover repeated edge
  movement, return-to-video reveal, ordinary idle behavior, slider dragging,
  keyboard focus, and normal/reduced motion.
- Extend [`player-buffering-actions.spec.cjs`](../tests/browser/player-buffering-actions.spec.cjs)
  to assert that the revealed volume slider sits to the speaker's right and
  does not intersect the timeline or neighboring controls. Verify a rendered
  intermediate reveal state under normal motion and usable final bounds
  under reduced motion. Retain hover crossing, dragging, keyboard, touch,
  mute, and actual media-volume assertions.
- Review compact sizing and numeral-free icons visually in both themes,
  overlay/fullscreen, and narrow layouts. Retain real-media seek checks and
  verify that changing presentation does not change seek duration or navigation.
- Before resolving an eventual code fix, apply its own `VERSION` bump, run
  the relevant browser suites, and run `./tests/run-all.sh --unit`, verifying
  at least **90% `vdl.py` line coverage**. This documentation-only report
  left `VERSION` unchanged; the implementation below applies its own patch bump.

### Implementation

Both pointer and compatibility mouse movement now use the same fullscreen-edge
handler. The trigger occupies only the last four pixels of toolbar padding;
buttons and ranges retain their own hit areas. Hiding cancels the idle timer
and uses the existing guards for dragging, keyboard focus, speed selection,
paused playback, buffering, and recovery. Overlay movement keeps the existing
idle behavior.

Mouse controls use 18-pixel icons, 36-pixel buttons, a 32-pixel timeline hit
area, and less padding, reducing a single-row toolbar from 96 to 72 pixels.
Touch, hybrid, and narrow layouts retain 44-pixel targets. Both seek symbols
keep their directional arrows and omit the numeral paths; accessible names,
ten-second seeks, and navigation remain unchanged.

Volume now expands horizontally beside the speaker with width and opacity
transitions. Its space is reserved in the flex row so revealing it cannot
move other actions or change the toolbar height. Hidden volume is invisible
and cannot receive pointer input or focus. The existing hover, keyboard,
touch, and drag states remain responsible for its reveal, with transitions
disabled for reduced motion.

### Verification

All 90 Chromium checks passed across `player-interactions.spec.cjs`,
`player-buffering-actions.spec.cjs`, `custom-controls.spec.cjs`, and
`fullscreen-fit.spec.cjs`. New checks cover immediate edge hiding and timer
cancellation, repeated edge movement, hit testing, return-to-video reveal,
overlay behavior, keyboard focus, range dragging, an open speed picker,
buffering/recovery guards, intermediate volume animation, reduced motion,
stable layout, and touch targets. Existing real-media checks retain ten-second
seeking, mute/listening state, and complete-frame fullscreen fitting.

Desktop and 360-pixel layouts were visually reviewed in light and dark themes,
including overlay and fullscreen playback. The toolbar is visibly smaller on
desktop, both seek icons omit numerals, and the revealed volume remains in its
row without intersecting the timeline or other actions.

`VDL_PYTHON=/tmp/vdl-0073-python312/bin/python ./tests/run-all.sh --unit`
passed under Python 3.12: 437 tests ran, seven skipped, with **92.1% `vdl.py`
line coverage** (5243/5692; required minimum 90%).
