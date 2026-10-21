# Skip the first and last 10 seconds during video playback

**Source:** User-requested feature  
**Status:** Implemented\
**Implemented:** 2026-10-21 · Version `0.43.0`\
**Last refined:** 2026-10-20  
**Related:** Feature 0040, Preload and crossfade Play All and Shuffle videos

## Decision summary

Add one **Skip video intro and outro** switch in Settings → Playback. When it is
on, the built-in player starts each eligible video at 0:10 and treats the point
10 seconds before its actual end as the end of normal playback. This helps
avoid recurring opening and closing screens, including advertisements. The
switch is off by default.

This is a playback convenience. Keep the downloaded file intact; downloads,
imports, browser downloads, thumbnails, previews, stored durations, and media
served by `/api/file/<download_id>` retain the complete video. VDL does not
identify advertisements or claim that they always last 10 seconds.

## Settings and persistence

- Place a labeled checkbox in the existing Playback section, near **Play videos
  in**. Help text: “Start 10 seconds in and finish 10 seconds early in the
  built-in player. The saved video stays complete. Videos of 20 seconds or less
  play normally.” Include intro, outro, advertisement, ads, and skip in Settings
  search terms.
- Persist `skip_video_edges` as the canonical strings `"true"` or `"false"` in
  the existing shared preferences table. Seed `"false"` only when the key is
  missing. `GET /api/preferences` returns the saved value; `POST
  /api/preferences` accepts only a JSON boolean or the exact strings `"true"`
  and `"false"`, normalizes to a string, and rejects other values with 400
  without saving any field from that request.
- The preference is global to this VDL installation, like the other Playback
  settings. Show the saved value on reload and when Settings reopens. A
  successful save applies to the next video loaded, including the next item in
  an active Play All, Shuffle, or playlist session. The current item keeps the
  setting it started with.
- Explain beside **Play videos in** that the switch applies only to the
  built-in player. A video opened in a new browser tab uses the browser's own
  player and plays in full; the switch remains saved for later built-in use.

## Playback behavior

- Apply the switch to direct History playback, Play All, Shuffle, and playlist
  playback in the built-in player, including fullscreen. Each newly loaded
  item gets its own media duration and skip bounds; do not reuse the previous
  item's timing after a handoff, retry, or playlist selection.
- Once the browser reports a finite duration `D` greater than 20 seconds, use
  `start = 10` and `end = D - 10` on the media element's original timeline.
  For `D <= 20`, zero, missing, `NaN`, or infinite duration, play the entire
  item without edge skipping. If valid duration arrives later, calculate the
  bounds then; never seek before metadata makes the duration reliable.
- For a fresh load, seek to `start` before audible or visible playback. Keep
  automatic playback and fullscreen behavior intact. A playlist's saved
  resume position takes precedence when it is inside `(start, end)`. Clamp a
  saved position before `start` to `start`; if it is at or beyond `end`, restart
  that item at `start` rather than immediately marking it complete. Save
  playlist progress using positions on the original media timeline.
- While playing normally, reaching `end` completes the item exactly once.
  Play All, Shuffle, and playlists use their existing end-of-item handoff;
  playlist completion must be recorded just as it is for a natural `ended`
  event. Direct playback pauses at `end` and leaves the player open. Pressing
  Play again there restarts at `start`. Pausing or buffering before `end` does
  not advance. Use media time, not wall-clock time, and avoid duplicate
  handoffs if the browser also emits `ended`.
- Keep the native timeline showing the full file duration. A person may seek
  back into the first 10 seconds to watch the intro; do not force them back to
  `start` after an explicit seek. An explicit seek into the final 10 seconds
  permits watching that tail through the natural end. Seeking back before
  `end` re-arms the normal early-end behavior. Ignore the implementation's
  own initial and resume seeks when deciding whether a seek was explicit.
