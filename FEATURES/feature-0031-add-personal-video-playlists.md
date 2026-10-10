# Add personal video playlists with durable resume progress

**Source:** User-requested feature  
**Status:** Implemented
**Last refined:** 2026-10-10  
**Extends:** Feature 0017, Make Download History the primary thumbnail library;
Feature 0023, Require authentication and manage users; Feature 0025, Track
video views and preview quality; Feature 0027, Add endless library playback
with display-mode continuity

## Decision summary

Add personal, explicitly ordered playlists to the main video library. A
playlist is owned by one authenticated user, may contain any number of
finished videos that user can access, and persists independently from the
temporary playback sessions used for continuous playback.

Present playlists in a dedicated shelf above the existing video grid so they
remain prominent without changing video pagination, History filtering, or the
meaning of the existing **Play All** and **Shuffle** controls. A playlist card
uses its member thumbnails as a preview and reports enough progress to tell the
user where playback will resume.

Clicking a playlist card opens the built-in player and resumes the saved video
at the saved second. During playlist playback, retain the current video element
and show a scrollable ordered queue beside it. The user can select another
queue item directly, and a normally ended video advances to the next playable
item. Playback stops after the final item rather than wrapping.

Keep two kinds of state separate:

- a temporary, in-memory playback session coordinates the currently open
  player, item handoffs, retries, and stale-request protection; and
- durable SQLite playlist progress records the current item and playback
  position so the user can resume after closing the browser, signing out,
  changing devices, or restarting the server.

Playlist progress is scoped to the playlist. Watching the same video directly,
through Play All, through Shuffle, or through another playlist must not move
this playlist's bookmark.

## User outcome

### Creating and filling a playlist

1. The user creates an empty playlist from a new Library header action, or
   chooses **New playlist...** while adding a finished video.
2. The user gives the playlist a required name. Names do not need to be unique.
3. The user adds videos through either the playlist editor or a finished video
   card's **Add to playlist...** action.
4. A video may belong to multiple playlists, but may occur only once in any one
   playlist.
5. Empty playlists remain visible and editable, but their play action is
   disabled.

### Editing a playlist

1. The user opens **Edit playlist** from its card menu.
2. The editor shows the name, a searchable video picker, and every selected
   video in its current order.
3. The user reorders items by drag and drop or equivalent keyboard-accessible
   move controls, and may add or remove items.
4. **Save** commits the name and complete ordered membership atomically.
   **Cancel** leaves the persisted playlist unchanged.
5. Removing a video affects only playlist membership. Deleting a playlist
   never deletes its videos or media files.

### Starting and resuming playback

1. Clicking a non-empty playlist card opens the built-in overlay regardless of
   the ordinary single-video player preference.
2. A playlist with no saved progress starts at its first playable item.
3. A playlist with saved progress opens the saved item and seeks to the saved
   second after media metadata becomes available.
4. The queue appears to the right of the video on desktop and below it, or in a
   collapsible drawer, on narrow screens.
5. The active queue entry is highlighted and scrolled into view. Selecting a
   different entry saves the outgoing position before starting the selected
   item.
6. A normally ended item advances to the next playable entry. Missing,
   inaccessible, unsafe, or browser-incompatible entries are skipped with a
   visible explanation.
7. Ending the final item marks the playlist complete and stops continuous
   playback. The next card activation offers a replay from the beginning
   rather than silently looping.

## Terms

- A **playlist** is a durable, named, owner-bound ordered collection of video
  download records.
- A **playlist item** is one video's membership in one playlist and its
  zero-based canonical position.
- **Playlist progress** is the durable current playlist item, media position in
  seconds, completion state, and last-update time.
- A **playlist playback session** is temporary server state for one currently
  open player. It is not the durable bookmark and may expire without losing
  resume progress.
- The **playlist shelf** is the playlist-card area above the existing History
  video grid.
- The **queue** is the ordered playlist-item navigation shown with the built-in
  player.
- A **playable item** is a visible, finished download whose stored file still
  exists, passes the existing path allowlist, and has a browser-playable media
  type.

## Playlist shelf and cards

Add a **Playlists** shelf above `#historyList`. Do not merge playlist records
into the video pagination array: playlist cards must not consume History page
slots, alter video counts, or become candidates for library Play All or global
Shuffle.

Order playlist cards by most recent content edit, with a deterministic ID
tie-breaker. Progress saves must not reorder cards while the user watches.
Maintain distinct content and progress update timestamps for that reason.

Each card contains:

- a two-by-two mosaic using the first four currently visible member
  thumbnails, with appropriate one-, two-, and three-image layouts;
- an explicit playlist marker so the mosaic cannot be mistaken for one video;
- the playlist name;
- the total item count and combined known duration;
- a resume summary such as `Episode 5 of 12 · 18:42`;
- progress derived from the current item's position in the playlist and its
  saved media time; and
