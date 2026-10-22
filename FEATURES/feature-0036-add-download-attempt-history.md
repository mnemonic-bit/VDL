# Add a separate download attempt History

**Source:** User-requested feature  
**Status:** Implemented\
**Last refined:** 2026-10-22\
**Supersedes:** The use of **History** for the primary video grid in Features
0017, 0018, 0022, 0025, 0027, 0030, 0034, and 0035

## Decision summary

Call the application's default content view the **Library**. It shows the
videos and playlists the user can use, not a record of download failures.
Only finished media with an available, authorized stored file belongs in its
video grid. Failed, cancelled, interrupted, paused, and in-progress work does
not appear there. The existing **Current downloads** drawer remains the place
to manage live and resumable work. The main Library has no view tabs; videos
remain front-and-center alongside the existing playlist shelf. Move
**Duplicates** into a second tab on the History page.

Add a separate **History** page, opened from the signed-in user's menu. It
replaces the Library content area within the same application shell and shows
every accepted media acquisition attempt in one newest-first, single-column
list. Its rows include active, finished, failed, cancelled, and interrupted
attempts. A row shows a thumbnail only when that attempt produced a finished
video whose stored media is still available; other rows show a neutral
placeholder. History has its own filter input and does not alter the Library
search, sort, pagination, or playback selection.

Here and in earlier specs, references to the old main-view “History” grid or
“History selection” mean **Library** or **Library selection** after this
feature. The word **History** in the interface is reserved for the new attempt
list. The existing `history_page_size` setting may retain its storage key for
compatibility, but its visible label should describe Library pagination.

## User flow

1. On opening VDL, the user sees the Library's video grid and playlists
   without a tabbed view switch. Its search and Play All/Shuffle controls work
   as before, now with Library names and accessible descriptions.
2. The user opens the account menu and chooses **History**. The Library area
   is replaced by a page headed **History**, a **Back to Library** control, a
   dedicated filter input, and a vertically stacked list of attempt rows.
   The History page has **Download attempts** and **Duplicates** tabs.
3. The user can find a failed attempt, read its error and source information,
   and start a new retry or resume when that action is valid. A successful
   attempt links to its Library video while the media remains available.
4. Going back restores the Library's search, ordering, page, and view. Opening
   History again restores its own filter and page for the current visit.

## What counts as an attempt

- Create a History record when the server accepts a URL download, browser
  upload, Firefox companion download, or mounted-file import for processing.
  Include failures during probing, transfer, validation, and publication after
  acceptance. A rejected form value or unauthorized request that never became
  work is not a download attempt.
- One record represents one execution of work, with its own start time, end
  time, source kind, outcome, and concise error when applicable. Multiple
  submissions of the same URL appear as separate rows. An idempotent repeat
  of one already accepted request does not create another row.
- Pause and unpause change the state of the same attempt. Resuming a cancelled
  or interrupted download starts a new attempt linked to the same download
  item, preserving the earlier outcome. Explicit Reload/Retry also creates a
  new attempt. The Library still has at most one item per finished stored
  video, rather than one card per retry.
- Use the existing status vocabulary: `starting`, `downloading`, `paused`,
  `finished`, `error`, `cancelled`, and `interrupted`. Record the last relevant
  progress and error text for each attempt; do not rewrite an earlier terminal
  attempt when a later retry succeeds.
- On crash recovery, mark any attempt left in an active state `interrupted`
  along with its download work. A subsequent resume gets a new attempt row.
- Mounted-import attempts made without a signed-in owner are visible only to
  administrators. For signed-in users, History shows their own attempts; a
  public Library video created by another user does not reveal that user's
  source URL or failure details in personal History.

## History page and row design

Use a true list: one attempt per full-width row in a single column at every
viewport width. Do not reuse the Library's multi-column preview cards. Each
row has a compact thumbnail or placeholder on the left and a text block on
the right. On narrow screens, the text may wrap beneath the image within the
same row; rows never become side-by-side cards.

Each row presents:

1. **Title line:** the known video title, otherwise the requested filename or
   a short source label, otherwise “Untitled attempt”; a clearly named status
   badge sits with this line.
2. **Source line:** URL host and source type (URL, companion, upload, or mounted
   import), with the full authorized source available in details where safe.
3. **Timing line:** started time, and completed time or elapsed time when
   known. Active rows show current progress, speed, and ETA when available.
