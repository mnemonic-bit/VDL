# Add Shuffle Clips playback with random starts and durations

**Source:** User-requested feature\
**Status:** Implemented\
**Implemented:** 2026-10-26 · Version `0.48.0`\
**Last refined:** 2026-10-25\
**Extends:** [Feature 0030, Shuffle playback](feature-0030-add-shuffle-playback.md),
[Feature 0035, Remember the last Play All mode](feature-0035-remember-play-all-mode.md),
and [Feature 0040, Preloading and crossfades](feature-0040-preload-and-crossfade-play-all-and-shuffle.md)\
**Interacts with:** [Feature 0041, Skip video intro and outro](feature-0041-skip-video-intro-and-outro-during-playback.md)

## Decision summary

Add **Shuffle Clips** as a third choice in the Library playback dropdown,
after **Play All** and **Shuffle**. It continuously shuffles eligible videos,
playing a fresh random excerpt from each. Each excerpt starts between
**one-third and seven-eighths of the original video duration** and lasts
**5–20 seconds**, with both values randomized subject to the excerpt fitting
inside the file. Twenty seconds is the maximum, not a fixed interval or an
average target.

Remember this choice using the existing per-user, per-browser preference.
Reuse normal Shuffle's authorized library pool, quality/length preferences,
non-repeating selection, player controls, fullscreen, preloading, and
crossfades. Apply transitions to excerpt boundaries rather than file endings.

## Dropdown and remembered choice

- The dropdown offers **Play All**, **Shuffle**, and **Shuffle Clips** in that
  order. Reuse `#i-shuffle` for the new choice. Its tooltip is “Shuffle random
  5–20 second clips from your library.”
- Choosing Shuffle Clips launches it immediately and changes the main button's
  label, accessible name, tooltip, and icon together. Pressing the main button
  later starts another Shuffle Clips session. Keep existing menu keyboard,
  focus, dismissal, and narrow-screen behavior for all three choices.
- Extend the existing `playback-mode-user-<stable user ID>` storage value set
  with `shuffle_clips`. Existing `sequential` and `shuffle` choices remain
  valid. Missing or invalid values still default to Play All.
- Save the choice when explicitly invoked, including when session creation
  fails. Storage failure preserves the in-page choice and permits playback.
  Reload and later sign-in restore the choice independently for each account
  in that browser. Automatic advancement, direct playback, playlist playback,
  and opening or dismissing the menu do not change it.
- Use the existing optimistic Shuffle availability check for the new menu
  item; the server decides actual eligibility. The main button follows its
  remembered mode's availability, and the dropdown remains enabled whenever
  any of its three actions is available. Never silently select another mode.

## Random excerpt contract

Use seconds on the original media timeline, allowing fractional values. Let
`D` be the browser-reported finite, positive video duration. Calculate:

```text
earliest_start = D / 3
latest_start   = min(7 * D / 8, D - 5)

S = uniform_random(earliest_start, latest_start)
L = uniform_random(5, min(20, D - S))
E = S + L
```

`S` is the chosen start, `L` the excerpt length, and `E` its effective end.
Draw the start first, then draw the length from the feasible range for that
start. Each draw is uniform over its stated range; length and start are
necessarily dependent near the file's end. A range with equal endpoints
returns that endpoint. Do not draw an invalid length and then clamp it, which
would disproportionately produce excerpts ending exactly at the file end.

Every excerpt must satisfy all of these conditions, within media timestamp
precision:

```text
D / 3 <= S <= 7 * D / 8
5 <= L <= 20
E <= D
```

This narrows the start range for short files so at least five seconds remain.
A video must be at least **7.5 seconds** long to admit any valid excerpt.
Never shorten an excerpt below five seconds or start before one-third to
accommodate a shorter file. Short videos need not offer the full 20-second
maximum.

| Video duration | Allowed starts | Example start | Allowed length at that start |
| --- | --- | --- | --- |
| 120 seconds | 40–105 seconds | 100 seconds | 5–20 seconds |
| 40 seconds | 13⅓–35 seconds | 35 seconds | Exactly 5 seconds |
| 20 seconds | 6⅔–15 seconds | 10 seconds | 5–10 seconds |
| 8 seconds | 2⅔–3 seconds | 3 seconds | Exactly 5 seconds |
| 7.5 seconds | Exactly 2.5 seconds | 2.5 seconds | Exactly 5 seconds |
| Less than 7.5 seconds | No valid excerpt | — | Ineligible |

