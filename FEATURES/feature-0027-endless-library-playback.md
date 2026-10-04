# Add endless library playback with display-mode continuity

**Source:** User-requested feature  
**Status:** Proposed  
**Last refined:** 2026-10-04  
**Extends:** Feature 0002, Search and filter Download History; Feature 0017,
Make Download History the primary thumbnail library; Feature 0025, Track video
views and show preview quality  
**Research:** [`research/endless-playback-display-continuity.md`](../research/endless-playback-display-continuity.md)

## Decision summary

Add **Endless playback** to the built-in player. Starting it creates a
temporary, user-bound playback session on the server. The session describes a
live library selection by its normalized History filter, canonical ordering,
page size, page, and position on that page. It does not materialize or retain
the matching download IDs. Each advance resolves the next coordinate against
the library as it exists at that moment and wraps after the last playable
item.

Keep one connected `#playerVideo` element for the complete session. Opening
the session and acquiring its initial presentation are separate from loading
a media item. When an item ends, replace only that element's media source,
call `load()`, and observe the promise returned by `play()`. Do not close the
overlay, replace the video node, or request fullscreen again.

This preserves the active display mode:

- standards-based fullscreen remains attached to the same DOM element;
- the original-size overlay remains open and applies the new video's own
  intrinsic dimensions, constrained to the viewport; and
- fullscreen entered manually after playback began is retained across a
  handoff just like fullscreen entered at launch.

Fullscreen acquisition remains browser-controlled. It must be requested
directly from the user's start action, before awaiting session creation.
Legacy iPhone/iOS native video fullscreen has no documented source-swap
continuity guarantee. VDL preserves it when WebKit does, but if native
fullscreen exits, a fresh user action is required to return.

## User outcome

1. The user chooses **Start endless playback** from the current History view
   or starts it from a playable History item.
2. VDL opens the built-in player in the user's selected presentation. If
   **Start videos in full screen** is enabled, VDL requests fullscreen as part
   of this activation.
3. The server creates a temporary session from the current filter, ordering,
   page size, page, and starting position.
4. When the current video ends normally, VDL resolves and starts the next
   playable video without leaving the active overlay or fullscreen mode.
5. After the last current match, playback wraps to the first current match.
6. Closing the player stops advancement and asks the server to delete the
   temporary session immediately. Idle expiry remains a fallback for browser,
   network, or process failures.

The user may leave fullscreen through the browser's normal control. A session
that originally opened in the original-size overlay returns to that overlay
and continues. Retain the existing rule for a session launched directly into
fullscreen: an intentional fullscreen exit closes playback and releases the
temporary session. A source-induced fullscreen exit detected while an item is
advancing is not treated as an intentional close.

## Terms

- An **endless session** is the server-owned, temporary navigation state for
  one user's live library selection. It is not a saved playlist.
- The **live selection** is the set of currently visible, finished, playable
  library entries matching the session's stored filter and ordering.
- A **coordinate** is a zero-based `(page, position)` pair interpreted using
  the session's stored page size.
- **Original-size overlay** is the existing built-in overlay presentation in
  which the video uses its own intrinsic dimensions up to the current
  `90vw`/`90vh` safety limits. It does not mean that an oversized video may
  extend beyond the viewport.
- **Standard fullscreen** is fullscreen represented by
  `document.fullscreenElement` through the Fullscreen API.
- **Native WebKit fullscreen** is Safari/iOS video presentation reported by
  `webkitbeginfullscreen`, `webkitendfullscreen`, and, where available,
  `webkitDisplayingFullscreen`.
- A **handoff** is the transition from one media resource to the next while
  retaining the player session and DOM video element.
- **Launch provenance** records whether the session began in fullscreen or in
  the overlay. It is distinct from the presentation mode currently observed
  by the browser.

## Temporary server session

### Storage and lifetime

Store endless sessions in process memory, guarded by a dedicated lock. This
matches VDL's single-process runtime and avoids persistent rows for disposable
state. A restart invalidates every session; the client then stops advancement
and offers to start a new session.

Each session stores only:

- an unguessable session ID with at least 128 bits of entropy;
- the authenticated owner user ID;
- the normalized History filter;
- one canonical ordering identifier;
- page size, zero-based page, and zero-based position;
- the current download ID as a lightweight consistency check, not as a queue;
- a monotonically increasing advance sequence and the most recent response
  needed to replay one retry idempotently; and
