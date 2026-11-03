# Upgrade preview caches gradually and add persistent system logs

**Source:** User-requested feature\
**Status:** Implemented in 0.51.0\
**Last refined:** 2026-11-03\
**Extends:** [Feature 0044, Shared asset generation](feature-0044-queue-thumbnail-and-hover-preview-generation.md)
and [Feature 0036, Download attempt History](feature-0036-add-download-attempt-history.md)\
**Follows:** [Bug 0075, Duration-based preview sampling](../BUGS/bug-0075-hover-preview-sampling-count-does-not-scale-with-duration.md)

## Decision summary

Keep a video's usable old hover-preview sequence until its replacement has
been successfully generated and published. An intentional hover requests an
urgent upgrade while the old sequence remains playable. Independently, a slow
background pass upgrades one cached sequence after another, even with no
browser connected. Both paths use the existing single shared asset worker.

Record maintenance progress durably and show it in a new **Logs** tab on the
existing **History** page, alongside **Download attempts** and **Duplicates**.
Logs and unfinished maintenance survive application restarts and container
replacement when the existing persistent data volume is retained.

An untouched preview remains on disk until either hover-driven generation or
the gradual background pass successfully replaces it. Background maintenance
can therefore upgrade a video before anybody hovers it; retention is until a
successful replacement, not indefinitely until the first hover.

## Current behavior and the gap

Source reviewed at version `0.50.10`:

- [`_preview_path()`](../vdl.py) selects only the current version's sidecar.
  Bug 0075 changed that identity from version 4 to version 5.
- [`AssetQueue.register()`](../asset_generation.py) removes obsolete-version
  queue records and queues missing current-version files. Startup
  reconciliation does this without waiting for hover. The worker has bounded
  retries and one active generator, but no deliberate upgrade cooldown.
- [`_stream_cached_asset_locked()`](../vdl.py) serves only a ready current
  asset. An old file left on disk is not a playable fallback while its
  replacement is queued or running. Successful publication does not provide
  a general cleanup pass for those obsolete-version files.
- The History page in [`templates/index.html`](../templates/index.html)
  currently has Download attempts and Duplicates views. It has no persistent
  system-maintenance log.

This feature changes the cache-upgrade policy and adds the maintenance log.
It preserves Bug 0075's sampling formula, edge exclusions, output format,
silent playback, and browser compatibility. Static-thumbnail cache upgrades
and initial generation of assets that have never existed retain their
existing policy unless needed for shared-worker fairness.

## Serving an old sequence during an upgrade

1. Resolve a usable current sequence first. Otherwise select the newest
   compatible legacy sequence belonging to the same video and unchanged
   source file. Preserve the source identity and provenance needed to make
   that decision before retiring old queue metadata.
2. Opening Library, paging, scrolling, reading readiness, or requesting a
   static thumbnail does not urgently upgrade a usable legacy montage. These
   actions may discover and durably register background upgrade work.
3. After the existing intentional-hover delay, play the selected legacy
   sequence immediately if available, and promote its pending upgrade.
   Generation runs outside the HTTP request; hover never waits for ffmpeg.
   Repeated hovers, tabs, and users deduplicate onto the same target task.
4. Keep the selected sequence throughout that hover session. Publishing its
   replacement must not restart, seek, blank, or interrupt an active preview.
   The next hover selects the new sequence. If no usable sequence existed,
   retain the static thumbnail and start the newly ready montage only while
   the pointer is still intentionally over the card.
5. Generate into a unique temporary file. Validate the completed output and
   recheck task ownership, target version, source identity, eligibility, and
   path confinement. Publish the new file atomically and commit the serving
   selection and durable progress before retiring the old file.
6. Delete obsolete sequence files for that video only after the new sequence
   is durably available. Preserve files needed by active readers until their
   playback finishes. Use a bounded reader lease or equivalent mechanism that
   also covers subsequent byte-range requests, with recovery for abandoned
   sessions. This is the safety exception to immediate post-publication
   deletion; old files are no longer selectable for new hovers.
7. Failure, timeout, missing tools, insufficient disk space, interruption, or
   invalid output leaves the previous valid sequence intact and selectable.
   Retry within the existing bounded policy; repeated hover does not reset
   attempts or bypass retry backoff. An exhausted upgrade failure is logged
   without turning a playable fallback into an unavailable preview.

Every file remains subject to current authorization and stored-path checks.
An old sequence for a changed source, deleted item, or newly inaccessible
video is not a fallback. Explicit media deletion removes owned current,
legacy, and temporary artifacts through the existing invalidation flow.
Renaming or replacing a source must not publish an upgrade against the wrong
file or recreate deleted sidecars.

## Readiness, asset identity, and crash recovery