- an empty-state preview when no videos remain.

The primary card action is **Resume playlist**. Its action menu provides:

- **Play from beginning**;
- **Edit playlist**; and
- **Delete playlist**.

Deleting requires confirmation that states clearly that the contained videos
will remain in the library. A completed card displays **Completed** and makes
replay from the beginning explicit.

History search displays matching individual videos and non-empty playlists
containing at least one matching video by default. Structured video filters
such as `quality:`, `user:`, `star:`, and `views:` describe both direct video
results and the member videos used to select playlists; they must not change
playlist membership or playlist playback. `playlist:yes` or its exact alias
`playlists:yes` limits the result type to matching playlist cards.
`playlist:no` and `playlists:no` limit it to matching individual videos.
Clearing search restores both unfiltered result types.

## Creation, quick-add, and editor design

Add a **Create playlist** action near the existing playback controls. On the
small-screen header it may collapse to a labeled icon button while preserving
its accessible name.

A playable finished video card gains **Add to playlist...**. Activating it
opens a chooser containing the current user's playlists and **New playlist...**.
Disable or mark playlists that already contain the video instead of adding a
duplicate. A successful quick-add updates every open client through the SSE
reconciliation path and provides a nonblocking confirmation.

The playlist editor is a modal or responsive drawer with:

- a required name field;
- a search field for visible, finished, playable videos;
- an available-video result list that does not expose inaccessible rows;
- an ordered selected-item list with thumbnail, title, duration, drag handle,
  move-up, move-down, and remove controls;
- **Save** and **Cancel** actions; and
- a clear dirty-state indication before discarding unsaved changes.

Drag and drop is an enhancement, not the only reordering mechanism. Every
ordering operation must be possible with native buttons and the keyboard.
Moving an item retains focus on that occurrence and announces its new position
through an `aria-live` status.

Save the complete edit in one database transaction. A failed validation,
authorization check, stale edit, or database write must leave the old name and
membership unchanged. Include a playlist revision in editor reads and writes;
return HTTP 409 when another tab saved a newer revision instead of silently
overwriting it.

## Player and queue behavior

Playlist playback always uses the built-in overlay. Opening a raw media URL in
a new tab cannot provide the queue, reliable item handoff, or lifecycle events
needed for durable progress. This playlist-specific rule does not change the
configured behavior of ordinary single-video playback.

On desktop, make the player shell a two-column layout:

- the video occupies the flexible left column; and
- the queue occupies a bounded right column with independent vertical scroll.

On narrow screens, move the queue below the video or into a clearly labeled
collapsible drawer. Fullscreen continues to contain only the existing video
element. Exiting fullscreen returns to the overlay where the queue remains at
the active item.

Every queue row shows its one-based sequence number, thumbnail, title, and
known duration. The active row uses both a visual state and `aria-current`.
Selecting a row:

1. saves the current item's progress;
2. changes the temporary playback session's current item idempotently;
3. replaces only the current video's media source;
4. records the selected video view using the existing view-count definition;
   and
5. starts the new video through the existing autoplay/retry handling.

Retain the existing connected `#playerVideo` element, controls-idle behavior,
fullscreen continuity, playback watchdog, transition messages, retry handling,
and automatic-skip limit. Playlist failure handling counts only items in the
playlist session. If every remaining entry fails, stop and leave the queue
visible so the user can select, edit, or close the playlist.

## Durable resume semantics

Persist playlist progress:

- about every ten seconds while media is actively playing;
- on pause;
- before a manual queue switch;
- before an automatic handoff;
- when the player closes;
- on `pagehide` through a bounded keepalive request; and
- immediately when an item ends.

Do not send a request for every `timeupdate` event. Coalesce periodic writes
and omit writes that do not move the stored position meaningfully. A periodic
write may be asynchronous, but a later pause, switch, ended, or close write
must supersede it rather than allowing an older request to move progress
backward.

Store finite, nonnegative seconds. When loading saved progress:

- wait for `loadedmetadata` before assigning `currentTime`;
- clamp the position to the current finite duration;
- treat a position below five seconds as the beginning; and
- treat a position within the greater of 30 seconds or five percent of the end
  as completed when the browser cannot deliver a final `ended` event.

A normal pause or orderly close should resume within approximately one second.
An abrupt browser, machine, or network failure may lose at most the periodic
save interval.

When an item ends, save it as completed and move durable progress to the next
playable item at second zero before loading that item. When the final item ends,
record a completed playlist with no implicit wrap. **Play from beginning**
clears completion and stores the first playable item at second zero.

## Ownership, visibility, and lifecycle

Playlists are private to their creator in this feature.