- creation and last-activity monotonic timestamps.

Do not store the complete result list, filenames, file paths, media bytes, or
one row per matching item. One session remains constant-size regardless of
whether the live selection contains ten or ten thousand videos.

Delete a session when:

- the player closes or endless playback is stopped;
- the authenticated browser signs out;
- it has received neither an advance nor a lease renewal for 30 minutes;
- its owning account is suspended or removed; or
- the process exits.

Opportunistically prune expired sessions when creating or advancing a
session. Limit one user to eight live sessions and discard that user's oldest
idle session before accepting a ninth. These bounds protect against abandoned
tabs without requiring a cleanup thread.

### Canonical selection semantics

The backend must expose one canonical library-page resolver used by endless
sessions and suitable for later reuse by server-side History pagination and
saved playlists. It applies, in this order:

1. the signed-in user's visibility boundary;
2. History status eligibility;
3. browser-playback eligibility (`finished`, a stored filename, and an
   allowed regular file that still exists);
4. the stored filter using the same quoted-term, title, tag, `user:`,
   `quality:`, `star:`/`starred:`, and `views:` semantics as History;
5. the stored canonical ordering; and
6. page size and coordinate.

Move or mirror the current client-only filter implementation behind a shared,
covered contract before enabling server-managed playback. The visible History
results and an endless session created from them must not disagree about what
the filter means.

Support these initial orderings:

- `newest`: `created_at DESC, id DESC`;
- `favorites_first`: `favorite DESC, created_at DESC, id DESC`.

The explicit ID tie-breaker is required so unchanged data has deterministic
coordinates. Client-only reconciliation order such as `historyOrderIds` is
not a valid session ordering because the server cannot reproduce it.

### Live-mutation trade-off

Resolve the target coordinate against fresh database state for every
advance. Do not freeze a list of IDs. Consequently, changes before the stored
coordinate may cause an item to be repeated or skipped:

- a newly finished or newly matching item can shift later coordinates;
- deletion, visibility loss, filter metadata changes, or a missing file can
  pull later items forward; and
- changing a favorite can move an item when `favorites_first` is active.

This is an accepted memory-versus-snapshot-consistency trade-off. Never expose
an item that has become invisible to the session owner. A mutation may affect
future navigation, but it must not interrupt a currently open media response
or retroactively change the item already playing.

## API contract

All endpoints require the normal authenticated browser session and the same
same-origin mutation protection as other state-changing APIs. A session owned
by another user is indistinguishable from an unknown session.

### Create

```http
POST /api/playback-sessions
Content-Type: application/json
```

```json
{
  "filter": "quality:1080 star:yes mountain",
  "ordering": "favorites_first",
  "page_size": 10,
  "page": 2,
  "position": 4,
  "start_download_id": "download-id"
}
```

The server validates bounded integers and the ordering identifier, normalizes
the filter, and resolves `start_download_id` within the live selection. The ID
is authoritative when supplied; page and position are the client's starting
hint. Return HTTP 409 if that item is no longer eligible instead of silently
starting an unrelated coordinate. A start action without an item uses the
requested coordinate or the first playable coordinate if that page has
shrunk.

```json
{
  "session_id": "opaque-token",
  "sequence": 0,
  "page": 2,
  "position": 4,
  "item": {
    "id": "download-id",
    "title": "Example",
    "extension": "mp4"
  }
}
```

Do not return a server path. Playback continues through the existing
`/api/file/<download_id>` authorization and path-safety boundary.

### Advance

```http
POST /api/playback-sessions/<session_id>/advance
Content-Type: application/json
```

```json
{
  "expected_download_id": "download-id",
  "sequence": 1
}
```

Advance is idempotent for one retry:

- the next sequence advances exactly once and caches that compact response;
- repeating the current sequence returns the same response;
- a skipped or future sequence returns HTTP 409; and
- a mismatched expected ID returns HTTP 409 without moving the coordinate.

Increment position within the page, then move to the next page. When the
coordinate passes the current last match, wrap to page zero, position zero.
Skip entries that fail the final existence, allowlist, or playability check.
Bound one request to at most the current match count so an all-invalid library
cannot loop forever. When no playable match remains, delete the session and
return HTTP 204; the client stops and reports that the live selection is
empty.

