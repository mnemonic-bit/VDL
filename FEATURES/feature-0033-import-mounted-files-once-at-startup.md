# Import mounted files once at startup

**Source:** User-requested refinement

**Status:** Implemented

**Refines:** Feature 0024, Ingest videos from a watched folder

**Last refined:** 2026-10-13

## Decision summary

Replace the periodic watched-folder behavior of Feature 0024 with a one-time
startup import. When the ingest mount is configured, VDL enumerates its eligible
files into a fixed snapshot at application startup, then walks that snapshot
once. Each snapshot entry gets at most one import attempt in that process.
There is no filesystem watcher, timer, settle loop, later reconciliation scan,
or manual/API rescan in this feature. Files added, renamed, or repaired after
enumeration wait until the next application startup.

Keep the existing read-only inbox, copy-and-validate publication path, finished
local-upload presentation, and persistent ingest receipts. Discover videos in
subfolders and attach one tag for each directory between the mount root and
the video. This spec supersedes Feature 0024 wherever it calls for repeated
scans, a settle period, or retry during the same run. Feature 0024 describes
the currently implemented behavior until this refinement is built.
Feature 0034 separately specifies duplicate finding and UUID-suffixed
internal filenames for new mounted imports.

## Mount and activation contract

- Use `VDL_INGEST_DIR` as the path of the mounted inbox. An unset or empty value
  disables startup import for native execution.
- In the container, Compose pairs the dedicated read-only host bind at
  `/ingest` with `VDL_INGEST_DIR=/ingest`; keep the existing
  `VDL_INGEST_HOST_DIR` host-path override. A standalone image with no explicit
  ingest configuration does not activate import merely because `/ingest`
  exists. Remove the image's default `VDL_INGEST_DIR` setting and its
  declaration of an automatic `/ingest` volume. An explicit bind and ingest
  path activate the channel; there is no separate UI toggle.
- Require a configured path to exist and be a readable, searchable directory
  for the VDL process. Report a clear startup error for a missing or
  inaccessible configured mount rather than treating it as an empty inbox.
- Require the resolved inbox and current library output directory to be
  disjoint directory trees. Neither may contain the other; otherwise the
  recursive scan could discover library files as sources. Recheck before each
  copy because the output preference can change while the startup batch is
  running.
- Remove `VDL_INGEST_SCAN_SECONDS` and `VDL_INGEST_SETTLE_SECONDS` from the
  documented and deployed configuration. Neither variable controls the new
  import channel.
- Leave host source files in place and never require write access to the
  mounted inbox.

## Startup snapshot

Only the serving process runs the startup import. With the Werkzeug debug
reloader, its parent must not enumerate or import. Start no more than one
startup-import worker per serving process. The HTTP server may start while the
batch is processed, but the worker must complete its directory enumeration
before attempting the first copy.

Walk the full directory tree below the ingest mount once, visiting each
discovered directory at most once. Build a fixed list of eligible source paths,
their paths relative to the mount root, and their source signatures. A source
signature contains device, inode, byte size, and nanosecond modification time.
Complete and close the recursive enumeration before processing the list;
processing a file must not rediscover entries or extend the list. Sort by
relative path so logs and failures are reproducible. An empty tree ends the
startup task after this one walk.

Include only regular files without following symlinks at any path component.
Do not traverse symlinked directories. Ignore dotfiles and dot-directories, and
ignore files with names ending case-insensitively in `.part`, `.partial`,
`.tmp`, `.crdownload`, or `.download`. Do not decide video eligibility from the
filename extension; validate content with `ffprobe` during import.

If the root or any traversed subdirectory cannot be enumerated, report the
scan failure and end this startup batch. Do not process a partial snapshot,
prune receipts, or schedule another scan. A new process startup is the retry
mechanism. A file or subdirectory created or renamed into place after
enumeration is outside the snapshot, even if it appears before batch
processing ends.

## Folder tags

For every successfully imported video, split its path relative to the mount
root into directory components and use each component as a tag. The mount
root and video filename are never tags. For example, with
`VDL_INGEST_DIR=/import-data`, importing
`/import-data/some/subfolder/my_video.mp4` attaches the two tags `some` and
`subfolder`. A file directly under `/import-data` gets no automatic tags.

Use the existing tag validation and identity rules from Feature 0001: trim
outer whitespace, collapse repeated whitespace, reject empty names, commas,
control characters, and names longer than 64 characters; reuse tags
case-insensitively while retaining the first-created display spelling. If two
ancestor directory names resolve to the same tag identity, attach that tag
only once. If any directory component is not a valid tag, fail that file's
import with a clear path-specific log entry; do not silently omit a folder tag
or create an untagged History item. Other snapshot entries continue.

Attach the complete tag set in the same database transaction as the finished
library row and ingest receipt. Publish the History insert event only after
that transaction commits, so the first visible item already has its folder
tags. Receipt-matched sources create no new row and do not reapply tags to an
existing item; users may edit that item's tags normally afterward. Two files
in different folders may share a basename: destination collision handling
keeps their library files distinct, while each receives tags from its own
relative source path.

## Processing the fixed list

Process snapshot entries serially, each at most once. Before copying an entry,
verify that every directory component remains inside the configured mount
without following symlinks, and compare the file's current no-follow signature
with the captured signature. Skip it for this run if it disappeared, changed,
escaped the mount, or became a symlink or non-regular file. Also compare the
open file descriptor's signature, copied byte count, and source path signatures
before and after validation. If any comparison changes, remove unpublished
artifacts and skip that entry for this run. Do not wait for stability or retry
it during this process.