Separate **playable now** from **generated with the current recipe**. Preserve
the existing per-kind generation states (`queued`, `running`, `ready`, and
`failed`), and add montage delivery metadata describing availability, whether
the selected sequence is current, and its server-issued asset URL/identity.
A pending or failed target can coexist with an available legacy sequence.
Do not add these states to the canonical download-status vocabulary.

- Pin a playback URL and conditional/range validators to the actual selected
  sequence. Never serve legacy bytes with the identity or validators of a
  newly generated sequence, or silently change files halfway through ranged
  playback. A client-supplied token cannot choose arbitrary files or bypass
  authorization. Unauthorized historical asset URLs stop working immediately.
- Readiness, Library responses, and asset-demand responses consistently
  distinguish fallback availability from target progress. Delivery of a
  usable fallback returns normal cached MP4/range responses, not `202`.
  With no usable sequence, retain the existing nonblocking pending/unavailable
  behavior and static-thumbnail fallback.
- Persist generation ownership, target identity, publication recovery state,
  fallback selection, and cleanup work. Filesystem publication and SQLite
  cannot form one atomic transaction: startup reconciliation must repair a
  crash between them without losing both sequences, counting a completion
  twice, or serving a temporary/partial file.
- A crash after publication but before old-file deletion leaves durable
  cleanup work. Retry cleanup in bounded batches, including after restart,
  only when the current replacement still exists and is valid. A failed
  unlink must not force another encode. Report cleanup failure separately
  from successful generation and never delete source media.
- Legacy sidecars whose original source-identity records still exist can be
  adopted during migration. Earlier releases may already have discarded
  those records. If ownership and association with the unchanged source
  cannot be established, do not infer safety from the filename alone: retain
  the file pending safe cleanup, use the static thumbnail, and generate a
  current sequence through the same queue. This limits the seamless fallback
  guarantee for installations already missing that evidence.

## Gradual background maintenance

Discover obsolete caches in bounded startup batches while serving requests.
Discovery must not decode every video, load the full Library into memory, or
hold a database write lock while examining files. Track a durable upgrade
campaign for the target preview recipe/version; revisiting a batch or
restarting the process must not duplicate its work.

Use a **30-second initial grace period**, then allow **one automatic upgrade
attempt at a time with at least 30 seconds between completion of an upgrade
attempt and dispatch of the next automatic upgrade attempt**. This includes
failed attempts and retries. Persist the next eligible automatic-upgrade time
so restarting cannot turn maintenance into a burst. The cooldown delays
automatic upgrades only; the shared worker remains free to do other work.
No user-facing pacing setting is required in this first version.

| Work | Scheduling behavior |
| --- | --- |
| Visible missing thumbnails | Keep their existing foreground priority. |
| Intentionally hovered missing or outdated montage | Promote through the existing hover tier; bypass the automatic-upgrade cooldown, while respecting retry backoff. |
| Other visible montages with no usable sequence | Keep their existing visible-page priority. |
| Newly published media with missing assets | Retain ordinary initial-generation behavior. |
| Outdated montage with a usable fallback | Remain background work, even when its card is visible; become eligible after the maintenance cooldown. |

Preserve the shared queue's fairness: after eight foreground tasks, allow the
oldest eligible ordinary background task, including a due upgrade, to run.
Initial-generation work and upgrade work retain durable enqueue ordering
within that background choice. A cooldown or retry delay makes a task
temporarily ineligible; it cannot block unrelated work. Continuous new
foreground demand must not permanently starve due upgrades.

Hover promotion affects the next dispatch. Do not start a second generator
or kill an unrelated running encode. Once an upgrade attempt finishes,
advance the next automatic-upgrade time, even if hover promoted that attempt.
Leaving the card removes temporary hover priority, not the durable upgrade.

At most one thumbnail or montage generation task is active across all users
and both upgrade paths. Retain bounded decoder/encoder/filter threading and
subprocess timeouts. Pacing does not by itself limit an individual encode's
memory: Bug 0075 measured about 1.35 GiB for its synthetic two-hour fixture.
Implementation validation must cover long sources and working-set behavior;
it must not reduce the required sample count or allow overlapping generators
to make the backlog appear faster.

## Durable campaign progress and restart messages

Persist each campaign, its target recipe/version, original start time,
discovery progress, counters, pacing deadline, and member-task outcomes in
the existing SQLite database. One unique member represents one video/source
identity upgrade to that target; hover and background completion update the
same member exactly once. New videos without legacy caches are ordinary asset
tasks, not additions to the cache-upgrade count.

Use these counter meanings after discovery finishes:

| Counter | Meaning |
| --- | --- |
| Updated | New target sequence successfully published and committed. Old-reader cleanup may still be pending. |
| Left | Queued, running, or waiting-for-retry upgrades, including a task interrupted by shutdown. |
| Failed | Upgrades whose retry budget is exhausted; a valid old sequence may still be playable. |
| Skipped | Members no longer eligible, removed, or superseded by a changed source. |
| Total | Updated + Left + Failed + Skipped. |

While discovery is incomplete, show the discovered counts and **Scanning
Library; total not yet known**. Never present a partial count as the final
backlog or finish a campaign because one discovery batch was empty of work.
After discovery, account explicitly for membership changes; changed sources
enter the normal asset-publication flow rather than inheriting old credit.

Generate timestamped messages using these forms:

- **Started updating cached preview sequences: 0 updated, 1,500 left.**
- **Updating cached preview sequences: 37 updated, 1,463 left.**
- **Pausing cached preview updates for shutdown: 37 updated, 1,463 left.**
- **Resuming cached preview updates: 37 updated, 1,463 left.**
- **Finished updating cached preview sequences: 1,500 updated, 0 left.**
- **Cached preview update pass finished with warnings: 1,497 updated,
  0 left, 2 failed, 1 skipped.**

Numbers are examples. Include failed/skipped counts whenever nonzero and
qualify messages during discovery. Remaining retry-delayed work prevents a
Finished event. A normal cooldown or foreground interruption is not a
shutdown pause and must not generate repeated Pausing/Resuming messages.

Persist counters after every outcome. Coalesce routine progress log entries
to at most one every 30 seconds when progress changed; lifecycle, final, and
actionable failure events are recorded immediately. A campaign with no work
does not emit a fresh Started/Finished pair on every application restart.

On graceful container shutdown, stop admitting new work and commit a pause
checkpoint before exit. Account for any active encode truthfully: if it
cannot finish within the shutdown grace, keep that member unfinished for
recovery. Never delete its old cache or count it updated on process exit.
On restart, reclaim interrupted work without resetting retry budgets, remove
abandoned temporary files safely, and resume the same campaign/counters.

After SIGKILL, OOM, or power loss, a shutdown message cannot be guaranteed.
On next startup record **Previous preview update run was interrupted;
resuming with N left**, based on the last committed checkpoint. Do not
fabricate a graceful pause timestamp. A future recipe version supersedes an
unfinished older campaign explicitly; it must not mark the old run successful
or reuse completion credit for the new target.

## Logs in History

Add a **Logs** tab to the History page's existing tab bar. It opens a
**System logs** section showing maintenance status above a newest-first list
of timestamped messages. Use the same application shell, themes, keyboard tab
navigation, focus treatments, and narrow-screen wrapping as the other History
views. Keep log filtering and pagination independent of download attempts,
Duplicates, and Library state.

- Show each entry's time, severity, component (initially **Preview cache**),
  and readable message. Store UTC timestamps and render them in the user's
  local timezone. Status and warnings must not depend on color alone.
- Provide a labelled text filter, a severity filter, and bounded pagination
  with a default of 50 entries and a maximum of 100 per request. Filtering
  happens before pagination; break timestamp ties with a stable event ID.
  Show distinct empty, loading, and load-failure states.
- Make this installation-wide view **administrator-only**. Hide the Logs tab
  for other roles, enforce the same permission in every log/status endpoint,
  and filter maintenance SSE hints accordingly. Global counts can describe
  private media, so hiding filenames alone is insufficient authorization.
- Persist structured events with stable IDs, UTC time, severity, event type,
  component, campaign ID, display-safe message data, and counter snapshots.
  Keep target/version and lifecycle state in structured fields so rendering
  does not depend on parsing English messages.
- Keep messages aggregate by default. Sanitize any failure details before
  storage; do not retain cookies, headers, credentials, raw private URLs,
  absolute paths, or unfiltered ffmpeg output. Escape rendered text.
- Store logs in the database under `DOWNLOADS_DB`, which the container mounts
  at `/data/downloads.db` in the existing persistent data volume. Do not rely
  on Docker/Podman stdout retention, browser storage, `/tmp`, or the container
  writable layer. Retain history across ordinary restarts and image upgrades
  using that volume; deleting the volume or database is outside this guarantee.
- The first version does not automatically expire log events or add a clear
  button. Bounded reads and coalesced progress control normal growth. Existing
  **Clear History** continues to clear terminal download-attempt records only;
  clearing attempts or deleting Library media does not erase system logs.

Provide separate read-only, authenticated, administrator-only APIs for
paginated system logs and current preview-maintenance status. Keep the
existing `/api/history` attempt contract unchanged. API naming can follow
repository conventions; contracts must expose stable pagination and explicit
discovery, paused/interrupted, completed, and completed-with-warnings states.