### Keep alive

```http
POST /api/playback-sessions/<session_id>/keepalive
```

Return HTTP 204 after updating last activity. While the player is open, the
client renews the lease no more often than once every five minutes. This is a
resource lease, not History polling: it does not query the library or return
selection data. Stop renewal before sending DELETE. The lease lets a long or
paused video outlive the 30-minute abandoned-session timeout.

### Release

```http
DELETE /api/playback-sessions/<session_id>
```

Deletion is idempotent. `closePlayer()` invalidates client state first and
then sends a best-effort `fetch()` with `keepalive: true`, so a slow response
cannot keep or reopen the player. Idle expiry handles a lost DELETE.

## Player-controller design

### Separate opening from item loading

Refactor the current `playVideo()` responsibilities into two conceptual
operations:

- `openPlaybackSession(...)` opens the overlay, establishes launch provenance,
  requests the initial presentation, and creates the server session; and
- `loadPlaybackItem(...)` changes only the media resource on the persistent
  video element.

Do not call the session-opening operation from an `ended` handler. In
particular, a handoff must not reset fullscreen bookkeeping, reopen the
backdrop, consult the new-tab preference, or call `requestFullscreen()`.

Track explicit client state equivalent to:

```text
phase: idle | opening | loading | playing | advancing | awaiting-user | failed
presentation: original | standard-fullscreen | webkit-fullscreen
launchProvenance: original | fullscreen
loadGeneration: integer
sessionId: string | null
sessionSequence: integer
currentDownloadId: string | null
```

Observed browser state is authoritative for `presentation`. Requested state
alone is not sufficient. Update it through `fullscreenchange`,
`webkitbeginfullscreen`, and `webkitendfullscreen`.

### Initial user activation

The start action must synchronously:

1. keep the existing `#playerVideo` connected;
2. open the built-in player;
3. request standard fullscreen when the preference requires it; and
4. begin initial playback when the starting item is already known.

Do not await `POST /api/playback-sessions` before requesting fullscreen.
`requestFullscreen()` requires and consumes transient user activation. The
server request may run concurrently; if it fails, keep ordinary playback
available and report that endless advancement did not start.

Endless playback is supported only in the built-in player. Do not open one
new browser tab per item. When the saved playback mode is `new_tab`, starting
endless playback must explain that it uses the built-in player and require an
explicit activation; it must not silently override an ordinary single-item
play action.

### Normal handoff

Register one long-lived `ended` listener on `#playerVideo`. Do not set its
`loop` attribute; wrapping belongs to the server session.

For one matching-generation `ended` event:

1. Ignore it unless the phase is `playing` and an endless session is active.
2. Set phase to `advancing` and request the next item using the next sequence.
3. If the player closes while waiting, invalidate the load generation and
   ignore the late response.
4. Keep the same video node, overlay, and fullscreen state connected.
5. Remove the old source, append one typed `<source>` for the returned item,
   and call `load()` once.
6. Increment `loadGeneration`; every media callback captures and verifies it.
7. Call `play()` and observe its promise.
8. Change phase to `playing` only after playback actually starts.

The handoff may show a short loading state but does not need to be gapless.
Do not pre-advance the server position merely because the current video's
remaining time is low.

### Display-mode continuity

Never replace or detach `#playerVideo` during a session. Standards-based
fullscreen is an element flag, not a media-URL flag, so changing the source
on the same connected element does not intentionally leave fullscreen. Do
not call `requestFullscreen()` during a handoff: the `ended` callback has no
new transient activation and reacquisition is not a viable continuity plan.

In the original-size overlay:

- retain the overlay and its original-size mode class while loading;
- on each matching-generation `loadedmetadata`, apply the new resource's
  `videoWidth` and `videoHeight` as its intrinsic target size;
- retain viewport maximums so portrait, very large, and very small videos
  remain controllable; and
- recompute on a matching-generation video `resize` event.

Do not preserve the previous video's pixel width or height. “Original size
stays original size” means preserving the sizing policy; each item uses its
own natural dimensions.

