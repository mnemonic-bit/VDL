# Expand playlists with imports, sharing, repeated items, artwork, shuffle, and video bookmarks

**Source:** User-requested follow-on feature  
**Status:** Proposed  
**Last refined:** 2026-10-10  
**Extends:** Feature 0023, Require authentication and manage users; Feature
0026, Download authenticated pages with Firefox; Feature 0030, Add shuffle
playback to the Play All control; Feature 0031, Add personal video playlists
with durable resume progress

## Decision summary

Promote every explicit non-goal from Feature 0031 into the next playlist
capability set:

- import remote YouTube and other yt-dlp-supported playlists;
- share playlists with other application users and support controlled
  collaborative editing;
- allow repeated occurrences of the same video in one playlist;
- let owners provide custom playlist artwork;
- shuffle within a playlist; and
- save per-user resume bookmarks for ordinary single-video playback.

These additions change playlist identity and progress semantics. A playlist
item can no longer be identified by `(playlist_id, download_id)` because one
download may occur several times. Introduce a stable occurrence ID and bind
linear progress, shuffled progress, queue selection, imports, and editor focus
to that occurrence.

Sharing does not make progress shared. Every authorized user keeps an
independent playlist bookmark and an independent shuffled cycle. A viewer's
playback must never move the owner's or another collaborator's resume point.

Remote import creates a real local playlist and ordinary VDL download rows. It
is not a remote streaming shortcut. Source order is preserved, partial success
is visible, and each imported item enters the normal download worker queue,
visibility rules, path-safety checks, media inspection, and retry lifecycle.

## User outcomes

### Importing a remote playlist

1. The user chooses **Import playlist** and enters a URL supported by yt-dlp.
2. VDL probes playlist metadata without downloading media, shows the detected
   title and item count, and asks the user to confirm the name, visibility, and
   normal download options.
3. Confirmation creates the local playlist immediately and adds one ordered
   occurrence per remote entry.
4. Existing matching library videos may be reused when VDL has a strong stored
   source identity; otherwise each entry becomes a normal queued download.
5. The playlist card and editor show queued, downloading, finished, failed,
   cancelled, unavailable, and skipped states while preserving source order.
6. Successful items become playable in place. A failed item remains visible
   with retry and remove actions instead of silently disappearing.

### Sharing and collaboration

1. The owner opens **Share playlist** and selects an existing active user.
2. The owner grants either **Viewer** or **Editor** access.
3. Viewers may see and play the playlist but cannot change its metadata,
   membership, artwork, or access list.
4. Editors may rename, reorder, add, remove, and repeat items, but cannot delete
   the playlist, replace its owner, or change sharing permissions.
5. The owner may change or revoke access at any time. Revocation takes effect
   on the other user's next request and stops future queue or media resolution.
6. Every user sees only their own progress, completion state, and shuffle
   session when opening the shared playlist.

### Repeating a video

1. Adding a video already in the playlist creates another occurrence after
   explicit confirmation or through a dedicated **Add another copy** action.
2. Each occurrence can be moved or removed independently.
3. The queue distinguishes repeated entries by position and occurrence ID even
   when their title and thumbnail are identical.
4. Resume and automatic advancement return to the correct occurrence rather
   than the first matching download.

### Custom artwork

1. The owner opens the playlist editor and chooses **Change artwork**.
2. The owner may upload a supported image, choose one member thumbnail as the
   cover, or restore the automatic mosaic.
3. The chosen artwork appears on playlist cards, in the editor, and in the
   player queue header.
4. Removing or losing the selected source thumbnail falls back safely to the
   automatic mosaic. Removing uploaded artwork deletes only the managed image
   asset.

### Playlist shuffle

1. A playlist card and player expose **Shuffle playlist** alongside linear
   resume and play-from-beginning.
2. Starting shuffle creates a randomized order of eligible occurrence IDs.
3. Every eligible occurrence appears once per cycle, including repeated
   occurrences of the same underlying video.