Publish coalesced SSE hints only after committed changes. Reconcile the
visible Logs panel and its status on a hint, reconnect, focus, or opening the
tab; do not poll. Handle dropped events through bounded reads using stable
event IDs. Preserve older-page position, filters, selection, and focus rather
than forcing a jump to the newest page. Existing asset-readiness hints still
update Library cards without rebuilding healthy cards or restarting previews.

## Implementation boundaries

- `asset_generation.py`: retain legacy serving metadata, deduplicate and
  pace upgrades, persist campaign state, recover publication/cleanup, and
  emit durable lifecycle outcomes through one shared scheduling interface.
- `vdl.py`: additive schema migration, source-safe legacy adoption, delivery
  of pinned fallback/current assets, shutdown integration, administrator log
  and status reads, and authorized SSE notifications. Preserve per-call DB
  connections and avoid DB writes while waiting for cooldowns or readers.
- `templates/index.html`, `static/app.js`, and `static/styles.css`: History
  Logs view, bounded state/read reconciliation, availability-aware hover
  delivery, and session-safe asset handoff. Keep the vanilla frontend.
- Container packaging: keep state in the existing persistent volume and
  include any newly introduced runtime module in the Dockerfile's source
  allowlist. Do not add a second service, broker, or parallel preview worker.

## Acceptance criteria and verification

1. Upgrade a database and cache tree containing version-4 previews and known
   source identities. Before any generation completes, old sequences still
   play and remain on disk. Merely browsing cards does not promote upgrades.
   Cover installations whose legacy identity records were already removed;
   only verified fallbacks may be served.
2. Hover a legacy preview with the generator deliberately blocked. Playback
   starts through the old asset, one upgrade is promoted, and leaving/rehover,
   multiple tabs, and multiple users cannot duplicate generation. Full-video
   playback and view counts remain unchanged by cache work and hover.
3. Publish the new asset during an active hover. That hover and follow-up
   range reads continue on the old sequence; the next hover uses the new
   sequence. Retire the old disk file once readers release it, including
   recovery of abandoned leases. Validate validators and browser-cache reuse.
4. With no browsers connected, upgrade a large legacy library one sequence
   at a time. Use a controllable clock to prove startup grace, the 30-second
   cooldown, persisted deadlines, hover bypass, retry backoff, and fairness.
   Missing thumbnails and new videos must still progress during cooldowns.
5. Observe process/thread counts and memory while both upgrade paths, imports,
   and missing-asset requests compete. There is one active generator total.
   Real-media checks cover representative long videos, the existing timeout,
   required sampling counts, silent browser-compatible MP4s, and peak memory.
6. Inject failures before encode completion, during validation/publication,
   between file publication and DB commit, and before/during old-file cleanup.
   Include full disk and missing tools. Keep the last valid fallback, recover
   progress exactly once, clean only owned artifacts, and preserve retry limits.
7. Test deletion, rename, source replacement, and visibility changes during
   generation and playback. Never leak inaccessible media or resurrect deleted
   files. Reconcile skipped/changed-source members and campaign totals.
8. Gracefully stop and replace the container with the data volume retained,
   then test abrupt termination separately. Logs, counters, pacing deadlines,
   and unfinished work survive; resume the same campaign with truthful pause
   or interruption messages. Verify restart after publication does not encode
   again merely because old-file cleanup was unfinished.
9. Logs show correct Started, progress, Pausing, Resuming, Finished, and
   completed-with-warnings outcomes. Hover upgrades count toward the same
   campaign. Delayed retries, incomplete discovery, and failed/skipped members
   cannot produce a false success. Repeated restarts do not duplicate credit.
10. Browser/API tests cover History tab placement, administrator permissions,
    filters, pagination, empty/error states, keyboard access, both themes,
    small screens, dropped SSE hints, reconnect, and stable older-page focus.
    Nonadministrators cannot retrieve aggregate maintenance data or hints.
11. Clear History leaves system logs and maintenance state intact. Deleting a
    Library item does not remove historical aggregate events. Verify durable
    log sanitization and that container stdout is not the persistence mechanism.

Use deterministic fake clocks, blocking generators, publication fault
injection, and isolated database/cache fixtures, plus real-media and native
Chromium/Firefox hover/range checks. Before completing implementation, run
`./tests/run-all.sh --unit` and verify at least **90% `vdl.py` line coverage**,
using Python 3.12 when close to the threshold, and run the relevant browser,
media, and container-restart checks.

Implementation uses the feature MINOR version bump to `0.51.0` under
`AGENTS.md`. Regression coverage includes deterministic queue and API tests,
native Chromium/Firefox hover and range checks, long-source media checks, and
retained-volume container replacement checks.
