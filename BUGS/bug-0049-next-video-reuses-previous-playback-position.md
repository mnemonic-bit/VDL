## 49. [Open] Opening another video can reuse the previous playback position

**Severity:** Medium

**Status:** Open; reported on 2026-10-16. Not yet independently reproduced.

After a user stops watching one video partway through, opening a different
video can appear to seek to the time where the first video was closed. The
reporter noticed this while VDL was importing videos from its ingestion folder
and new items were shifting the main video view. The ingestion activity may be
related, but that connection has not been established.

### Reproduction to confirm

1. Use two distinct finished videos, **A** and **B**, with known durations and
   different download IDs. Select built-in-player playback rather than the
   new-tab mode.
2. Open A from its video card, play or seek to a recognizable position well
   after the beginning, and close the player before A ends.
3. Open B from its video card in the same browser tab. Record B's displayed
   time immediately, after metadata loads, and when playback begins.
4. Repeat using the player's Close button and Escape, with ingestion idle and
   while new imports are entering the main view. Verify that the clicked card
   and loaded `/api/file/<id>` belong to B after each list update.
5. Repeat with A's or B's media response deliberately delayed, stalled, or
   aborted before playable data arrives. Record whether a browser media error
   or application playback timeout occurs before B shows A's old position.

**Reported actual:** B tries to start at approximately the time where A was
closed, instead of at B's beginning. Whether this happens before or after B's
metadata loads, and whether it requires active ingestion, is still unknown.

**Expected:** Opening a different video directly starts it at 0:00. Closing A
must not transfer its playback position to B. A deliberately resumed playlist
may use its own saved position, but that position must be scoped to the
correct playlist item and must not affect an ordinary card play.

### Investigation notes

- `static/app.js` reuses the same `#playerVideo` element for direct, endless,
  Shuffle, and playlist playback. `closePlayer()` pauses it, removes its media
  source, and calls `load()`. `loadPlaybackItem()` replaces the source and has a
  `loadedmetadata` handler intended to set an ordinary video's time to zero.
  Source inspection alone does not explain the reported seek.
- Playlist playback can pass an explicit `resume_seconds` into
  `loadPlaybackItem()`. Check that a late playlist response or metadata event
  cannot apply that seek to a later direct video after the player closes.
- SSE reconciliation calls `fetchHistory()`, which rebuilds the video-card
  list while imports arrive. Check whether card movement, a pointer event
  during replacement, or stale card data can open a different download ID
  from the one the user selected. Do not assume ingestion is the cause unless
  the symptom reproduces only with that activity or a clear event race is
  captured.
- A browser media-element reset may have different timing from a test harness
  that stubs `HTMLMediaElement.load()`. Confirm the playback position and media
  URL in a real browser with two actual media files.
- Slow or absent media delivery is another possible trigger. If the server
  does not supply playable data before the browser gives up, or before the
  watchdog used by continuous playback fires, a pending load or late media
  event from A might overlap B's startup. B might also briefly display the
  reused element's old timeline before its own metadata arrives. Capture
  `loadstart`, `loadedmetadata`, `seeking`,
  `timeupdate`, `error`, and `currentSrc` around close and reopen while
  throttling or stalling `/api/file/<id>`. This is a hypothesis, not a confirmed
  cause; compare it with a normal-speed run and with ingestion disabled.

### Acceptance criteria

- Directly opening B after closing A midway starts B at 0:00 for both Close
  and Escape, in overlay and configured fullscreen modes.
- The media request and player state identify B throughout startup; a moving
  or refreshed video list does not make a click launch another item.
- Import-driven SSE updates do not change the selected video's position or
  source while the player is open or during the next launch.
- Explicit playlist resume still seeks only to the saved position of the
  intended playlist item; sequential Play All and Shuffle handoffs retain
  their existing behavior.
- Add a browser regression using two distinct playable media files and a
  mid-play close/open sequence. Include an SSE list-refresh case if the
  investigation confirms a connection to ingestion.

This report changes documentation only and does not change `VERSION`.