4. **Result line:** final filename, size, and quality for a finished item; a
   concise failure reason for `error`; or a clear stopped/interrupted reason
   for those states. Long diagnostics live behind an expandable **Details**
   control and wrap without widening the page.
5. **Actions:** only actions valid for that attempt and linked work, such as
   **View in Library**, **Retry**, **Resume**, or **Copy source URL**. A past
   attempt must not offer Resume when a newer attempt already owns the worker.

For a finished attempt, request the existing thumbnail endpoint only while
its linked video still has an authorized, safe, existing final file. If the
thumbnail cannot be generated, show a placeholder without changing the
attempt's `finished` outcome. Never request or display a thumbnail for an
active, failed, cancelled, or interrupted attempt, even if a partial file or
remote poster exists. If finished media is later deleted or missing, keep the
attempt row and its outcome, show **Media removed** or **File unavailable**,
remove the thumbnail and playback link, and keep the metadata snapshot.

History uses the existing theme tokens, accessible focus states, and shared
icon symbols. Status and error meaning must be readable as text, not color or
thumbnail presence alone. The list has a distinct empty state for no attempts
and for a filter with no matches.

## Search, ordering, and live updates

- Put a labelled, expandable History filter in the header or History page
  toolbar, using the same input/clear/Escape interaction as Library search.
  Give it a separate value and accessible name, **Filter download history**.
- Match case-insensitively against title, requested/display filename, source
  host or URL, source type, and the stored error summary. Keep the Library's
  quote-aware term parsing; all free-text terms must match for a row to remain.
  Support `status:<status>` using the canonical status names above. An empty
  filter shows all permitted attempts.
- Filter before pagination. Order by attempt start time descending, breaking
  ties by stable attempt ID. Use a bounded page size and provide next/previous
  navigation with a result count, so a long-lived installation does not load
  its entire log into one DOM update.
- Refresh visible attempt state through the existing SSE reconciliation
  channel. Do not poll. Preserve the filter, page, focus, and any open Details
  row while updates arrive; if deletion empties the current page, move to the
  preceding valid page.
- Library search and History filtering are independent. History terms must
  not restrict Library cards, playlists, Play All, or Shuffle. History has no
  Play All/Shuffle button of its own.

## Data, API, and migration contract

Store attempts separately from the current `downloads` row, which represents
the latest state and stored media. Give each attempt a stable opaque ID, owner
ID or system-import marker, optional linked download ID, source type, safe
display title/filename, source reference, start/end timestamps, status,
progress snapshot, and error summary/details. Retain enough snapshot data to
render an attempt after its linked Library media is deleted. Do not retain
browser cookies, authorization headers, or temporary upload contents in this
log. Apply the existing source-URL privacy rules and escape all rendered text.

Replace the old, mixed-purpose `GET /api/history` response with three explicit
authenticated reads:

| Endpoint | Response |
| --- | --- |
| `GET /api/library` | The existing video-entry shape, limited to authorized finished media with an available safe file; supplies the Library grid and its playback selection. |
| `GET /api/current-downloads` | The existing download-entry shape for `starting`, `downloading`, `paused`, `cancelled`, and `interrupted` work; supplies the Current downloads drawer and progress indicators. |
| `GET /api/history?filter=...&page=...&page_size=...` | A paginated `{items, total, page, page_size}` result of authorized attempt records across all statuses; supplies the new History list. |

`/api/history` now means actual attempt History and must never return the old
array of Library, failed, and current download rows. Its authorization is
enforced before filtering. Attempt items contain only display-safe fields and
an optional currently playable Library ID, never a raw filesystem path. The
Library and Current responses retain their existing entry fields where they
apply, so playback, drawer actions, and live progress can migrate without
inventing a second record format. Update every in-repository caller, browser
test, API test, and container smoke check that used the old `/api/history`
array; do not leave a compatibility alias with ambiguous meaning. Document
the new route contracts for external clients.

An attempt state change publishes the normal SSE change signal after the
database transaction commits. Create/update the attempt and corresponding
download state atomically where practical, so a successful publication cannot
appear in the Library without a matching finished History outcome.

Migration creates one best-effort legacy attempt for each existing `downloads`
row, using its recorded creation/end times and current status. Mark such rows
as imported legacy records; earlier retries cannot be reconstructed and must
not be invented. Preserve existing media, download IDs, ownership, tags,
playlists, favorites, view counts, and playback paths. New tables use
idempotent creation; any new `downloads` columns follow the additive migration
rule in `AGENTS.md`.

