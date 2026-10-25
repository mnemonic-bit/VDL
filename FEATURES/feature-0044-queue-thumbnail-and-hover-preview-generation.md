# Queue thumbnail and hover-preview generation

**Source:** User-requested feature

**Status:** Implemented in 0.47.0

**Last refined:** 2026-10-25

**Extends:** Features 0017, 0021, 0024, and 0033

**Updates:** Feature 0042's lazy-generation policy and Bug 0054's
request-triggered thumbnail generation

## Decision summary

Automatically queue a static thumbnail and a hover-preview montage whenever a
video becomes a finished Library item, regardless of how it arrived: URL,
drag-and-drop upload, or `ingest-dir` / mounted-file import. Generate them in
the background even if nobody opens the application. Use **one shared worker
and one generation task at a time**, across both asset types and all users.

Opening a Library page promotes its missing assets ahead of ordinary pending
work. Generate visible static thumbnails first, then an intentionally hovered
video's montage, then other visible montages. Reconsider priorities after each
asset; never finish an entire video's thumbnail-and-montage pair without
checking for newly urgent work. Allow occasional background work so a large
import continues progressing while people browse.

A video becomes playable as soon as its media is finalized. Preview readiness
is separate from download/import success. Pending images update in place when
ready, and asset generation never holds an image or video HTTP request open.

## Behavior before implementation and evidence

Inspection of the current source supports the reported behavior:

- [`_background_download()`](../vdl.py) generates the URL download's static
  thumbnail synchronously before recording `finished`. This call bypasses
  the request-side thumbnail admission limit.
- [`receive_video_upload()` and `_ingest_watched_file()`](../vdl.py) publish
  finished imports without generating either asset.
- [`stream_thumbnail()` / `_ensure_video_thumbnail()`](../vdl.py) generate
  a missing JPEG in the request thread. Bug 0054 deduplicated that work,
  limited request-triggered thumbnail generation to two concurrent tasks,
  and added capacity retries; it did not add an unattended backlog worker.
- [`stream_preview()`](../vdl.py) generates a missing montage during its first
  request under a separate lock. [`startHoverPreview()`](../static/app.js)
  requests that montage only after intentional hover.

Consequently, time spent idle after an import does not prepare those assets.
These source findings explain the observation; no timing measurements from
the reported deployment have been taken.

## Publication and existing-library backfill

1. Once the final stored file has been validated and published, register both
   required assets at background priority. All publication paths must cross
   the same scheduling seam, including resumed/retried URL downloads and
   companion/playlist downloads that use the normal URL flow.
2. Store the pending asset records in the same transaction as publication
   where practical. Otherwise, startup reconciliation must close the gap
   between a committed finished row and a missed enqueue. Wake the worker
   only after commit. Do not enqueue partial uploads, unfinished transfers,
   rejected imports, cancelled work, or audio-only entries.
3. Import completion and URL download-slot release must not wait for preview
   extraction. An accepted video remains `finished` if either asset fails.
   Preserve ingest receipts, duplicate handling, tags, and attempt history.
4. At startup, reconcile finished videos in bounded database batches and
   register missing current-version assets, including the existing roughly
   1,500-video import. Start serving requests before the scan finishes. Do
   not decode video, read whole media files, or hold the database write lock
   while scanning the collection's files.
5. Reuse existing valid current-version sidecars. Register readiness without
   regenerating them. A missing asset request can also register work missed
   by reconciliation, using the same deduplicated queue.
6. Start only one worker in the serving process; the Werkzeug debug parent
   must not start another. Restarting the application or replacing its
   container resumes pending work from persistent state. Reclaim work marked
   running by the previous process and remove its abandoned temporary files.

This supersedes Feature 0042's decision to leave imports and old-cache
replacement to first request. Preserve its two-thirds frame selection,
one-second/start fallbacks, 480-pixel JPEG, cache-version semantics, and
stored-media-path handling. Preserve the montage's current sampling,
dimensions, encoding, and browser compatibility. Reduced-motion and pointer
capabilities still control montage playback, not server-side preparation.

## Queue identity, state, and resource limits