4. The same occurrence is not repeated until the cycle is exhausted, and a
   new cycle avoids immediately replaying the prior cycle's final occurrence
   when another choice exists.
5. Stopping shuffle preserves the exact occurrence, second, remaining order,
   and cycle position. Resuming later continues that shuffled cycle.

### Ordinary video bookmarks

1. Directly opening a video resumes at that user's saved position.
2. The video card shows a progress indicator and **Resume at ...** when useful.
3. The user may choose **Play from beginning** or **Clear watch progress**.
4. Direct progress is per user and per download. It does not overwrite any
   playlist's linear or shuffled progress.
5. Completing the video marks it watched; replay begins at zero while retaining
   a completed indicator until the user clears it or starts a new watch.

## Terms and permission model

- A **playlist occurrence** is one stable playlist-item row. Several
  occurrences may reference the same download.
- The **owner** created or currently owns the playlist and controls deletion,
  artwork, and access grants.
- A **viewer** has read and playback access plus private per-user progress.
- An **editor** has viewer capabilities plus content-edit permission.
- A **share grant** connects one playlist and one user to exactly one role.
- A **remote playlist import** is a durable import job that resolves a provider
  collection into local playlist occurrences and download records.
- A **shuffle cycle** is one durable randomized permutation of currently
  eligible occurrence IDs for one user and playlist.
- **Direct video progress** is a per-user bookmark for playback outside any
  playlist context.
- **Automatic artwork** is Feature 0031's member-thumbnail mosaic.
- **Custom artwork** is either an owner-uploaded managed image or an explicitly
  selected member thumbnail.

Permissions are additive only through explicit share grants:

| Capability | Owner | Editor | Viewer |
| --- | :---: | :---: | :---: |
| View and play | Yes | Yes | Yes |
| Maintain personal progress | Yes | Yes | Yes |
| Rename and edit occurrences | Yes | Yes | No |
| Start an import into the playlist | Yes | Yes | No |
| Change custom artwork | Yes | No | No |
| Manage sharing | Yes | No | No |
| Delete playlist | Yes | No | No |

Administrators do not receive implicit access. Application administration and
playlist collaboration remain separate capabilities.

## Remote playlist import

### Supported inputs and probing

Accept HTTP or HTTPS collection URLs handled by the installed yt-dlp version.
Reject local paths, non-network schemes, and single-video probe results unless
the user explicitly chooses to create a one-item playlist.

Use a bounded metadata extraction that does not download media. Apply the
existing URL validation, redacting logger, browser-authentication handling,
and optional PO-token integration. Never return cookies, provider secrets,
filesystem paths, or raw extractor diagnostics to another user.

The confirmation preview includes:

- detected playlist title;
- provider name;
- number of entries and whether the provider reported an incomplete count;
- the first bounded set of entry titles and thumbnails when available;
- unavailable or private source entries reported by the extractor; and
- the download format, visibility, and browser-session choices that will apply
  to newly created download rows.

Bound imports to 10,000 entries. Reject larger known collections before
creating rows. For extractors that reveal entries incrementally, stop at the
limit, retain already resolved metadata only in the uncommitted probe, and
require the user to narrow the source rather than silently truncating it.

### Commit and execution

Confirming an import atomically creates:

- the local playlist when importing as new;
- one import job;
- one ordered occurrence per accepted remote entry; and
- any required ordinary download rows in queued/starting state.

Do not start provider extraction or media download while holding the database
lock. After commit, feed new download rows through the existing bounded worker
queue. Imported downloads use the importing user's ownership and selected
visibility. Reused downloads retain their existing owner and visibility, and
may be reused only while visible to the importer.

Store provider-stable source identity when available so the import can reuse a
strong match. A normalized URL string alone is insufficient when it can refer
to changing content. When no strong identity exists, create a new download
rather than attaching an unrelated file.