- If the browser cannot seek to `start`, continue playback from the available
  position instead of treating the file as broken. If duration becomes
  unreliable after the item starts, use natural playback end for that item.
  Do not add a download status, server-side transcode, or repeated network
  request to implement this setting.

## Interaction with Feature 0040

Feature 0040 is a separate proposal for Play All and Shuffle preloading and
crossfade. If both features are implemented, its “seconds remaining” must
refer to the current item's **effective end** (`D - 10` when this switch
applies). Prepare the next item 10 seconds before that point and, when ready,
start the 3-second crossfade 3 seconds before it. The incoming video begins at
its own `start` boundary; do not fade in its skipped intro or seek it to 0:00
after the fade. Consider that incoming item ready only after the start seek has
completed and playable data is available there. If its effective playable
interval is too short for a full fade, use Feature 0040's ordinary handoff.
If preloading or fading fails, play the outgoing item only to its effective
end before the normal handoff. An explicit seek into the tail uses the natural
end and cancels an early fade for that item. With the switch off, Feature 0040
keeps its specified timing.

## Acceptance criteria

1. Off by default, the built-in player plays complete videos. Turning the
   switch on and saving persists across reloads and server restarts; malformed
   preference values are rejected without a partial save.
2. An eligible 60-second video starts at 0:10 and finishes normal playback at
   0:50. A video of 20 seconds or less, or one with an unknown duration, plays
   normally. The stored file and its displayed total duration remain unchanged.
3. Direct playback pauses at 0:50; Play All, Shuffle, and playlists advance
   once at 0:50, with playlist completion recorded. Pausing before 0:50 never
   advances. A late native `ended` event cannot advance twice.
4. Seeking to 0:00 or 0:55 lets the user inspect the skipped content. Seeking
   back before 0:50 restores early finishing. Playlist resume positions inside
   the playable interval resume there; older positions before or after it
   follow the clamping rules above.
5. Switching the setting during playback changes the next loaded item, not
   the one already playing. Opening in a new tab still plays the full file.
   Feature 0040, when present, prepares and fades relative to the effective
   end and starts incoming media at its own effective start.

## Verification and implementation areas

- `vdl.py`: seed and validate the new preference through the existing
  preferences API. No download, file-serving, or media schema change.
- `templates/index.html` and `static/app.js`: add the searchable checkbox,
  load/save it, and implement one per-item playback-boundary controller shared
  by direct, Play All, Shuffle, and playlist playback. Guard media callbacks
  with the existing load generation so stale events cannot affect a new item.
- Add unit coverage for preference defaults, validation, and atomic rejection.
  Add browser media tests for finite, short, unknown, and late duration; start
  seek; pause; manual seek; resume; direct finish; one-time session handoff;
  changed settings; new-tab behavior; and Feature 0040 interaction if that
  feature is present.

Before implementation is marked complete, run `./tests/run-all.sh --unit` and
verify at least 90% `vdl.py` line coverage, then run the relevant browser
playback and Settings tests. Implementation increments the MINOR version to `0.43.0` under `AGENTS.md`.


## Implementation notes

Each media load captures its own setting and original-timeline bounds. Metadata
and start-seek completion gate playback and incoming crossfade readiness. A
saved setting change invalidates uncommitted preloads, while current playback
retains its bounds. Playlist sessions with skipping enabled defer the existing
server near-end resume heuristic to the browser so saved positions can be
clamped instead of prematurely completing or advancing the item.

## Validation

- `./tests/run-all.sh --unit` with Python 3.12: 238 tests run, 5 skipped;
  `vdl.py` line coverage 90.9% (4562/5019), above the 90% minimum.
- `./tests/run-all.sh --browser`: all 201 browser tests passed, including real
  media start seeks, early finishing, and fullscreen crossfade.
- Three additional focused recovery checks passed for duration becoming
  unreliable during a fade, stale end events before new metadata, and stopping
  after a failed fade while retaining the restored item's bounds.
