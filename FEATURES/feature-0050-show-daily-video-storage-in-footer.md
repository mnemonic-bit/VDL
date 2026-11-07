# Show daily video storage in the footer

**Source:** User-requested feature\
**Status:** Implemented in 0.53.0\
**Last refined:** 2026-11-06\
**Extends:** [Feature 0017, Application uptime](feature-0017-show-application-uptime.md)\
**Interacts with:** [Feature 0023, Authentication and users](feature-0023-require-authentication-and-manage-users.md)

## Decision summary

Add the combined size of stored videos beside the existing footer item count:

`30 items · Videos 30.1 M · UI v… · API v… · Uptime …`

Here, size means the logical size in bytes of the video files, rather than
server RAM usage or filesystem allocated blocks. Measure the collection in
the background once every 24 hours, persist the result in SQLite, and reuse
it across requests, browsers, process restarts, and container replacements
that retain the database volume.

Keep the current live item count and its existing meaning. It includes
Current Downloads as well as Library items; the new size describes completed
videos in the daily snapshot. Label it **Videos** and provide accessible
supporting text explaining **Video storage, updated daily**, with the last
successful measurement time. Do not imply the count and size are one live
measurement.

## Which files count

- Include finished Library videos from URL downloads, uploads, watched-folder
  ingestion, and mounted-file imports. Include the full eligible collection,
  independent of search, favorites, pagination, playlists, Library rotation,
  or playback settings. Newly added videos waiting for rotation still count.
- Use the stored `filename` and existing trusted-path validation. Never
  reconstruct paths from the current download-directory preference or scan
  an entire directory tree for unrelated files.
- Restrict inclusion to supported video files using the existing video-type
  allowlist. The current `_playable_library_entry()` checks finished status,
  file existence, and path safety, but does not alone distinguish audio.
- Measure regular files with filesystem metadata (`stat().st_size`). Do not
  read video contents, hash files, decode media, or run ffprobe to count bytes.
  Ignore historical download estimates in `filesize` when measuring actual
  stored files.
- Count each underlying file once, including repeated entries, symlink aliases,
  and hard links to the same device/inode. Distinct physical copies count
  separately even when their bytes are identical. Playlist membership never
  duplicates storage. Resolve aliases only within existing path-safety rules.
- Exclude active, paused, cancelled, interrupted, and failed downloads,
  partial files, audio-only files, thumbnails, hover previews, subtitles,
  metadata sidecars, temporary files, the database, and unrelated disk usage.
- Files already missing at measurement time contribute nothing. A genuinely
  empty measured collection is a successful zero-byte result.

## Human-readable display

Use decimal units, with one space before the suffix and a decimal point.
Below 1,000 bytes, show whole bytes; otherwise show one decimal place.

| Bytes | Display |
| --- | --- |
| 0 | `0 B` |
| 999 | `999 B` |
| 1,000 | `1.0 k` |
| 28,400 | `28.4 k` |
| 30,100,000 | `30.1 M` |
| 1,000,000,000 | `1.0 G` |
| 1,000,000,000,000 | `1.0 T` |

Use powers of 1,000 with suffixes `B`, `k`, `M`, `G`, `T`, `P`, and `E`.
Round to the nearest tenth, with ties upward; if rounding produces `1000.0`,
promote to the next unit, so 999,950 bytes displays as `1.0 M`. Retain the
trailing decimal zero for scaled values. Keep raw byte totals as integers in
storage and API responses; never sum already formatted or rounded values.

## Daily measurement and persistence

Define **once a day** as once per 86,400 elapsed seconds from the last
successful publication, rather than at local midnight. Persist UTC
`measured_at` and `next_refresh_at` timestamps. Browser clocks, timezone
changes, and daylight-saving transitions must not control refreshes.

- With no saved snapshot, schedule the first measurement at server startup
  while allowing the application to serve requests. Show **Videos
  calculating…** until a usable snapshot is available.
- With a saved snapshot less than 24 hours old, immediately reuse it and its
  original deadline. Reloading, restarting, changing settings, completing or
  deleting a download, and opening additional tabs do not trigger a scan.
- At expiry, schedule one background measurement even with no browser open.
  After downtime spanning several days, perform one overdue measurement on
  startup rather than replaying missed days.
- Keep the last committed snapshot available during refresh. A failed refresh
  retains its value and original measurement time, and marks it as stale.
  Without a previous success, display **Videos unavailable**, not `0 B`.
- Retry a failed refresh after 30 minutes, deduplicated across requests and
  timer wake-ups. Failures do not advance the successful-measurement deadline.
  Successful publications remain at least 24 hours apart; retries do not
  become extra daily successes.
- A file disappearing during the scan can be skipped. Permission errors,
  unavailable storage, and database failures must not publish a misleading
  partial total or replace a valid snapshot with zero. If a configured source
  mount is unavailable, retain the previous snapshot as stale.
- Use one refresh owner in the serving process, including debug-reloader
  startup. Concurrent startup, timer, and request triggers share the same
  work. Reclaim interrupted ownership after restart and publish the completed
  snapshot atomically; readers see either the old or new committed generation.