- Only the owner may list, read, play, rename, edit, or delete a playlist.
- An administrator does not automatically receive access to another user's
  personal playlist.
- A user may add only a download currently visible to them.
- The backend revalidates visibility and file safety whenever it returns
  playlist details or starts, selects, or advances playback.
- Losing access to a member must not reveal its title, filename, thumbnail, or
  other metadata. The UI may show an unavailable placeholder and skip it.
- Deleting a download removes its playlist memberships through database
  referential integrity.
- If the current item is removed, move progress to the next item at the same
  ordinal position, or the new last item when no next item exists. Clear
  progress when the playlist becomes empty.
- Removing an account deletes its owned playlists, memberships, and progress,
  but not downloads owned by or visible to other users.

## Data model

Create these durable SQLite tables through the idempotent `init_db()` path:

### `playlists`

- `id TEXT PRIMARY KEY` containing an unguessable stable identifier;
- `owner_user_id INTEGER NOT NULL` referencing `users(id)` with cascading
  deletion;
- `name TEXT NOT NULL`;
- `revision INTEGER NOT NULL DEFAULT 1`;
- `created_at REAL NOT NULL`; and
- `content_updated_at REAL NOT NULL`.

Index `owner_user_id, content_updated_at` for the shelf query. Playlist names
are not unique.

### `playlist_items`

- `playlist_id TEXT NOT NULL` referencing `playlists(id)` with cascading
  deletion;
- `download_id TEXT NOT NULL` referencing `downloads(id)` with cascading
  deletion;
- `position INTEGER NOT NULL`;
- `added_at REAL NOT NULL`;
- primary key `(playlist_id, download_id)`; and
- unique key `(playlist_id, position)`.

Positions are zero-based, nonnegative, and gapless after every committed edit.
The composite primary key enforces the one-occurrence-per-playlist decision.

### `playlist_progress`

- `playlist_id TEXT PRIMARY KEY` referencing `playlists(id)` with cascading
  deletion;
- `download_id TEXT` referencing `downloads(id)`;
- `position_seconds REAL NOT NULL DEFAULT 0`;
- `completed INTEGER NOT NULL DEFAULT 0` constrained to `0` or `1`; and
- `updated_at REAL NOT NULL`.

The persistence module must additionally enforce that a non-null progress
download is a current member of the same playlist. Membership edits and resume
repair occur in one transaction.

## Backend module and playback integration

Place a Playlist module at the seam between routes, SQLite, and playback. Its
interface should provide these operations rather than exposing table-shaped
helpers to every caller:

- list the current user's playlist summaries;
- load one authorized playlist for editing or playback;
- create or atomically replace a playlist's name and ordered members;
- add one member idempotently;
- delete one owned playlist;
- resolve and repair the durable resume target; and
- save validated progress without allowing an older write to supersede newer
  state.

The module owns name validation, ownership checks, download visibility,
playability, gapless positions, revision conflicts, duration aggregation,
resume repair, and transaction boundaries. Routes remain small adapters, and
tests exercise the same interface used by those routes.

Extend the existing playback-session machinery with mode `playlist`. A
playlist session stores only temporary coordination state: session id, owner,
playlist id and revision, the ordered member IDs resolved at creation, current
position, sequence, retry response, and activity timestamps. Snapshotting the
order prevents a concurrent edit from repeating or skipping items in the
already open player; a new session uses the new revision. Continue to
revalidate authorization and file safety before returning each item.

Durable playlist progress must not live only in `_playback_sessions`. Expiry or
server restart invalidates the live lease but leaves the SQLite bookmark ready
for a new session.

## HTTP interface

All endpoints require the normal authenticated session and same-origin
mutation protection. A foreign playlist ID is indistinguishable from an
unknown one.

| Method and path | Behavior |
| --- | --- |
| `GET /api/playlists` | Return owner-visible card summaries, including mosaic IDs and resume summary |
| `POST /api/playlists` | Create a named playlist with an optional first download; return HTTP 201 |
| `GET /api/playlists/<id>` | Return the authorized ordered detail, progress, and revision |
| `PUT /api/playlists/<id>` | Atomically replace name and ordered download IDs using the expected revision |
| `DELETE /api/playlists/<id>` | Delete the playlist, memberships, and progress only |
| `POST /api/playlists/<id>/items` | Idempotently quick-add one visible playable download |
| `PUT /api/playlists/<id>/progress` | Idempotently save a validated item, seconds, completion state, and write sequence |

Extend `POST /api/playback-sessions` to accept:

```json
{
  "mode": "playlist",
  "playlist_id": "playlist-id",
  "start_download_id": "optional-download-id",
  "restart": false
}
```