An occurrence may reference a not-yet-finished download. Playlist summaries,
details, and SSE reconciliation therefore include a sanitized occurrence
state. Playback skips nonfinished occurrences, while the editor offers the
same stop, resume, retry, and remove operations allowed for the underlying
download.

Partial failure does not roll back finished items. The import job reports
total, resolved, queued, finished, failed, and unavailable counts. Retrying the
job operates only on unresolved or failed source entries and must not duplicate
successful occurrences.

## Shared-playlist behavior

The playlist shelf has **Mine** and **Shared with me** groupings without
mixing ownership into the existing video History filter. Shared cards identify
their owner and the current user's role. Search matches playlist name and owner
display name.

All playlist reads resolve access from the database on every request. A live
playback session snapshots occurrence order but does not snapshot permission:
revocation invalidates its next keepalive, select, advance, or progress write.
An already-open media response may finish naturally, but no later file request
is authorized through the revoked playlist.

Editors use Feature 0031's revision-checked atomic save. A stale editor receives
HTTP 409 and a current playlist snapshot suitable for review; it must not
silently replay local operations over another editor's changes. Share changes
increment the playlist revision only when they affect content visibility or
editor state presented by the client.

Removing or suspending a user deletes their share grants and personal playlist
progress. Removing an owner deletes owned playlists under Feature 0031's
policy; it does not transfer ownership implicitly. A later ownership-transfer
feature would require an explicit, audited action.

## Occurrence identity and ordering

Replace Feature 0031's composite playlist-item identity with:

- `id TEXT PRIMARY KEY`, an unguessable stable occurrence ID;
- `playlist_id TEXT NOT NULL`;
- `download_id TEXT NOT NULL`;
- `position INTEGER NOT NULL`;
- optional import-entry identity and source ordinal; and
- `added_by_user_id` and `added_at` audit fields.

Keep the unique `(playlist_id, position)` constraint but remove uniqueness for
`(playlist_id, download_id)`. All editor commands, playback session positions,
progress rows, queue DOM keys, and import retries use occurrence IDs.

Deleting a download removes all referencing occurrences. Removing one
occurrence does not affect its siblings. Resume repair chooses the next
surviving occurrence by canonical position, even when another occurrence
references the same download.

## Custom artwork

Support these artwork modes:

- `automatic`, the default member mosaic;
- `member`, referencing one playlist occurrence whose thumbnail is visible to
  every playlist viewer; and
- `upload`, referencing one managed image owned by the playlist.

Accept JPEG, PNG, or WebP uploads up to 5 MiB. Validate both declared type and
decoded image structure, reject animated images, strip metadata during a
bounded re-encode, and generate the fixed card renditions needed by the UI.
Do not serve the original client filename or accept an output path from the
client.

Store artwork under a dedicated managed directory outside arbitrary download
paths. Persist only generated opaque filenames and media metadata. Serve it
through an authenticated playlist-artwork route that rechecks playlist access
and uses conservative cache headers. Deleting or replacing uploaded artwork
removes obsolete managed renditions after the database commit; cleanup is
retryable if filesystem deletion fails.

A member cover is valid only while the referenced occurrence, thumbnail, and
viewer visibility remain valid. Otherwise return the automatic mosaic without
leaking the hidden member and let the owner choose a replacement.

## Playlist shuffle semantics

Shuffle operates on occurrence IDs, not distinct download IDs. Repeated video
occurrences therefore receive their intended weight and appear once each per
cycle.

At shuffle start:

1. resolve all currently authorized, finished, safe, playable occurrences;
2. generate an unbiased random permutation using the server's secure random
   source;
3. avoid placing the immediately previous occurrence first when another
   occurrence exists;
4. persist the ordered occurrence IDs, current index, playlist revision, and
   per-user current second; and
5. create the ordinary temporary playback lease from that durable cycle.

Edits during a cycle do not reorder its surviving occurrences. Deleted,
inaccessible, or unplayable occurrences are skipped. Newly added occurrences
join the next cycle. When the cycle ends, generate a new permutation from the
then-current eligible membership unless the user has chosen **Stop after this
shuffle**.

