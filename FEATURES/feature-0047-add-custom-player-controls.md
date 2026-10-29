# Add custom controls to the built-in player

**Source:** User-requested feature\
**Status:** Implemented\
**Implemented:** 2026-10-29 · Version `0.50.0`\
**Last refined:** 2026-10-28\
**Extends:** [Feature 0028, Player keyboard shortcuts](feature-0028-add-player-keyboard-shortcuts.md)\
**Interacts with:** [Feature 0027, Endless Library playback](feature-0027-endless-library-playback.md),
[Feature 0030, Shuffle playback](feature-0030-add-shuffle-playback.md),
[Feature 0031, Personal video playlists](feature-0031-add-personal-video-playlists.md),
[Feature 0040, Preloading and crossfades](feature-0040-preload-and-crossfade-play-all-and-shuffle.md),
[Feature 0041, Skip video intro and outro](feature-0041-skip-video-intro-and-outro-during-playback.md), and
[Feature 0045, Shuffle Clips](feature-0045-add-shuffle-clips-playback.md)

## Decision summary

Replace the browser's visible video controls in VDL's built-in player with
VDL controls for playback, seeking, sound, speed, fullscreen, and contextual
playlist navigation. Match the application's visual style and make the same
controls available in the overlay and standard fullscreen.

Keep HTML `<video>` as the media engine and retain the existing playback
controller, authorized media URLs, session selection, progress saving, and
two-video crossfades. This feature changes the player interface; it does not
introduce a decoder, transcoder, frontend framework, or third-party player.

## Scope and presentation

- Apply to direct video playback, Play All, Shuffle, Shuffle Clips, and
  playlists in the built-in player. Videos opened in a new browser tab retain
  the browser's player. Library hover previews remain unchanged.
- Use a bottom control bar with a timeline above its buttons. Show the current
  title and, for session playback, the current mode. Keep Close discoverable
  at the top of the player. Escape and background-click behavior remain
  governed by the existing player interaction rules.
- Use the existing theme variables and shared SVG symbol library. Controls
  need a readable background over bright and dark footage, visible focus,
  and sufficient contrast in both application themes.
- At narrow widths, wrap or use a labeled overflow menu for secondary
  controls. Keep Play/Pause, seeking, time, fullscreen, and Close reachable
  without horizontal page scrolling. Provide touch targets of at least
  44 by 44 CSS pixels for buttons and usable slider hit areas.
- Keep the playlist queue available, with an accessible show/hide control
  where space requires collapsing it, including in standard fullscreen.
  Opening or closing the queue does not pause or reload the video.

## Controls

| Control | Required behavior |
| --- | --- |
| Play/Pause | Reflect the active video's actual state and use the existing playback controller to start or pause it. At a completed direct-playback boundary, Play follows the existing restart behavior. |
| Seek bar | Display the current video's original full-file timeline; allow pointer, touch, and keyboard seeking when the media permits it. |
| Time | Show elapsed time and total duration as `M:SS`, or `H:MM:SS` for times of an hour or longer. Show `--:--` for unavailable values; never display `NaN` or `Infinity`. |
| Mute | Toggle mute without losing the user's chosen nonzero volume. Expose the actual mute state accessibly. |
| Volume | A labeled 0–100% range controlling the user's intended listening level, independent of temporary crossfade gains. If the platform does not permit programmatic volume adjustment, disable this range and explain that device controls adjust volume. |
| Playback speed | A labeled selector offering 0.5×, 0.75×, 1×, 1.25×, 1.5×, and 2×. Default to 1× and reflect the value actually accepted by the media engine. |
| Fullscreen | Enter or leave standard fullscreen for the complete player interface. Use an appropriate native fallback when container fullscreen is unavailable. |
| Close | End playback and close the player through the existing cleanup and playlist-progress paths. |

Keep volume, mute, and speed selections across video loads and handoffs in
the current page session, including switching between direct and session
playback. Initialize them to 100%, unmuted, and 1× on a fresh page session;
clear this state on account change. No new stored preference or cross-device
persistence is required. Subsequent controls must reflect actual supported
media state, including changes received through media events.

## Session and playlist navigation

- During Play All, Shuffle, and Shuffle Clips, provide **Next video** using
  the existing session advance path. In Shuffle Clips it skips the current
  excerpt. Preserve each mode's existing selection and wrap rules.