Removing a Library item or file does not erase its History attempts. Removing
an account removes that account's private attempt records. Redefine the
administrator **Clear History** action to preview and delete terminal attempt
records only, without deleting Library videos or files. Active attempts remain
visible until they finish or stop. Preserve the old bulk media
deletion capability under an explicitly different label and confirmation that
states it will delete files and Library items. A clear operation must not
silently turn into media deletion because the two views are now distinct.

## Implementation touchpoints

- `templates/index.html`: add the account-menu History entry and History page;
  rename the old grid's visible and accessible labels to Library; keep the
  Current downloads drawer and Settings available from either page.
- `static/app.js`: separate Library and attempt-list state, filtering,
  pagination, rendering, navigation, and SSE reconciliation; update Play All
  labels and launch coordinates to refer to the Library.
- `static/styles.css`: full-width History rows, responsive wrapping, status
  and focus treatments using the existing theme variables.
- `vdl.py`: attempt persistence and migration, authenticated paginated read,
  distinct Library/Current/History APIs, lifecycle recording, safe
  thumbnail/link eligibility, and separate clear actions.

## Acceptance criteria

1. The default main view is called **Library** and contains finished,
   available videos and existing playlists, never failed or incomplete work.
   It has no view tabs; **Duplicates** is a tab on the separate History page.
2. **History** is reachable from the account menu and replaces the Library
   area without opening a modal or changing the application's header/footer.
3. Every accepted attempt appears once in a single-column list with title,
   status, source, timing, and useful result or error information.
4. A failed attempt remains in History but has no Library card or thumbnail.
   A finished available video appears in both places and has a thumbnail in
   History when thumbnail generation succeeds.
5. Resume and Retry create new attempt rows; earlier terminal outcomes remain
   visible. A pause/unpause cycle remains in one attempt.
6. Browser uploads and mounted imports, including failures after acceptance,
   are represented with their correct source type and privacy boundary.
7. History filtering, pagination, keyboard access, focus restoration, and SSE
   updates work independently of Library search and playback.
8. A removed or missing media file leaves a truthful finished attempt record
   without a playable link or thumbnail.
9. Existing databases migrate without losing media or inventing prior retries.
   Clear History removes attempts only; bulk media deletion requires its own
   explicit action and confirmation.
10. `/api/library` serves Library videos, `/api/current-downloads` serves the
    drawer, and `/api/history` serves paginated attempts. No client expects the
    old mixed `/api/history` array after migration.

Before marking implementation complete, run `./tests/run-all.sh --unit` and
verify at least 90% `vdl.py` line coverage, then run the relevant browser tests
for navigation, filtering, responsive rows, and live status transitions.
Reusing `/api/history` for a different response is technically incompatible
for clients of the old contract. The maintainer explicitly chose a feature
bump because this API is internal and not officially published. This release
therefore bumps `VERSION` from `0.44.0` to `0.45.0`, overriding the general
major-bump rule in `AGENTS.md` for this change.


## Implementation outcome

Implemented in `0.45.0`, including the user's refinement moving Duplicates to
History and removing the main Library's tab switch. Attempt persistence lives
in `download_history.py`; lifecycle callers pass the same SQLite transaction
that accepts or changes work. Terminal snapshots are immutable, and only an
explicit new acceptance can recreate a log removed by clearing or account
deletion. A final worker-stopped SSE signal makes Retry available after file
handles close.

Migration backfills one marked legacy record per existing download exactly
once, even after History is cleared. Foreign keys retain snapshots after media
deletions and remove an account's private log when the account is deleted.
Mounted work records acceptance before output setup and records validation,
copy, or publication failures without publishing incomplete Library items.

History uses server-side authorization, conjunctive quote-aware filtering,
1-based bounded pagination, stable row identities, and Details/focus
restoration during SSE updates. Source snapshots remove embedded credentials
and redact query values except known routing identifiers; diagnostic URLs
redact all query values. The read and clear route contracts are documented in
`README.md`; browser/API tests and container smoke checks use the explicit
Library, Current downloads, and paginated History endpoints.

Validation: Python 3.12 `./tests/run-all.sh --unit` passes 282 tests (5 optional
media tests skipped), with `vdl.py` line coverage **91.2%** (4754/5210; enforced
minimum 90%). Shipping-container build and smoke checks pass. All 211 browser
checks pass across the full run and targeted reruns. Browser coverage includes
navigation, independent filtering/pagination, responsive rows,
thumbnail eligibility, deletion/clear semantics, keyboard access, and live
completion with Details and focus preserved.
