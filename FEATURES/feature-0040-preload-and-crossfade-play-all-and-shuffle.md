# Preload and crossfade Play All and Shuffle videos

**Source:** User-requested feature  
**Status:** Implemented; Safari desktop validation pending\
**Last refined:** 2026-10-20  
**Extends:** Feature 0027, Endless library playback; Feature 0030, Shuffle playback

## Decision summary

During built-in **Play All** and **Shuffle**, choose and begin buffering one next
video when the playing video's clock first reaches 10 seconds remaining. When
both videos are ready, overlap their pictures and sound during the last 3
seconds of the current video: the old video fades out while the new video
starts at 0:00 and fades in. The next video's first 3 seconds are part of the
overlap, not skipped afterward.

“Download in the background” means an authorized browser media request to the
already stored `/api/file/<download_id>` resource. It does not start a new
yt-dlp job, create a download row, or copy the whole file into a JavaScript
buffer. The browser controls how much of a `preload="auto"` resource it fetches;
VDL can promise an early request, not a fixed amount of buffered data or an
uninterrupted crossfade on every device.

Keep at most one prepared next item and one extra media element per active
player. The server must reserve Shuffle's random choice before the browser can
buffer it. A prepared choice does not advance the session, record a view, or
change playlist progress. At the handoff, the existing advance operation
commits that choice after rechecking access and playability.

This first version applies only to Play All and Shuffle. Playlist playback,
direct video playback, preview clips, and new-tab playback keep their current
handoff behavior.

## User outcome

1. The user starts Play All or Shuffle in the built-in player. The current
   video plays as it does today.
2. At about 10 seconds remaining, VDL quietly selects the next video and
   starts loading it. The current video remains fully visible and audible.
3. At about 3 seconds remaining, if the next video can play, both videos run
   together. The picture and sound move smoothly from the old video to the
   new one over those 3 seconds.
4. The new video continues from the point reached during the overlap. Its
   title, controls, and session position become current at the start of the
   overlap.
5. If the browser or media cannot complete the early load or overlap, VDL
   continues the current video to its end and uses the existing recoverable
   handoff. A preloading failure never cuts the current video short.

## Timing and eligibility

- Use the current media element's finite `duration - currentTime` as the clock.
  Trigger preparation once when the value crosses 10 seconds, including when
  the user seeks into the final 10 seconds. Do not use a wall-clock timer that
  keeps running while playback is paused or stalled.
- Only prepare while an active sequential or shuffle session has a known
  current download ID and the media is moving forward. Wait for valid duration
  metadata. Do not prepare for a live stream, unknown or infinite duration, or
  a video already ended.
- Use the same server-side live selection rules as normal advance. Play All
  follows its stored filter and ordering and wraps as it does today. Shuffle
  uses its saved thresholds and uniformly chooses from the eligible pool,
  excluding the current item when there is more than one candidate.
- If the remaining duration is already below 10 seconds when the session
  becomes ready, prepare immediately. A video shorter than 10 seconds gets a
  chance to preload, with a correspondingly shorter lead time.
- A full 3-second crossfade begins only when the next media has metadata,
  playable data at its start, a known duration longer than 3 seconds, and a
  successful server advance. `HAVE_FUTURE_DATA` is a minimum readiness check,
  not proof that the entire overlap is buffered. Watch for `waiting` during
  the overlap and use the failure path if playback stalls.
- If readiness or server confirmation arrives after the 3-second mark but
  before the current video ends, fade over the remaining current-video time
  only when at least 1 second remains. Otherwise use the ordinary handoff at
  `ended`. Never pause the outgoing video merely to make a fade possible.
- Pausing freezes both media clocks and the fade. Resuming restarts both.
  Seeking the outgoing video before the overlap keeps at most the same one
  prepared item; the server revalidates it at commit. Seeking after the
  overlap starts acts on the incoming video and ends the overlap immediately.

## Session preparation and commit

Add one endpoint to the existing temporary playback-session API:

```http
POST /api/playback-sessions/<session_id>/prepare
Content-Type: application/json

{"expected_download_id":"current-id","sequence":7}
```

`sequence` is the next advance sequence, not a new counter. Preparation
returns the same compact `item` shape already used by session responses,
plus `session_id`, `sequence`, and a preparation marker. It never returns a
filesystem path or media bytes. If no candidate exists, return 204 while
leaving the current session alive until the ordinary end-of-item decision.

The server stores one prepared candidate with its expected current ID and
next sequence in the existing in-memory session. A repeated matching prepare
returns the same candidate, so retrying cannot draw a different Shuffle item.
An out-of-order sequence or mismatched current ID returns 409. A foreign or
expired session returns 404. Keep the existing per-user session cap and expiry.