Linear and shuffle progress are distinct. Starting shuffle does not replace
the user's linear bookmark. The playlist card remembers the last playback mode
and offers **Resume linear**, **Resume shuffle**, and explicit restart actions
when both bookmarks exist.

## Independent direct-video bookmarks

Persist one direct playback row per `(user_id, download_id)` containing finite
position seconds, completion state, last known finite duration, monotonically
ordered write token, and update timestamp.

Use the same throttled save triggers and stale-write protection as playlist
progress: periodic playback, pause, close, `pagehide`, and ended. Direct
playback restores progress only after metadata loads and applies the same
beginning and near-end thresholds from Feature 0031.

Video cards display a subtle watched/progress treatment without replacing the
existing `NEW` or view-count meanings. A view remains an explicit playback
activation; progress ticks do not increment it. **Play from beginning** resets
the bookmark before playback. **Clear watch progress** deletes it. Deleting a
download or user cascades its progress rows.

Playlist playback never writes direct-video progress. Direct playback never
writes linear or shuffled playlist progress. This separation is required even
though all modes reuse the same video element and progress transport helper.

## Data-model additions and migration

Evolve Feature 0031's tables through idempotent migration code:

- give every `playlist_items` row a stable occurrence ID and migrate existing
  unique memberships without changing their order;
- replace owner-only `playlist_progress` with per-user linear progress keyed by
  `(playlist_id, user_id)` and occurrence ID;
- add `playlist_shares(playlist_id, user_id, role, created_at)` with unique
  playlist/user membership and roles `viewer` or `editor`;
- add durable shuffle-cycle state keyed by playlist and user;
- add import jobs and import-entry identity sufficient for idempotent retry;
- add playlist artwork mode and opaque managed-asset metadata;
- add `video_progress(user_id, download_id, ...)`; and
- retain foreign-key cleanup for playlists, users, downloads, occurrences, and
  progress.

The migration must preserve every Feature 0031 playlist, order, owner, and
resume position. Existing progress becomes the owner's linear progress and
maps its download ID to that playlist's sole matching occurrence before
duplicate occurrences become available.

Do not modify the initial `CREATE TABLE downloads` definition to support these
features. Any new download columns follow the repository's additive migration
convention; new independent tables use idempotent creation.

## Interface extensions

Retain Feature 0031's playlist routes and add:

| Method and path | Behavior |
| --- | --- |
| `POST /api/playlists/import/probe` | Validate and summarize a remote playlist without mutation |
| `POST /api/playlists/import` | Create or extend a playlist and start an idempotent import job |
| `GET /api/playlist-imports/<id>` | Return sanitized import counts and entry states |
| `POST /api/playlist-imports/<id>/retry` | Retry unresolved and failed entries only |
| `GET /api/playlists/<id>/shares` | Owner-only list of share grants |
| `PUT /api/playlists/<id>/shares/<user_id>` | Owner-only create or role change |
| `DELETE /api/playlists/<id>/shares/<user_id>` | Owner-only revoke |
| `PUT /api/playlists/<id>/artwork` | Owner-only member selection or validated image upload |
| `DELETE /api/playlists/<id>/artwork` | Restore automatic artwork and remove managed upload |
| `PUT /api/video-progress/<download_id>` | Save the current user's direct bookmark |
| `DELETE /api/video-progress/<download_id>` | Clear the current user's direct bookmark |

Playlist detail and editor payloads identify items by occurrence ID. Playback
session creation accepts `mode: "playlist_linear"` or
`mode: "playlist_shuffle"` and an optional starting occurrence ID. Never
accept a raw file path, artwork output path, owner ID override, or arbitrary
share role from the client.

SSE events remain reconciliation signals and contain no private names, URLs,
share lists, import diagnostics, or progress seconds. Refetched responses are
filtered for the current user.