For a stable entry without a matching receipt, reuse the existing secure
ingest lifecycle: validate the basename and folder tags, stream a copy into a
hidden temporary file in the current library directory, require a video stream
from bounded `ffprobe`, reserve a collision-safe final basename, atomically
publish the copy, insert the finished library row, receipt, and tags together,
and send the normal SSE insert event. Preserve existing metadata defaults,
ownership, visibility, and `source_type=upload` presentation. Do not create a
Current row or expose server-copy progress.

A bad video, missing `ffprobe`, database failure, or per-file filesystem error
must leave the source untouched, clean unpublished artifacts, log the file's
failure, and allow later snapshot entries to proceed. There is no automatic
per-file retry during the run. Keep startup cleanup of stale app-owned
`.ingest.part` files without deleting unrelated library files.

## Producer handoff

The supported producer workflow is to finish writing a temporary or hidden
name in the same mounted filesystem and target subdirectory, close it, and
rename it to its eligible final name **before VDL starts its snapshot**. A
file whose rename occurs after enumeration waits until the next startup.
Writing directly under a final name while VDL starts is best effort: signature
checks detect observed changes, but cannot prove that a stalled writer will
never resume. No settle time or repeated observation is part of this feature.

## Receipts and restarts

Retain the existing persistent source-path-and-signature receipts. An exact
receipt match skips copying, probing, and History registration after restart.
A changed signature may create a new library item on a later startup. Deleting
a History row alone does not clear its receipt.

After a **successful complete enumeration**, prune receipts for eligible
source paths no longer present anywhere under the mount. Receipt lookup and
pruning must cover the mount root and all descendants, while leaving receipts
outside that root untouched. Never prune receipts after a failed or
incomplete enumeration. Pruning happens once per startup, without a later
check for files removed while the process runs. Removing a source and
restoring an indistinguishable file at the same path before the next snapshot
cannot be detected by the receipt signature; operators can change the file or
its name to request a new import.

Restarting VDL creates a new snapshot and is the only automatic chance to
discover new files, retry skipped or failed files, or observe removed sources.
Do not restart the scan task after it finishes, even if the inbox changes or
the server remains running for days.

## Operator experience

Log the resolved inbox and startup-scan beginning and completion, with counts
for enumerated, imported, receipt-skipped, changed/missing, and failed files.
Log one concise failure per affected file. Do not emit idle messages. Imported
items appear in History through the existing SSE mechanism.

Update the README and container configuration to explain the read-only mount,
recursive startup snapshot, folder-to-tag mapping, invalid folder-name
handling, temporary-name/rename producer handoff, receipt behavior across
restarts, and that new or changed files require a restart to be considered.
Do not advertise scan or settle intervals.

## Acceptance criteria

- With no configured ingest path in native execution, VDL performs no startup
  import. With a configured readable mount, the serving process enumerates it
  once and processes only that captured list.
- An empty mount completes without a recurring thread, timer, watcher, or
  periodic directory access.
- A file added or renamed into place after enumeration is not imported during
  that run. A captured file changed before its attempt is skipped; a change
  after its attempt does not trigger another attempt.
- Every captured entry receives no more than one import attempt. A changed,
  removed, invalid, or failed entry waits until another startup; later entries
  still proceed.
- Eligible videos directly under the mount and in nested subdirectories are
  included. Hidden files, hidden subtrees, temporary suffixes, and symlinks
  are excluded.
- `/import-data/some/subfolder/my_video.mp4` under a `/import-data` ingest
  mount appears in History with exactly the tags `some` and `subfolder`; a
  video at the mount root receives no automatic tags.
- Existing case-insensitive tag identity is reused and duplicate ancestor
  names attach only one tag. An invalid folder tag fails that file's import
  without publishing an incomplete History item.
- Failure to enumerate any subdirectory aborts the whole startup snapshot and
  preserves all existing receipts.
- A stable valid video is copied, validated, registered once as a finished
  local upload, and available through the existing History and playback paths.
- The host source remains unchanged on success and failure; no temporary or
  unregistered library artifact remains after a failed attempt.
- Restarting against the same inbox and SQLite database creates no duplicate
  History item for an unchanged successful source.
- A complete startup enumeration prunes receipts for removed eligible paths;
  a failed enumeration prunes none.
- A missing or inaccessible configured mount fails clearly. Debug reloading
  does not run the import in both parent and serving child.
- The deployed configuration contains no active scan interval, settle
  interval, filesystem watcher, or manual rescan mechanism.

## Verification

Cover fixed-snapshot membership and one-attempt behavior with a nested file
or subdirectory created while an earlier entry is being processed. Cover
root-level and nested folder tags, duplicate case-insensitive tag identities,
invalid tag components, tag persistence and initial SSE visibility, symlinked
directory rejection, source path escape, receipt skip and pruning across
restarts, failed-subdirectory-enumeration preservation, source mutation,
invalid-video cleanup, per-file failure isolation, mount validation, and the
debug-reloader ownership rule. A container smoke test should mount a nested
video, observe its imported folder tags, add another while VDL remains running,
confirm it is not imported, restart VDL, and confirm exactly one new History
item appears with its folder tags.

When implemented, run the repository's required unit and coverage gate and
relevant container smoke test. The 90% `vdl.py` line-coverage minimum applies
to the code change.

## Non-goals

- Importing files through symlinked directories or paths outside the mount.
- Continuous monitoring, polling, timed rescans, filesystem events, or an
  operator-triggered rescan without restarting VDL.
- Waiting for in-progress direct copies to settle or retrying a snapshot entry
  within the same run.
- Moving, renaming, deleting, or archiving host source files.
- Transcoding or an ingest-management UI. Content hashing and duplicate
  finding are specified in Feature 0034.
