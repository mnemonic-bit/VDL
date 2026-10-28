## 64. Shuffle Clips shows an empty player before the next video is ready

**Severity:** Medium — automatic clip transitions interrupt visible playback.

**Status:** Fixed locally in version `0.49.6` on 2026-10-28. Reproduced in
Chromium with a held incoming media response and distinct visible videos.

**Related:** [Feature 0045 — Shuffle Clips](../FEATURES/feature-0045-add-shuffle-clips-playback.md)
and [Feature 0040 — Preloading and crossfades](../FEATURES/feature-0040-preload-and-crossfade-play-all-and-shuffle.md).

### Reported behavior

In Shuffle Clips mode, a randomly selected clip can end before the next
video has loaded enough to display. The player then appears without video
contents instead of continuing the current video while the next one loads.

### Reproduction

1. Start **Shuffle Clips** with multiple playable videos.
2. Allow a short randomly selected excerpt to play while the next video is
   still loading. For a controlled reproduction, delay the next media
   response or its initial seek until after the current excerpt's scheduled
   end; use an outgoing source with enough remaining footage to continue.
3. Observe the player when the selected clip duration expires.
4. Release the delayed load and observe the transition once the incoming
   video can actually play at its selected starting position.

**Reported actual:** The player shows no video contents when the current
clip's time expires before the next video is ready.

**Expected:** Treat the selected clip duration as the intended transition
time. Cross-fade into the next video when that time is reached and the next
video is ready. If loading is late, keep the current video visible and
playing beyond its selected excerpt end, then cross-fade as soon as the next
video is ready. Loading delays must not expose an empty player.

Readiness means that the incoming video can display and play from its chosen
random start, including completion of any required seek. A media URL or
loaded metadata alone is insufficient. When the next clip is ready early,
retain the normal scheduled crossfade instead of advancing immediately.

### Change to the earlier timing requirement

Feature 0045 currently requires an ordinary handoff at the excerpt end `E`
when readiness is late and explicitly prohibits extending playback while
waiting. This user request revises that fallback: continuity takes precedence
over the randomly selected endpoint when the successor is not ready. Update
the feature's timing contract and related tests with the eventual repair.
The repair below implements this revised timing contract.

### Acceptance criteria and regression coverage

- With an incoming clip ready on time, the normal scheduled crossfade shows
  both videos during the overlap without an empty frame between them.
- If the next clip is not ready by the scheduled transition, the outgoing
  video continues moving and remains visible beyond its selected endpoint
  while source footage remains available. Do not freeze or hide it merely
  because the selected clip duration has expired.
- Once the delayed clip is playable at its selected start and the handoff
  is authorized, cross-fade from the still-playing outgoing video exactly
  once. The incoming clip continues from the position reached during the
  fade without restarting or skipping its beginning.
- Metadata arrival before playable frames, a delayed initial seek, and a
  delayed handoff confirmation do not reveal an unready incoming element.
- Consecutive short clips also work when the preceding crossfade leaves
  little time to prepare the next video. Keep picture and audio transitions
  coordinated with the existing volume, mute, and reduced-motion behavior.
- Pause, Stop, closing the player, or changing playback mode retains its
  expected behavior while waiting; late load completions cannot restart a
  cancelled session or trigger duplicate transitions.
- Failed loading uses bounded recovery without prematurely clearing the
  still-playable outgoing video. Also cover the boundary where the outgoing
  source reaches its natural end: continued moving playback is only possible
  while footage remains, and exhausted recovery must provide useful feedback.
- Add deterministic browser regressions with distinct visible media and a
  held incoming response/seek. Assert that the outgoing media clock advances
  past the excerpt endpoint while visible, then that a single crossfade
  occurs after readiness. Include an already-ready control and consecutive
  short clips; timer or request assertions alone do not prove continuity.

### Cause and repair

Automatic excerpt completion paused the outgoing element at `E` and loaded
the successor into it before that successor could display. The fade guards
also rejected late readiness once less than one excerpt second remained.

Excerpt endpoints now schedule the transition without stopping playback.
Preparation and authorization preserve the outgoing source; promotion waits
for playable data at the selected start, seek completion, and actual incoming
playback. Late transitions use the normal capped fade against remaining
source footage. The incoming element is adopted with its clock intact.
Revalidated replacement candidates load and seek in standby before promotion.

Network/media preparation is bounded, failed candidates are excluded from
automatic recovery, and exhausted recovery exposes Retry/Stop/Close while
preserving the current picture. Natural EOF retains the last available frame
until a successor can play. Pause defers promotion; session cancellation
invalidates late callbacks. Explicit user seeks still retain their existing
completion behavior.

### Regression coverage

`tests/browser/shuffle-clips-continuity.spec.cjs` uses real red/blue media,
held responses, held seek completion, and delayed advance confirmation. It
checks rendered picture colors, actual media-clock progress past `E`, overlap,
continued incoming playback, consecutive short excerpts, pause, cancellation,
and natural EOF. `shuffle-clips.spec.cjs` covers bounded preload exhaustion,
replacement revisions, occurrence bounds, and recovery from a failed fade.
Feature 0045's timing contract is updated with the repair.

Validated with `./tests/run-all.sh --unit` under Python 3.12: 384 tests,
6 skipped, and **91.6% `vdl.py` line coverage** (90% required). Browser
validation covers 92 distinct regressions across the Shuffle Clips,
continuity, crossfade, real-media crossfade, skip-edges, and real-media
skip-edges suites. The final 17-test Shuffle Clips rerun passes, including
preparation timeout/Retry and pause during a pending incoming `playing` event.