- Treat each asset as an independent task. Deduplicate by download ID, asset
  kind (`thumbnail` or `montage`), and generation/cache version. Bind its
  output to the source file identity so replacement or modification makes
  older results stale. Resolve the stored filename again when claiming work;
  do not retain a request-supplied path or rebuild it from current preferences.
- Persist original enqueue order, state, attempt count, retry time, and a
  bounded failure reason in SQLite. Asset states are `queued`, `running`,
  `ready`, and `failed`; they are separate from the canonical download
  statuses. Deleted/ineligible work is removed rather than inventing another
  download status.
- Keep at most one worker and one active generation task. Thumbnail and
  montage work share this limit, including startup backfill, URL completion,
  page requests, and first hover. No legacy extraction path may bypass it.
- Waiting tasks are database records, not blocked threads or subprocesses.
  Read candidates in bounded batches; do not create one worker per imported
  video or load an unbounded duplicate heap of pending tasks.
- Explicitly bound ffmpeg decoder, encoder, and filter threading as well as
  process concurrency. One ffmpeg process can otherwise use many CPU cores.
  Start with one thread for each applicable setting and verify the
  multi-input montage respects them. Preserve bounded subprocess timeouts.
- This limit covers derived thumbnail/montage work, including its probes.
  Existing download merging and import validation remain separate work;
  one preview task is not a promise of a fixed total host CPU percentage.
- Write to unique temporary sidecars and atomically publish nonempty results.
  Do not hold database or scheduling locks during extraction. Revalidate
  source identity, task ownership, and row eligibility before publication.

## Priority and fairness

Choose the next eligible task using these tiers:

| Priority | Pending work |
| ---: | --- |
| 1 | Static thumbnails for the current visible page/viewport |
| 2 | Montage for an intentionally hovered video |
| 3 | Other montages for the current visible page/viewport |
| 4 | Ordinary publication and backfill tasks, in original enqueue order |

Within the foreground tiers, prefer the most recently changed view, retaining
display order within that view. For a video's initial background registration,
enqueue its thumbnail before its montage. An active task runs to completion
or timeout; priority changes affect the **next** task, not the running process.
There is no fixed promise of instant images when a slow montage is running.

- After eight consecutive foreground tasks, run the oldest eligible ordinary
  background task if one exists, then reset that counter. Failed work awaiting
  its retry time is ineligible and cannot block the queue. Otherwise pick the
  highest-priority eligible task; never idle while eligible work exists.
- Priority is temporary demand, not a permanent rewrite of enqueue order.
  Each browser tab supplies its current demand set. Navigation, filtering,
  page-size changes, and leaving Library replace or clear that set. Videos
  left behind return to ordinary priority unless another tab still needs them.
- For paginated Library, prioritize the displayed page. In endless mode,
  prioritize cards in or immediately adjacent to the viewport, not every
  card accumulated in the DOM. Use viewport observation with a small margin.
- A changed set becomes the newest view. Sending the same set after an SSE
  update must not repeatedly jump ahead. Coalesce rapid navigation/scroll
  changes over 150 ms and discard obsolete requests by a per-tab increasing
  revision number. Keep at most one request in flight and one latest update.
- Scope tab demand to the authenticated user and session. Clear it on logout
  and when the tab becomes hidden where possible. Expire it after 60 seconds
  without fresh interaction; page changes, focus, scrolling, or intentional
  hover can renew it. No periodic heartbeat or asset-status polling is needed.
  Expiration never deletes the underlying background task.
- Multiple users share the same worker and assets. Their active demand sets
  combine; replacing one tab's set must not erase another's. Bound transient
  demand bookkeeping and expire inactive tab records.

Example: 1,500 videos are queued and a montage from page 1 is running. The
user opens page 12. The montage finishes, then page 12's missing thumbnails
are selected in display order, subject to the eight-task fairness rule. Its
hovered montage and other montages follow. Opening page 13 releases page 12's
temporary demand and promotes page 13; already completed assets are reused.

## Browser/server interface and readiness updates