At `POST /advance`, a valid prepared candidate is committed using the current
advance sequence and existing idempotency cache. Recheck that the user can
still see the row, its stored file exists inside an allowed path, and it still
meets the mode's selection rules. For Play All, also recheck that it is still
the next item in the live ordering. If it is no longer valid, discard the
preparation and run today's live advance selection. The response may then
name a different item; the client must discard the preloaded media and use the
ordinary handoff. A repeated advance must return the same committed result
and never choose again.

Prepare and advance hold the session lock only for state checks and updates.
Do not perform network I/O or serve media while holding it. Media still flows
through `/api/file/<download_id>`, with its normal authentication, visibility,
path checks, conditional requests, and Range support. A prepared item grants
no new file access. Closing, stopping, logout, expiry, or session replacement
discards the reservation. Keep the reservation in memory; add no SQLite table.

## Browser player design

Use two connected `<video>` elements in one player media stage. One is active;
the other is a hidden standby element with no visible native controls and no
autoplay. At preparation, set its typed `<source>` to the authorized media URL,
set `preload="auto"`, call `load()`, and wait for media readiness. Do not use
`fetch()` to download an entire video blob. Treat `preload` as a browser hint,
and never create more than one standby request.

At the fade threshold:

1. Submit the existing `/advance` request and verify that its returned item
   matches the prepared item. Leave the outgoing video playing while waiting.
2. Give the incoming element the outgoing element's user volume, mute state,
   and playback rate. Start it at 0:00. Observe its `play()` promise and
   `playing` event; calling `play()` alone is not success.
3. Once incoming playback really starts, make it the logical current item and
   begin a fade measured against the outgoing video's media clock. For fade
   progress `p` from 0 to 1, keep the old picture opaque and draw the new
   picture above it with opacity `p`, so the blend does not dim to black.
   Use audio gains `cos(πp/2)`/`sin(πp/2)` multiplied by the user's chosen volume.
   Preserve mute on both elements. A browser that locks media volume cannot
   promise an audio crossfade; use the fallback below.
4. Expose controls on the incoming element only. Propagate pause/resume during
   the overlap; keep the standby element out of keyboard focus and the
   accessibility tree. On completion, pause and unload the outgoing element,
   restore normal volume and opacity on the incoming element, and make the
   unloaded element standby for the following video.

Use the existing player epoch and load-generation checks for every prepare,
media event, advance response, and animation frame. A stale response after
close, stop, restart, seek, or a newer handoff cannot reveal or play another
video. A preloaded video does not increment views; retain each playback mode's
current view-count rule when the new item actually starts.

The user-chosen volume and mute state are a base setting. Fade gain is applied
on top of that base, so adjusting volume during an overlap affects both
elements without resetting the fade. Restore the base value after the old
element is unloaded. Never unmute an item as a way around autoplay policy.

## Fullscreen and controls

The current player requests fullscreen on `#playerVideo`. A crossfade needs
both videos visible, so in Play All and Shuffle request standard fullscreen on
a stable player media-stage container instead. Keep that container connected
while swapping active and standby roles. Place the usable close and playback
controls inside the fullscreen presentation, and retain the existing launch
provenance: Escape closes a player launched in fullscreen, while user-entered
fullscreen can return to the overlay. If fullscreen exits during handoff,
preserve the session and offer the existing **Return to fullscreen** action.

Native WebKit video fullscreen may show only one video element and can reject
scripted playback on a second element. In that presentation, prebuffer when
possible but use the existing same-element handoff at `ended`, preserving its
fullscreen recovery behavior. Do not leave fullscreen and attempt to re-enter
without a user gesture. Direct and playlist playback retain their established
fullscreen behavior.

Native media controls, keyboard shortcuts, Close, Stop, and any transition
actions must operate on the logical current element. Keep the current video
visible if the standby fails. Honor `prefers-reduced-motion` by switching the
picture without an opacity animation at handoff; retain the audio fade where
the browser permits it.

## Failure and recovery

- If preparation fails, its media request errors, or the browser ignores the
  preload hint, allow the outgoing video to finish and call `/advance` as
  today. Do not show a blocking error during the outgoing video's final
  seconds.
- If `/advance` returns a different item, 204, 404, or an error, discard the
  standby item. Apply the existing no-candidates, expired-session, Retry,
  Stop, and Close paths. A failed advance must not start the prepared video.