## Error and conflict behavior

- A foreign or revoked playlist is returned as 404.
- Insufficient role for a known authorized playlist mutation returns 403.
- A stale playlist revision returns 409 without partial mutation.
- Unsupported, single-item, oversized, or inaccessible remote collections
  produce actionable probe errors before commit.
- Extractor and download failures remain per-entry states after commit.
- A revoked or suspended collaborator cannot keep a session alive or save
  progress.
- Invalid artwork is rejected before replacing the previous cover.
- Missing artwork files fall back to automatic artwork and schedule safe
  cleanup; they do not make the playlist unavailable.
- A shuffle cycle whose remaining items all became invalid ends cleanly and
  offers creation of a new cycle.
- Progress requests with stale write tokens are idempotent no-ops rather than
  regressions.

## Testing and completion criteria

Backend coverage must add:

- occurrence-ID migration and preservation of Feature 0031 order and progress;
- multiple occurrences of one download, independent reorder/removal, and
  resume repair;
- viewer/editor/owner authorization, grant changes, revocation during
  playback, suspension, and account deletion;
- independent per-user linear and shuffle progress on a shared playlist;
- deterministic tests around randomized shuffle-cycle membership, no repeats,
  cycle restart, mutation, and durable resume;
- remote probe limits, authenticated extraction, idempotent import commit,
  partial failure, retry, worker-queue integration, and source identity reuse;
- artwork decoding, limits, metadata stripping, authorization, replacement,
  fallback, and filesystem cleanup;
- direct-video bookmark save, resume, reset, completion, user isolation, and
  strict separation from playlist progress; and
- payload redaction, path safety, transaction rollback, and SSE privacy.

Browser coverage must add:

- import preview, confirmation, live entry states, partial failure, and retry;
- sharing as viewer and editor, permission-sensitive controls, collaborative
  revision conflicts, and immediate revocation;
- adding, reordering, playing, and removing repeated occurrences;
- uploading, selecting, replacing, and clearing artwork;
- starting and durably resuming playlist shuffle without occurrence repeats;
- distinct linear, shuffle, and direct-video resume points for the same media;
- card progress and watched treatments; and
- keyboard, screen-reader, responsive, fullscreen, and failure-state behavior
  for every new control.

Before implementation is complete, run `./tests/run-all.sh --unit` and verify
that `vdl.py` line coverage remains at or above 90%. Run the browser suite and
the relevant real-media tests for imported downloads, artwork generation, and
resume seeking.

## Acceptance criteria

1. A supported remote playlist can be previewed and imported without blocking
   the request on media downloads.
2. Imported order and partial entry states are durable, visible, retryable,
   and idempotent.
3. Owners can grant and revoke viewer or editor access without giving
   administrators implicit playlist access.
4. Every shared user has independent linear and shuffled progress.
5. A download can appear multiple times in one playlist, and every occurrence
   remains independently addressable through editing and playback.
6. Owners can upload safe custom artwork, select a member cover, and restore
   the automatic mosaic.
7. Playlist shuffle plays each eligible occurrence once per durable cycle and
   resumes the exact occurrence, second, and remaining order after restart.
8. Direct video playback has a per-user bookmark that never changes playlist
   progress, and playlist playback never changes the direct bookmark.
9. Existing Feature 0031 playlists migrate without losing ownership, order,
   items, or resume position.
10. Authorization, path safety, secret redaction, transactional edits, and SSE
    privacy continue to hold for every expanded capability.
11. Existing direct playback, Play All, global Shuffle, downloads, uploads,
    and personal playlists remain compatible.
12. Required unit, browser, and real-media suites pass and the backend coverage
    gate is satisfied.

## Non-goals

This follow-on still does not include public unauthenticated playlist links,
anonymous collaboration, ownership transfer, comments, reactions, provider
account synchronization, automatic polling of remote playlists for new
episodes, or editing the order of the source playlist on its remote provider.