Keep scheduling behind a small asset-generation module interface: register
missing assets for published media, replace a tab's demand, read readiness,
and invalidate removed media. The module owns persistence, deduplication,
dispatch, retry, reconciliation, and publication races. Routes and import
callers must not each implement their own queue or extraction lock.

- Add an authenticated, same-origin `POST /api/assets/demand` accepting a
  tab identifier, increasing revision, ordered download IDs, and optional
  hovered ID. Accept at most 200 unique IDs per update; validate lengths,
  types, and body size. The client sends only its relevant visible subset.
  An empty set clears that tab's demand.
- Resolve every ID through existing visibility and playable-media checks.
  Silently omit unknown, invisible, or ineligible IDs; do not reveal them in
  responses. A hovered ID must belong to the submitted set. Clients cannot
  choose worker counts, numeric priorities, paths, or cache versions.
- Return current per-kind readiness for authorized accepted IDs, without
  waiting for extraction. Expose the same readiness in Library responses so
  an initial render or SSE reconnect can reconcile missed completion events.
  Ready state requires a current valid sidecar, not just a historical DB flag.
- Keep `/api/thumbnail/<id>` and `/api/preview/<id>` as cached asset delivery
  routes with existing authentication, visibility, path checks, conditional
  responses, and montage byte-range support. On a miss, enqueue without
  decoding or waiting and return `202 Accepted` with `Cache-Control: no-store`.
  HEAD must not launch a decoder or wait for the worker either. Existing
  hidden/unknown/missing-media responses and forbidden-path responses remain.
  An exhausted generation failure returns an unavailable response, not 202.
- Do not assign missing assets to image/video `src` in the normal UI. Show
  **Preparing preview** for queued/running thumbnails and the existing camera
  artwork with **Preview unavailable** for exhausted failures. Keep playback
  enabled while either generated asset is pending or failed.
- Publish a dedicated, coalesced `assets` SSE notification after readiness
  changes. Deliver IDs/readiness only to users currently authorized to see
  them, rechecking access when sending; do not broadcast private item IDs or
  filenames through the generic unfiltered event payload.
- Update affected cards in place and request only newly ready asset URLs.
  Do not trigger complete Library/Current/Playlist refreshes for every asset,
  rebuild healthy image elements, or interrupt playback/hover videos. Extend
  Bug 0054's bounded refresh behavior rather than reintroducing amplification.
- Readiness notifications are hints: SSE queues can drop events. Coalesce a
  bounded reconciliation of the current demand set when a notification
  arrives, and reconcile on SSE `ready`/reconnect, page change, and focus.
  Do not depend on receiving every completion ID to remove all placeholders.
- Replace the current HEAD/image capacity-retry loop for generation misses
  with readiness-driven loading. Retain bounded recovery for genuine
  transport failures; no timer loop should probe each pending image.
- If a montage becomes ready while the pointer still intentionally hovers
  its card, start it through the existing hover behavior. Leaving the card
  prevents delayed playback. Respect reduced motion and touch capabilities.
  Preparing assets and hovering must not increment a video's view count.

## Failure, invalidation, and removal

- Catch task failures so one corrupt video cannot stop the worker. Attempt
  each asset at most three times, with 30-second and five-minute delays
  before retries. A thumbnail's existing seek fallbacks belong to one task
  attempt. Persist attempts and retry times across restart; page loads and
  repeated hovers do not reset them. Invalid/ineligible media is skipped.
- After exhaustion, persist `failed` with a concise reason and retain the
  unavailable artwork. A new source identity or generation version gets new
  work; ordinary page requests do not endlessly requeue unchanged failures.
  A separate retry-management UI is outside this first version.
- One asset may succeed when the other fails. Preserve the successful one,
  allow normal playback, and do not change download/attempt success or create
  a new import receipt/attempt for preview retries.
- Before serving, claiming, and publishing work, enforce stored-path
  confinement. Recheck eligibility and source identity after generation.
  Visibility changes affect delivery and notifications immediately.
- Deletion and Clear Library invalidate queued/running work before artifact
  cleanup. An in-flight task must discard its output if deletion wins; it
  must never recreate an orphan sidecar after cleanup. Remove temporary and
  current/legacy sidecars through existing artifact ownership rules. Clearing
  attempt history alone must not invalidate surviving Library media.