Choose new bounds for the first item and every subsequent occurrence,
including when a one-video pool repeats that same file. Capture the bounds
once per occurrence, identified by session and sequence as well as media load
generation. Preparation retries, duplicate metadata events, pause/resume,
and promotion of standby to active must retain the same bounds. A genuinely
new occurrence gets new draws; randomness may legitimately repeat values.

## Selection and metadata

- Keep normal Shuffle's server-side authorization, file/path validation,
  browser-video eligibility, quality threshold, and full-video minimum-length
  preference. Snapshot those preferences at session creation as today. The
  excerpt length does not replace or reinterpret the minimum video length.
- Add finite duration of at least 7.5 seconds to this mode's pool requirements.
  Preserve the existing metadata-pending response when unprobed candidates
  could become eligible. Clearly explain when no video can supply a valid
  clip, and retain the selected mode with existing Retry/Stop controls.
- Select uniformly from the live eligible pool and exclude the current video
  when another eligible video exists, just as normal Shuffle does. A lone
  eligible video repeats with freshly chosen excerpt bounds.
- Stored duration supports pool eligibility, but browser metadata determines
  the actual excerpt bounds. Wait for reliable metadata and complete the seek
  to `S` before revealing or audibly playing either active or standby media.
  Readiness requires playable data at that position, not merely at 0:00.
- If actual duration cannot support a valid excerpt, metadata fails to become
  usable within a bounded media-load timeout, or the start seek fails,
  treat the candidate as unplayable for this session's recovery attempt. Try
  other eligible candidates without repeatedly drawing the failed one. Bound
  recovery to one attempt per candidate until playback succeeds or show the
  existing recoverable player error when candidates are exhausted. Never
  silently play a full video or an out-of-range excerpt.
- If duration changes before playback, revalidate the chosen bounds; retain
  them if still valid. If they become invalid, discard that occurrence through
  the same recovery path rather than silently shortening or redrawing it.
  Invalid duration during playback stops that excerpt through recovery.

## Preloading, crossfades, and timing

- Reuse Feature 0040's prepare/reserve/advance flow and two-element player.
  Preloading reserves one next video without advancing the session or recording
  a view. Retain its chosen excerpt through commit; a different committed item
  requires its own valid bounds and the ordinary handoff path.
- Measure remaining time as `E - currentTime`. Prepare the next item when ten
  seconds remain, or immediately after playback begins if the excerpt is
  already shorter than that. Preload the chosen random position with normal
  authorized media/Range requests. Keep one standby element and one reserved
  candidate; do not download entire files into JavaScript buffers.
- Normally fade over three seconds, shortened for short excerpts so adjacent
  fades cannot overlap and require a third video. With outgoing and incoming
  excerpt lengths `Lout` and `Lin`, use
  `F = min(3, Lout / 2, Lin / 2)` seconds. Begin the overlap at `Eout - F`
  only after the server commits the prepared candidate and incoming playback
  is ready. For example, a five-second excerpt permits at most a 2.5-second
  fade at either end.
- The incoming video starts at its own `S`. Its fade-in consumes part of its
  chosen `L`; afterward it continues from that reached position and finishes
  at its own `E`. Never restart at `S`, reset to 0:00, or add the fade duration
  to the clip. Thus 5–20 seconds describes source playback per excerpt,
  including overlaps; time between logical video changes can be shorter.
- Release the outgoing element when its fade finishes. If the now-current
  excerpt already has ten seconds or less remaining, prepare its successor
  immediately once standby becomes free. This must work for consecutive
  five-second clips, including repeated occurrences of the same video.
- Keep existing picture blending, audio gains, user volume/mute/rate,
  fullscreen container, reduced-motion behavior, and autoplay handling.
  Pause or buffering freezes advancement and fade progress with media time.
  Playback-rate changes alter wall-clock pacing, not the chosen source bounds.
- If incoming readiness or commit is late, shorten the fade to the remaining
  outgoing time, subject to the excerpt half-length caps and Feature 0040's
  one-second minimum fade. Otherwise use an ordinary handoff at `E`. Do not
  pause the outgoing video to manufacture an overlap. If preloading fails,
  keep playing only until `E`, then use existing recovery. Never continue to
  the file's natural end just to wait for the next clip.