- During playlist playback, provide **Previous video** and **Next video**
  using the existing queue-selection path. Choose the nearest available
  entry before or after the current queue position, skipping entries marked
  unavailable. Disable the corresponding control at either end; do not wrap
  or introduce a shuffle/history model. Save current progress before selecting
  another entry, as selecting a queue row does today.
- Hide video-navigation controls during direct playback. Hide Previous for
  Play All, Shuffle, and Shuffle Clips; this feature adds no session backstack.
- Show the current mode as information. Starting or changing a playback mode
  continues through the existing Library controls; no in-player mode switch
  or new shuffle preference is required.
- Allow at most one navigation request at a time. Disable conflicting
  navigation while preparation is committing or an advance/select request
  is pending. Repeated clicks must not create duplicate advances, views,
  progress updates, or sessions.
- Keep existing Continue, Retry, Skip, Stop, Return to fullscreen, and Close
  recovery actions available when their states require them. A toolbar button
  must not bypass the established recovery state or overlap its actions.

## Seeking and time display

- Use media metadata and the active element's current time, duration, and
  seekable ranges. The seek range is disabled until duration is finite and
  positive and the media can accept a seek. Update it as metadata and ranges
  change, without polling the server or probing media.
- Pointer/touch dragging previews the requested position and time label;
  commit one seek on release. Cancelling a drag leaves playback position
  unchanged. Keyboard adjustments commit through the same seek operation.
  Do not let incoming time updates move a thumb while it is being dragged.
- Clamp committed targets to the file timeline and available seekable ranges.
  Seeking alone preserves play/pause state and does not call Play. Cancel a
  pending drag if the current logical item changes; never apply its target
  to the next video.
- Preserve the existing per-item boundary controller. With intro/outro
  skipping enabled, seeking into the intro or outro retains Feature 0041's
  explicit-seek behavior. In Shuffle Clips, seeking before the excerpt start
  returns to that start, seeking inside retains its bounds, and seeking to or
  beyond the excerpt end completes it once. Seeking never draws a new excerpt.
- Show full-file elapsed and total time in every mode, including trimmed
  playback and Shuffle Clips. Do not relabel excerpt time as a new short file
  or change stored playlist positions to a relative timeline.
- When a seek is rejected or fails, restore the displayed position from the
  media element and preserve the existing recovery behavior. Never leave the
  interface claiming a position the media did not reach.

## Crossfades and playback state

The controls follow the **logical current item**. Before an authorized
crossfade handoff commits, that is the outgoing video. At the start of the
committed overlap, switch title, time, timeline, and control actions together
to the incoming item, following Feature 0040. A prepared standby video must
not update visible controls or take keyboard focus.

- Resolve the active media element when an action runs. Existing crossfades
  exchange the active and standby roles; do not capture a permanently active
  DOM node or recreate video elements to add the controls.
- Pause and resume during an overlap affect both media clocks through the
  existing controller. Seeking the incoming item ends the overlap through
  its established cancellation path before applying the seek.
- Store the user's intended volume separately from per-element fade gains.
  Automatic `volumechange` events during a fade must not move the volume
  slider or overwrite that intention. Changing volume or mute during a fade
  immediately updates both sides under the existing gain envelope, with no
  jump back after completion or cancellation.
- Apply a speed change to both playing elements during an overlap and to
  the next item when it becomes active. Fade timing continues to use media
  time; pausing or buffering cannot let a wall-clock animation finish it.
- Update Play/Pause from media events, rather than assuming that a click or a
  resolved request means playback started. Preserve rejected-play handling,
  stalled-media feedback, and existing generation/epoch guards against late
  callbacks from a closed player or replaced session.
- Show existing loading and recovery messages without hiding usable controls.
  Disable only actions that cannot operate in the current state; Close stays
  available. Do not announce the playback clock through a live region.

This feature must not alter transition timing or decide a separate fallback
when a successor is late. In particular,
[Bug 0064](../BUGS/bug-0064-shuffle-clips-shows-empty-player-before-next-video-is-ready.md)
records a requested revision to Shuffle Clips continuity. Integrate with that
repair if present; do not treat the older hard excerpt endpoint as authority
to undo it. The controls specification does not mark that bug resolved.

## Fullscreen and media sizing

- Standard fullscreen targets a stable player container that includes both
  video elements, custom controls, Close, status/recovery actions, and access
  to the playlist queue. Fullscreen must survive an active/standby role swap.
  Consolidate the existing fullscreen and close affordances so users do not
  see duplicate buttons.