- Recover safely from rename/source replacement, lost sidecars, restart, and
  missing tools. Never serve a stale asset for a different source identity.
  Retry exhaustion remains bounded even across these recovery paths unless
  the actual source or requested generation version changes.

## Acceptance criteria and verification

1. Import about 1,500 videos with no browser connected. Both assets are
   registered for every eligible video and generation starts automatically.
   After the queue drains, opening a previously unvisited page only serves
   cached assets. No work depends on the first thumbnail request or hover.
2. URL downloads, drag-and-drop uploads, mounted-file imports, and resumed
   URL jobs all use the same queue. Media publication and URL slot release
   complete while a generation fixture is deliberately blocked.
3. Simultaneous import, page-load, hover, and backfill demand never overlap
   generation tasks. Duplicate requests produce one task per current asset,
   and thousands of waiting assets do not create thousands of threads.
4. With generation blocked and a long backlog, opening another page promotes
   its thumbnails for the next dispatch. Verify tier order, display order,
   stale-request rejection, unchanged-set behavior, viewport handling,
   multiple tabs/users, expiration, and the eight-task fairness exception.
5. Stop the process with queued and running tasks. Restart it without opening
   a browser: pending assets resume, valid caches are reused, abandoned work
   is reclaimed, and persisted failure backoff is respected. Upgrade backfill
   does not delay serving until the full library scan finishes.
6. Browser tests show Preparing preview changing to the actual thumbnail
   without reload, including a deliberately dropped completion event and SSE
   reconnect. Healthy image nodes survive; no per-image HEAD retry storm or
   per-asset full-collection refresh occurs. Hover readiness starts playback
   only while the pointer remains on the card.
7. Cached montage range requests still work. Asset misses return promptly
   without ffmpeg; source/path/visibility protections apply to demand,
   readiness, asset delivery, and SSE. Test private-video notification leakage.
8. A corrupt file, missing executable, timeout, or unwritable sidecar fails
   within the bounded retry policy and other videos continue. Verify the
   ffmpeg thread limits, atomic publication, independent per-kind failures,
   source changes, deletion during generation, and Clear Library races.
9. Pending or failed assets never block normal video playback, alter view
   counts, duplicate media rows/receipts, or turn completed media into errors.

Use deterministic blocking generation fixtures and a controllable clock for
queue/retry tests, plus a small real-ffmpeg smoke test for both formats and
thread-limit arguments. Extend `tests/test_thumbnails.py`,
`tests/test_hover_previews.py`, `tests/test_uploads.py`,
`tests/test_ingest_folder.py`, and `tests/test_live_refresh.py` as appropriate;
put scheduler behavior behind the module interface in a focused queue suite.
Add browser coverage for demand changes and targeted readiness updates.

Before marking implementation complete, run `./tests/run-all.sh --unit` and
verify the enforced **90% minimum `vdl.py` line coverage**, using Python 3.12
when close to the threshold. Run the relevant browser tests and verify a
large unattended import with thread/process observations. Implementation is a
feature and requires its own MINOR version bump; this specification alone
does not change `VERSION`.

## Non-goals

No additional broker, Redis/Celery deployment, parallel preview workers,
configurable concurrency, new frontend framework, montage format redesign,
GPU pipeline, full processing dashboard, or guaranteed completion time.
Existing cached images keep working throughout backfill.

## Implementation and verification

`asset_generation.py` owns the persistent shared queue, temporary demand,
bounded retries, reconciliation, and atomic publication. `vdl.py` connects
media publication, cached delivery, demand, deletion, and authorized SSE;
the browser reconciles readiness and updates affected cards in place.

Verified with Python 3.12: `./tests/run-all.sh --unit` ran 356 tests
(five optional media tests skipped), with 91.4% `vdl.py` line coverage.
The 22 scheduler tests include unattended preparation of 1,500 videos into
3,000 assets with one active generator. All 83 relevant browser tests passed,
as did the real-ffmpeg thumbnail/montage smoke test, including thread limits.