Fullscreen temporarily overrides original-size layout. Preserve the
underlying original-size preference so a permitted fullscreen exit returns to
the current video's original-size overlay.

### Fullscreen exits and platform boundary

Retain the current launch-provenance behavior outside a handoff:

- leaving a session that launched in fullscreen closes the player; and
- leaving fullscreen entered manually from an original-size session returns
  to the overlay.

During `advancing`, a `fullscreenchange` or `webkitendfullscreen` event cannot
reveal whether the user, browser, or source swap caused the exit. Do not let
that event immediately delete the session. Complete or pause the handoff in
the overlay and offer a focused **Return to fullscreen** action. Only that
fresh activation may request fullscreen again.

On standard Fullscreen API implementations, retaining the connected element
is the specified continuity path. Browsers may nevertheless terminate
fullscreen for platform or policy reasons. Native WebKit video fullscreen is
best effort because Apple does not document continuity across `load()`:

- if it remains active, continue without intervention;
- if it exits during a handoff, keep the endless session alive and require one
  tap to return; and
- do not claim uninterrupted native-iOS fullscreen support until it passes
  the supported-device matrix.

## Autoplay denial, media failures, and skips

Handle the promise returned by every automatic `play()` call.

- On fulfillment, clear the transition UI and mark the item playing.
- On `NotAllowedError`, keep the next item loaded and the session coordinate
  unchanged, enter `awaiting-user`, and expose a focused **Continue playback**
  control. Do not mute the item to bypass policy.
- On a known unsupported source, decode failure, terminal media `error`, or
  final media HTTP failure, show a compact skip reason and request the next
  coordinate.
- Treat `waiting` and `stalled` as recoverable buffering signals, not immediate
  failures.

Because child `<source>` failures do not produce reliable promise rejection
in every Chromium version, use both generation-scoped media events and a
loading watchdog. The watchdog:

- resets on `loadedmetadata`, `canplay`, and `playing`;
- pauses while `document.hidden` is true;
- is cancelled on close or generation change; and
- causes a skip only after a documented product timeout.

Stop automatic skipping after one current-selection count or ten consecutive
failures, whichever is smaller. Keep the session open in `failed` state with
**Retry**, **Skip**, and **Close** controls. This prevents an unplayable
library from becoming an endless request loop.

## Concurrency and cleanup

- Permit at most one advance request per client session at a time.
- Use both server sequence checks and client load generations; they protect
  different races.
- Closing invalidates client generations before clearing media sources or
  issuing DELETE.
- A late create, advance, media, or `play()` completion must not reopen the
  overlay, change the source, increment the position, or record a view.
- SSE History reconciliation may update the library UI but must not replace
  the player node or client session controller.
- The media endpoint continues to recheck current authorization and path
  safety. Possession of a playback-session ID never grants file access.

## View-count behavior

Preserve Feature 0025's existing definition of a view as an explicit preview
activation. Starting endless playback from an item records that explicit
activation once through the existing view endpoint. Automatically advanced
items do not increment `view_count`; changing that metric to count automatic
starts or completed watches is a separate product decision.

Do not record a view when session creation fails before the starting item is
activated, when an item is skipped without playing, or when a retry merely
replays an idempotent advance response.

## Accessibility

- **Start endless playback**, **Continue playback**, **Return to fullscreen**,
  **Retry**, **Skip**, and **Close** are native buttons with visible focus and
  accessible names.
- Announce “Loading next video”, the next title, autoplay denial, skipped-item
  reasons, and session termination through a polite live region.
- Do not move focus on every successful automatic handoff.
- When user action is required, move focus to the relevant continuation
  button and keep it reachable in the current presentation.
- Never trap the user in fullscreen; browser fullscreen-exit behavior remains
  available.

## Security and privacy

- Bind every temporary session to the authenticated user ID and re-evaluate
  visibility on every resolution and media request.
- Use opaque random session IDs and return 404 for unknown, expired, or
  foreign sessions.
- Validate filter length, page size, page, position, sequence, ordering, and
  download IDs before using them.
- Do not treat a client coordinate or expected ID as authorization.
- Do not expose stored filenames or server paths in session responses.
- Do not persist playback sessions, filters, or positions to SQLite or logs.
- Avoid logging session IDs; log only bounded operational outcomes such as
  created, advanced, expired, or released.