- Update fullscreen state detection, return-to-fullscreen recovery, and Close
  cleanup to recognize this container. Keep **Start videos in full screen**
  and existing launch provenance: leaving fullscreen returns to the overlay
  for an overlay launch and closes a fullscreen-launched player, subject to
  the existing handoff recovery exception. The fullscreen toolbar button and
  browser fullscreen exit follow the same rule.
- Preserve Feature 0028's `F` shortcut as entry-only: pressing it while
  already fullscreen does not request fullscreen again. The toolbar button
  supplies explicit exit. A rejected fullscreen request leaves the overlay
  and its controls usable without changing the saved launch preference.
- Fit the complete image within both available dimensions, preserving aspect
  ratio with bars as needed. Queue and toolbar layout must not crop, stretch,
  or overflow portrait, 4:3, 16:9, or ultrawide footage. Recalculate on resize,
  orientation changes, and fullscreen entry/exit, including during a fade.
- If only native video fullscreen is available, permit the platform's native
  controls there and restore VDL controls on return. If neither fullscreen
  path is supported, disable its action with a concise explanation. Detect
  capabilities; do not assume that custom HTML can appear in native fullscreen.

[Bug 0063](../BUGS/bug-0063-fullscreen-playback-crops-non-widescreen-videos.md)
tracks reported fullscreen cropping. Its marked-frame regression is required
when replacing the fullscreen layout; writing this spec does not resolve it.

## Visibility, keyboard, and accessibility

- Show controls when opening the player, moving the pointer over it, tapping
  its surface, or using the keyboard inside it. After three seconds of
  inactivity during successful playback, hide controls and the pointer over
  the video surface. Do not hide while paused, ended, loading, recovering,
  dragging a slider, hovering a control, or holding focus within a control or
  open menu. Respect reduced-motion preferences when showing or hiding them.
- A touch on the video surface reveals hidden controls without also toggling
  playback. Buttons and sliders handle their own actions; their events must
  not fall through to surface or backdrop actions.
- Retain Space for play/pause and `F` for fullscreen entry while the player
  is open. Ignore repeated shortcut keydowns and Control/Command/Alt forms.
  Do not intercept shortcuts in editable fields, selectors, sliders, or
  buttons; Space/Enter and arrow keys keep native control semantics. No
  additional global shortcuts are required for this release.
- Use semantic buttons, labeled ranges, and a labeled native speed selector
  or equivalent accessible menu. Provide visible focus, state-dependent names
  such as Play/Pause and Enter/Exit fullscreen, and readable seek values such
  as “1 minute 23 seconds of 5 minutes.” Tooltips alone are insufficient.
- Keep hidden controls out of sequential keyboard navigation. Keyboard focus
  entering the player must reveal the controls before they receive focus.
  Confine modal-player focus to its visible interface, including recovery
  actions and the queue; restore focus to the launcher on Close when it still
  exists, or a sensible Library fallback if it does not.

## Implementation boundaries

- `templates/index.html`: add the shared control surface, accessible labels,
  required SVG symbols, and a fullscreen container enclosing the interface.
- `static/app.js`: add one control layer over existing playback operations,
  track interaction visibility, and synchronize on media and session events.
  Reuse the current boundary, navigation, progress, and recovery paths.
  Clean up per-load handlers, drag state, menus, and animation callbacks when
  loading changes or the player closes. Reopening must not multiply handlers.
- `static/styles.css`: style responsive controls, queue presentation,
  fullscreen containment, themes, focus, and reduced-motion behavior. Keep
  the vanilla frontend with no bundler or new runtime dependency.
- Leave native `controls` available until the custom control layer has
  initialized successfully, then disable them on the active element. Standby
  media stays hidden from focus and assistive technology. If custom controls
  cannot initialize, retain usable native controls without displaying two
  competing bars. No fallback can make unsupported media codecs playable.
- No new server route, database migration, stored preference, media download,
  status string, or change to file authorization or Range handling is needed.
  Update DOM-sensitive browser tests to target the new interface without
  weakening their playback and session assertions.

Out of scope: new subtitle or audio-track management, quality switching,
picture-in-picture controls, casting, frame stepping, global media keys,
direct-video bookmarks, and new playlist or shuffle semantics.

## Acceptance criteria and verification

1. Direct, Play All, Shuffle, Shuffle Clips, and playlist playback expose the
   specified controls in the overlay and standard fullscreen. Once initialized,
   exactly one control surface is visible. New-tab playback and previews retain
   their existing behavior; failed custom initialization leaves native controls.