- Process candidates in bounded batches without holding a database write lock
  during filesystem access. Recheck entry identity before publication so a
  rename or replacement cannot attach an old measurement to a different file.
  This is a daily observation of a changing collection, not an atomic
  filesystem snapshot.

Persist raw sizes and the associations needed for authorization alongside the
snapshot metadata in the existing database under `DOWNLOADS_DB`. A singleton
installation total alone is insufficient because users can have different
visibility. Use additive schema migration; do not rely on browser storage,
in-memory state, `/tmp`, or the container writable layer for durability.

## Visibility and delivery

Each user sees the total for the snapshot's videos they are currently allowed
to view. Administrators see the installation-wide total. Apply current
authorization before deduplicating files and summing their cached sizes;
never expose hidden IDs, paths, individual sizes, or global totals to another
user. Do not publish storage data on the public health endpoint.

File measurements and snapshot membership change only on the daily refresh.
There is one necessary exception to keeping the displayed number fixed:
permission changes, account switches, and removal of a Library record must
immediately exclude inaccessible snapshot members. Visibility gains can expose
an already measured member. These changes reuse saved sizes without rescanning
files or resetting the daily deadline. Newly added entries join on the next
measurement. External file changes are discovered at the next measurement.

Add an authenticated read-only `/api/library-storage` endpoint returning
`total_bytes`, `measured_at`, `next_refresh_at`, and `state`. Use states
`calculating`, `ready`, `stale`, and `unavailable`; unknown totals and times
are null, and a measured empty collection has `total_bytes: 0`. While a due
refresh runs, an existing expired snapshot is `stale`. These are storage
states, not new download statuses. Responses use `Cache-Control: no-store`.

Serve only persisted measurements; the endpoint must not stat media or wait
for a scan. Retrieve on initial authenticated load and reconcile on existing
SSE, reconnect, and focus paths. Publish a coalesced SSE hint after a snapshot
commit, without embedding a global byte total. Recompute authorized aggregates
from saved measurements on reads. Do not add browser polling or media scanning
to `/api/health`; preserve its inexpensive version and uptime behavior.

Keep the last known measurement on a temporary request failure and identify
it as stale; clear account-specific data on sign-out/account switch. Invalid
or missing API data must not render `NaN`, negative sizes, or a false zero.
Preserve footer wrapping, centering, both themes, version-mismatch controls,
and keyboard access. Make last-updated and stale information available to
keyboard and touch users as well as screen readers, without relying solely
on hover tooltips or repeatedly announcing unchanged values.

## Implementation boundaries and acceptance criteria

Use `vdl.py` for migration, scheduled measurement, durable publication,
authorized aggregate reads, and SSE integration. Update the existing footer
in `templates/index.html`, with formatting and reconciliation in
`static/app.js` and theme-aware styling in `static/styles.css` as needed.
No new service, frontend framework, dependency, or user setting is required.

Implementation must verify:

1. Known video fixtures produce the exact sum and documented labels, including
   zero, unit boundaries, rounding promotion, large files, aliases, hard links,
   distinct duplicate copies, audio exclusion, and excluded sidecars.
2. All import/download sources count, independent of search, playlists,
   pagination, and rotation. Use stored paths after directory preferences change.
3. A fake clock proves first measurement, reuse before expiry, refresh exactly
   when due, unattended refresh, delayed retry, restart persistence, and one
   overdue run after downtime. Parallel requests cannot duplicate scans.
4. Completing, renaming, or deleting videos does not trigger measurement.
   Added files and external size changes appear on the next daily refresh;
   removed records and lost permissions immediately cease contributing.
5. Two users with private and shared videos receive correct distinct totals;
   administrators receive the global total. Account switches, visibility
   changes, responses, and SSE hints never disclose hidden storage.
6. Scan interruption, missing mounts, permission errors, disappearing files,
   and failed database publication preserve the last valid snapshot and
   truthful timestamps. Requests stay responsive during a large-library scan.
7. Browser checks cover loading, ready, stale, unavailable, recovery, malformed
   data, both themes, narrow layouts, and accessible last-updated information.
   Health checks and normal item-count/version/uptime behavior remain intact.

Implemented in `0.53.0` with one feature MINOR version bump and PATCH reset.
Validation requires `./tests/run-all.sh --unit` with at least **90% `vdl.py`
line coverage**, using Python 3.12 when close to the threshold, plus relevant
browser checks.

## Implementation verification

The daily timer publishes sizes, authorized associations, source identities,
and UTC deadlines atomically in SQLite. Reads apply current permissions before
deduplicating cached device/inode pairs. Source-directory identity changes
retain the last successful snapshot, including when an unavailable mount
exposes an accessible empty directory. Intentionally replacing storage at the
same path requires restoring the original source or configuring a new path.

`./tests/run-all.sh --unit` passed on Python 3.12: 525 tests, 9 skipped, and
92.7% `vdl.py` line coverage. The 31 storage tests cover persistence, exact
deadlines, unattended scheduling, retries, authorization, aliases, bounded
scans, concurrent reads, interruption, and publication/storage failures.
All 26 Node tests and 44 relevant browser checks passed, including the storage,
version/uptime, footer actions, and live-update suites. Footer checks exercise
both themes at narrow widths, keyboard access, account changes, malformed
responses, stale recovery, and SSE/focus reconciliation without polling.