## Verification

### Backend tests

- A session stores filter/order/coordinate state but no materialized ID list.
- Creation resolves the requested visible starting item and rejects a stale,
  invisible, unfinished, missing, or unsafe item.
- The filter contract matches History for quoted title/tag terms and every
  structured qualifier.
- Newest and favorites-first ordering are deterministic for timestamp ties.
- Advancement crosses page boundaries and wraps to the current first match.
- Insertion, deletion, favorite changes, visibility changes, and file removal
  affect later resolution without exposing private entries.
- A repeated sequence returns the same compact response without advancing
  twice; gaps and expected-ID mismatches return 409.
- Empty/all-invalid selections return 204 without looping.
- DELETE is idempotent; idle expiry, sign-out, suspension, and the per-user
  cap release session state.
- Lease renewal keeps a long-running or paused player alive without resolving
  or materializing the selection.
- One user cannot read, advance, or delete another user's session.

### Browser tests

- Dispatching `ended` once advances once and changes the source on the exact
  same `HTMLVideoElement` object.
- A late callback from the old load generation cannot skip the new item.
- Original-size overlay playback remains open and uses each item's own mocked
  intrinsic dimensions after `loadedmetadata`.
- In the standard-fullscreen harness, `document.fullscreenElement` remains the
  persistent player element and `requestFullscreen()` is called only once for
  an uninterrupted multi-item session.
- Fullscreen entered manually during an original-size session also survives a
  handoff; leaving it returns to the overlay.
- Exiting a fullscreen-launched session while playing closes it and sends
  DELETE, preserving the existing behavior.
- A fullscreen exit during `advancing` retains the session and exposes
  **Return to fullscreen** instead of silently re-requesting it.
- Closing during an outstanding create/advance request prevents the late
  response from changing or reopening the player.
- A rejected `play()` promise exposes **Continue playback** and succeeds from
  the subsequent user activation.
- Terminal media errors skip with a bound; `waiting`, `stalled`, and a hidden
  tab do not cause premature skips.
- Endless playback never opens a sequence of new tabs.

### Manual compatibility matrix

Verify current desktop Chrome/Chromium, Firefox, and Safari, plus iPhone and
iPadOS Safari. Cover:

- standard and native WebKit fullscreen;
- original-size portrait, landscape, low-resolution, and larger-than-viewport
  videos;
- mixed MP4/WebM sources and an unsupported codec;
- slow, stalled, missing, deleted, and visibility-changed files;
- background-tab handoff;
- Escape/fullscreen exit during `playing` and `advancing`; and
- close during session creation, advance, `load()`, and a pending `play()`.

Record native-iOS source-swap results by OS/browser version. Until that matrix
shows stable continuity, product text and release notes must call native-iOS
fullscreen handoff best effort.

## Acceptance criteria

- Starting endless playback creates one server session whose memory use does
  not grow with the number of matching videos.
- The server stores and advances filter, ordering, page size, page, and
  position and resolves each next item from current library state.
- A normal `ended` event starts the next current match and wraps after the
  last match.
- The same connected `#playerVideo` node is used for every item.
- Standards-based fullscreen is not intentionally exited or reacquired during
  a handoff, and the next item begins in that same fullscreen element.
- Original-size playback remains original-size and recalculates from the next
  video's intrinsic dimensions without exceeding the viewport.
- Browser-denied playback has a one-action continuation path; unsupported or
  missing media is skipped without an unbounded loop.
- Closing playback cancels in-flight work and releases the server session;
  idle expiry releases abandoned sessions.
- Current authorization, visibility, and trusted-path checks remain in force
  for every item.
- Legacy native-iOS fullscreen limitations are disclosed and have a
  user-activated return path.

## Non-goals

- This feature does not add named, saved, shared, collaborative, or manually
  reordered playlists.
- It does not guarantee a snapshot-stable result set while the library
  changes.
- It does not provide gapless playback, crossfades, prebuffering, or media
  transcoding.
- It does not guarantee uninterrupted fullscreen when a browser or operating
  system decides to exit it.
- It does not auto-reenter fullscreen without a fresh user activation.
- It does not support endless playback through a chain of new browser tabs.
- It does not redefine view counts as watch counts or track per-user watch
  history.