- Finish each occurrence exactly once. Late `ended`, time updates, seek events,
  or repeated advance responses cannot cause duplicate handoffs. Close, Stop,
  mode replacement, and logout cancel pending work and unload both elements
  through existing epoch/generation guards. Preloading never counts as a view;
  retain normal Shuffle's view rule when an occurrence actually starts.

Seamless transitions are the normal ready-media path. As with Feature 0040,
browser buffering, autoplay restrictions, or slow storage can require a
recoverable ordinary handoff; the mode cannot guarantee gapless playback on
every device. Fullscreen fallbacks still honor the excerpt end.

## Controls and interaction with other playback settings

- Use the built-in player, as normal Shuffle does. Existing direct-video,
  playlist, sequential, and full-video Shuffle behavior stays as specified
  by those features.
- Shuffle Clips owns its start/end bounds. The **Skip video intro and outro**
  preference does not additionally trim these excerpts or shift the fractional
  start window. Keep that preference saved for playback in other modes.
- Keep the native full-file timeline. Explicit seeking within `[S, E)` retains
  the chosen bounds; seeking before `S` returns to `S`, and seeking to or past
  `E` completes the excerpt once. Seeking does not redraw either random value.
  During an overlap, controls and seeking act on the incoming logical item,
  following the existing fade-cancellation behavior.
- No additional duration controls are required: five and twenty seconds are
  fixed limits for this mode.

## Implementation areas and verification

- `templates/index.html`: add the third dropdown item with shared icons and
  the existing menu semantics.
- `static/app.js`: extend remembered-mode validation/rendering/dispatch and
  availability; share Shuffle launch and recovery; add excerpt bounds to the
  per-occurrence playback-boundary controller. Make prepare/fade eligibility
  recognize the new mode and schedule against its effective end. Preserve
  prepared bounds when media elements exchange roles.
- `vdl.py`: accept `shuffle_clips` in playback-session creation, preparation,
  advancement, and recovery; share normal Shuffle selection and reservations
  while enforcing the duration requirement. Preserve existing endpoint shapes,
  session ownership/expiry, access revalidation, and idempotent sequences.
  Keep excerpt timing in browser playback state; no persistent clip files,
  database columns, or new download statuses are needed.

Acceptance coverage must include:

1. All three dropdown choices launch the expected mode. Shuffle Clips updates
   the main button, survives reload/sign-out/sign-in per account, and retains
   existing defaults and storage-failure behavior.
2. Deterministic random inputs verify both ends and interior points of each
   sampling range, including 7.5-second, shorter, and invalid-duration media.
   Every generated excerpt satisfies the three timing invariants. Do not use
   probabilistic tests that can fail because a random value happens to repeat.
3. First and subsequent items seek before playback. A one-item pool creates
   new occurrences; retries and metadata events retain existing bounds.
   Stored/browser duration disagreement and failed seeks recover as specified.
4. Preparation requests the chosen incoming position, leaves session position
   and views unchanged, and retains the same bounds through idempotent commit.
   Changed/deleted/inaccessible prepared candidates cannot play from stale data.
5. Real-media browser tests demonstrate preloading and picture/audio overlap
   at excerpt ends, continuous incoming playback after the fade, and consecutive
   five-second clips without three simultaneous media elements or duplicate
   advancement. Pause, buffering, seeking, rate changes, and late readiness
   respect media time and the chosen boundaries.
6. Stop/Close/restart and stale callbacks, fullscreen/reduced motion/autoplay
   fallbacks, missing candidates, skip-edges interaction, and existing playback
   modes retain their defined behavior. Failed preloads never extend a clip
   beyond its chosen end.

Extend the existing playback-session unit tests and playback, preferences,
crossfade, crossfade-media, and skip-video-edges browser suites. Before marking
implementation complete, run `./tests/run-all.sh --unit` and verify the
enforced **90% minimum `vdl.py` line coverage**, using Python 3.12 when close
to the threshold, then run the relevant browser suites. Implementation is a
feature and requires its own MINOR version bump under `AGENTS.md`; this
specification alone leaves `VERSION` unchanged.