2. Play/Pause reflects real events, rejected play promises remain handled,
   and direct replay follows the existing boundary behavior. Seeking supports
   mouse, touch, and keyboard, preserves pause state, cancels safely on item
   changes, and handles absent or invalid metadata without invalid labels.
3. Intro/outro explicit seeking, Shuffle Clips excerpt bounds, and full-file
   timestamps retain their contracts. Unknown duration and rejected seeks do
   not falsely advance or display a successful seek.
4. Volume, mute, and every offered speed work before and during a crossfade
   and persist across handoffs within the page session. The volume slider
   remains at the user's intended level while gains change. Test pause/resume,
   seek cancellation, and incoming-control ownership with real overlapping media.
5. Contextual Next and playlist Previous choose through the existing session
   operations, handle unavailable entries and queue boundaries, save progress,
   and reject duplicate clicks while pending. No duplicate views or advances
   occur. Recovery buttons remain reachable and use their existing paths.
6. Fullscreen includes controls, recovery actions, and playlist access, and
   remains active through video-role swaps. Verify both launch provenances,
   `F` duplicate suppression, explicit/browser exit, rejected requests, native
   fallback, Close cleanup, and return-to-fullscreen recovery.
7. With real marked-frame fixtures, verify the entire image remains visible
   at 4:3, portrait, 16:9, and ultrawide aspect ratios across viewport changes,
   fullscreen, queue visibility, and fades. A successful fullscreen request or
   container bounds alone does not prove the picture is uncropped.
8. Verify three-second hiding, all visibility exceptions, touch reveal,
   keyboard range operation, focus containment/restoration, accessible names,
   themes, reduced motion, and a narrow touch viewport without overflow.
9. Closing/reopening, rapid item changes, sign-out, and late media/network
   callbacks cannot leave controls bound to standby media, restart playback,
   or add duplicate handlers. Existing boundary and transition regressions
   remain meaningful and passing.

Extend `tests/browser/playback.spec.cjs`, `playlists.spec.cjs`,
`crossfade.spec.cjs`, `crossfade-media.spec.cjs`, `skip-video-edges.spec.cjs`,
`skip-video-edges-media.spec.cjs`, and `preferences.spec.cjs` as appropriate;
add a focused custom-controls suite if that makes the scenarios clearer.
Use generated local media and deterministic held responses for failure and
handoff cases. Verify actual media state and rendered results, not only
button clicks or timer invocations. Exercise Chromium, Firefox, and WebKit;
record supported-device checks for native Safari fullscreen and touch behavior
separately from simulated capability tests.

Before marking implementation complete, run `./tests/run-all.sh --unit` and
verify the enforced **90% minimum `vdl.py` line coverage**, using Python 3.12
when close to the threshold, then run the relevant browser suites. Record
any platform validation still pending. Implementation requires its own MINOR
version bump under `AGENTS.md`.

## Implementation verification

Implemented in version `0.50.0`. The shared player container includes both
media elements, controls, recovery actions, and the collapsible playlist queue.
Listening choices belong to the page session; fade gains and delayed media
callbacks cannot replace those choices. Native controls remain usable if custom
initialization fails, and native video fullscreen uses the platform's controls
when container fullscreen is unavailable.

Verification on 2026-10-29:

- `./tests/run-all.sh --unit` passed under Python 3.12: 384 tests, six optional
  real-media integration skips, and **91.6% `vdl.py` line coverage**.
- `node --test tests/*.test.cjs`: **20 passed**.
- Final affected browser set: **69 passed in each of Chromium, Firefox, and
  WebKit**. Focus restoration with a hidden launcher also passed in all three.
- The browser runs cover playback, playlists, preferences, intro/outro seeking,
  Shuffle Clips continuity, fullscreen fitting, and 23 focused custom-control
  regressions. Generated marked-frame media checks all four aspect ratios,
  queue expansion/collapse, and real overlaps. Screenshot capture preserves
  Chromium's emulated resize and Firefox's actual fullscreen viewport.

Physical supported-device validation remains pending: macOS/iOS Safari native
video fullscreen, fullscreen exit provenance on those devices, hardware volume
limitations, and touch reveal/drag/cancellation on a real touchscreen. The
native-only fullscreen and fixed-volume automated cases simulate capabilities;
they do not establish those device behaviors.