- If the second element's `play()` is denied, keep the outgoing video playing
  through its end. Then reuse its already-authorized element for the committed
  next item; if scripted playback is still denied, show **Continue playback**.
- If the incoming video stalls or errors during a fade, abort the fade, keep
  or restore the outgoing video's full picture and sound until it ends, then
  offer the existing retry/skip path for the committed next item. Do not draw
  another Shuffle choice under the same committed sequence.
- If the outgoing video ends during a late fade, complete the visual switch
  immediately. If the incoming video cannot continue, use the normal playback
  failure path.
- Closing pauses both elements, removes both sources, cancels pending work
  where possible, and releases the session. **Stop endless playback** releases
  the session and unloads the standby but preserves the currently playing
  video, as it does today. If Stop occurs during a fade, finish the switch to
  the already committed incoming item first. Late callbacks are ignored by
  generation. Background network bytes already fetched may remain in the
  browser cache under normal browser policy.

## Validation and completion criteria

Backend tests cover stable prepare retries, Shuffle's one random draw,
sequential wrap, one-item pools, live deletion or visibility change between
prepare and advance, stale sequences, foreign sessions, expiry, and advance
retry idempotency. Verify that preparation leaves the current position
unchanged and cannot bypass `/api/file` authorization.

Browser tests use controllable media fixtures and simulated clocks to cover
the 10-second request threshold, the 3-second picture and sound overlap,
pause/resume, seek, volume/mute, short and unknown-duration videos, late
buffering, failed preload, denied second-element playback, close during a
pending response, and exact one-item-at-a-time resource cleanup. Verify that
the incoming item continues around 3 seconds after a complete 3-second
overlap, rather than restarting at 0:00. Exercise Play All and Shuffle
separately, including a changing Shuffle pool.

Run real-browser checks in Firefox, Chromium, and Safari on supported desktop
platforms, including standard fullscreen and `prefers-reduced-motion`.
Confirm native WebKit fullscreen uses its documented fallback. Run existing
playback, accessibility, and authorization suites. Before implementation is
considered complete, run `./tests/run-all.sh --unit` and verify `vdl.py` line
coverage remains at or above 90% under Python 3.12.

The feature is complete when a ready next video is requested around 10
seconds before the end and the normal desktop-browser case blends both videos
over the last 3 seconds without a blank loading interval. In every fallback,
the current video plays to its end, the user retains a clear recovery action,
and no extra session or media element remains active after closing.

## Implementation areas

| Area | Work |
| --- | --- |
| `vdl.py` | Prepared session candidate, idempotent prepare endpoint, advance validation and commit |
| `templates/index.html` | Stable two-video media stage and usable fullscreen controls |
| `static/app.js` | Preparation trigger, standby loading, crossfade controller, cleanup and fallback |
| `static/styles.css` | Layered videos, fullscreen stage, controls, reduced-motion presentation |
| `tests/` | Session contract and browser media handoff coverage |

## Implementation notes

Implemented in version `0.41.0`. Reservations stay in the existing in-memory
session, and library selection resolves outside the session lock. Browser
handoffs reuse two connected media elements and a stable fullscreen stage;
failed overlaps retain the committed response for same-element recovery.

Deterministic session tests cover concurrent retries, live authorization and
selection changes, and reservation cleanup. Browser tests combine simulated
media clocks with a generated WebM fixture for real buffering and fullscreen.
Safari on macOS still requires the desktop validation described above;
Playwright WebKit coverage does not establish native Safari fullscreen behavior.

## Non-goals

- Pre-downloading source websites with yt-dlp, changing download concurrency,
  or adding a server-side transcode or media cache.
- A zero-gap guarantee under slow networks, unsupported codecs, browser
  preload limits, or autoplay restrictions.
- Preloading more than one upcoming item or persisting a Shuffle queue.
- Applying the crossfade to playlists, direct video playback, previews, or
  new-tab playback in this feature.
- A new playback setting for fade duration or preload lead time.

## Platform notes

The [HTML media standard](https://html.spec.whatwg.org/multipage/media.html)
defines `preload="auto"` as a hint, describes readiness states, and requires
handling the result of `play()`. The
[Fullscreen standard](https://fullscreen.spec.whatwg.org/) associates
fullscreen with an element, which motivates keeping the media-stage container
connected across a handoff. [WebKit's autoplay guidance](https://webkit.org/blog/7734/auto-play-policy-changes-for-macos/)
warns that playback permission is per element; the fallback reuses the
original video element when a second one cannot start. The existing
[display-continuity research](../research/endless-playback-display-continuity.md)
documents VDL's current same-element handoff and native fullscreen limits.