The create response includes the current item, playlist revision, current
queue position, and sanitized ordered queue required by the player. It never
returns filesystem paths. Add an idempotent session-selection operation for a
manual queue choice; automatic advance continues through the existing
sequence-checked advance route. Release and keepalive retain their current
semantics.

Validation failures return HTTP 400, unknown or foreign resources return 404,
stale playlist revisions or invalidated playback positions return 409, and
successful idempotent progress writes return 204.

## Live reconciliation

Publish a `change` SSE event after every committed playlist create, edit,
quick-add, delete, or content-affecting download deletion. Open clients refetch
playlist summaries and the normal video history. Progress ticks must not cause
the entire library to rerender every ten seconds; update the initiating card
locally and use a distinct, owner-relevant progress event only when another
tab needs reconciliation.

Do not broadcast private playlist metadata in the event payload. The payload
may contain only a reason and opaque playlist ID; the authenticated refetch is
authoritative.

## Validation and error handling

- Normalize names to Unicode NFC and trim surrounding whitespace.
- Require 1 through 120 visible characters and reject control characters.
- Bound a playlist to 10,000 items even though the initial UI may virtualize
  at a lower threshold.
- Reject non-string, duplicate, unknown, invisible, unfinished, missing, or
  unsafe download IDs in full editor saves.
- Reject booleans, non-finite numbers, negative seconds, and positions beyond
  a conservative server maximum in progress payloads.
- Never accept a filename or media path from the client.
- Preserve the previously committed playlist after any partial validation or
  write failure.
- Show actionable inline errors without closing the editor or discarding its
  draft.

## Accessibility and responsive behavior

- Playlist cards, menus, editor controls, queue rows, and destructive
  confirmations are fully keyboard reachable.
- Native buttons own actions; do not make an undifferentiated card container
  the only activation target.
- The editor traps focus while modal and restores focus to its opener.
- Queue selection exposes `aria-current`, and status changes are announced
  without moving focus unexpectedly.
- Dragging is never required to reorder.
- Focus indicators use the existing themed focus color and remain visible over
  thumbnails and the dark player backdrop.
- At small breakpoints, neither the player nor queue can overflow the viewport,
  and the video remains the first reading-order element.

## Testing and completion criteria

Backend coverage must include:

- schema initialization and migration of an existing database;
- create, list, rename, reorder, quick-add, remove, and delete behavior;
- duplicate prevention and gapless ordering;
- revision conflicts and transactional rollback;
- per-user isolation, administrator isolation, visibility loss, and account
  deletion;
- download deletion and resume-target repair;
- progress validation, stale-write protection, completion, and restart
  persistence;
- playlist playback create, manual select, advance, retry idempotency,
  keepalive, expiry, and final-item stop behavior; and
- path, file-existence, and browser-playability revalidation.

Browser coverage must include:

- creating and quick-adding a playlist from the library;
- editing its name and order with buttons and pointer dragging;
- card mosaic, counts, empty state, resume text, and deletion confirmation;
- opening at the first item and restoring a saved item and second;
- queue highlighting, scrolling, manual selection, automatic advance, and
  stopping after the last item;
- progress saves on pause, close, handoff, and page lifecycle exit;
- responsive queue placement and keyboard-only operation; and
- no regressions in direct playback, new-tab playback, Play All, Shuffle, or
  fullscreen continuity.

Before implementation is complete, run `./tests/run-all.sh --unit` and verify
that `vdl.py` line coverage remains at or above the enforced 90% threshold.
Run the browser playback suite for the complete interaction contract.

## Acceptance criteria

1. A user can create, rename, edit, and delete a personal playlist.
2. Finished visible videos can be added from either a card or the editor and
   reordered or removed accessibly.
3. A video can belong to multiple playlists but cannot appear twice in one.
4. Playlist cards appear above the video grid with meaningful artwork, item
   count, duration, and resume information.
5. Clicking a card opens the overlay at the persisted video and second.
6. The overlay shows the complete sanitized queue and permits direct item
   selection.
7. Normal completion advances in canonical order and stops after the final
   item without wrapping.
8. Resume progress survives sign-out, browser close, device changes, and
   server restarts within the documented save tolerance.
9. Another user, including an administrator, cannot observe or mutate a
   personal playlist without ownership.
10. Deleted, missing, unsafe, or newly invisible videos are repaired or
    skipped without leaking metadata or corrupting order.
11. Existing direct, Play All, Shuffle, fullscreen, and new-tab playback
    behavior remains unchanged.
12. Required unit and browser suites pass and the backend coverage gate is
    satisfied.

## Non-goals

This feature does not include:

- importing remote YouTube or other provider playlists;
- sharing playlists or collaboratively editing them with other users;
- placing the same video in one playlist more than once;
- uploading or selecting custom playlist artwork;
- shuffling within a playlist; or
- saving independent resume bookmarks for ordinary single-video playback.
