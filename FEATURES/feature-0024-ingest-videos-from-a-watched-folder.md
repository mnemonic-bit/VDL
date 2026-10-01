# Ingest videos from a watched folder

**Source:** User-requested feature  
**Status:** Implemented  
**Last refined:** 2026-10-01  
**Extends:** Feature 0021, Import and export local videos

## Decision summary

Provide a flat ingest inbox that operators can bind-mount into the container
and populate from the host. VDL periodically scans that directory, waits for a
candidate to remain unchanged, copies it into the configured media library,
validates the copy with `ffprobe`, and registers it as a finished local upload.

Mount the inbox read-only inside the container. Successful ingestion preserves
the host source and records a persistent SQLite receipt so the same unchanged
file is not imported again after an application restart. Operators remove
sources from the host inbox after the corresponding History entry appears.

Use a periodic `os.scandir()` reconciliation loop rather than making inotify or
another filesystem-event API authoritative. A startup scan and later periodic
scans work for local bind mounts, tolerate missed events, and continue to work
for network filesystems whose remote changes may not produce inotify events.
The inbox is deliberately flat so scan cost stays proportional to its number of
top-level entries.

An ordinary file appearing under its final name is not proof that its writer
has finished. Support direct copies through a conservative stability heuristic,
but define copy-to-temporary-then-rename as the strict completion protocol.
The supporting primary-source analysis is recorded in
[`research/ingest-folder-watcher.md`](../research/ingest-folder-watcher.md).

## Terms

- The **ingest inbox** is the configured host folder exposed to VDL through
  `VDL_INGEST_DIR`.
- A **candidate** is an eligible regular file whose current filesystem
  signature has not already been recorded as successfully ingested.
- A **source signature** is the tuple of device, inode, byte size, and
  nanosecond modification time read without following a final symlink.
- The **settle period** is the minimum elapsed time during which a candidate's
  source signature must remain unchanged.
- An **ingest receipt** is the persistent mapping from an absolute source path
  and source signature to the generated library download ID.
- **Publication** is the atomic rename of a validated hidden temporary copy to
  its collision-safe final library path.

## Configuration and container contract

Support these environment variables:

| Variable | Native default | Container/Compose default | Contract |
| --- | --- | --- | --- |
| `VDL_INGEST_DIR` | Empty, watcher disabled | `/ingest` | Existing readable and searchable directory |
| `VDL_INGEST_SCAN_SECONDS` | `10` | `10` | Finite number greater than or equal to one |
| `VDL_INGEST_SETTLE_SECONDS` | `60` | `60` | Finite number greater than or equal to one |
| `VDL_INGEST_HOST_DIR` | Not applicable | `./ingest` | Compose-only host bind source |

Compose binds `${VDL_INGEST_HOST_DIR:-./ingest}` to `/ingest` with the
read-only mount option. Ship an empty tracked `ingest/` directory so the
default Compose deployment has a concrete host path. The image declares
`/ingest` alongside `/data` and `/downloads`, creates it for UID/GID 10001, and
sets `VDL_INGEST_DIR=/ingest`.

The entrypoint requires a configured ingest path to be a readable, searchable
directory for UID/GID 10001. It does not require write access because VDL must
not rename or delete host inbox files. Startup fails clearly for a configured
missing or inaccessible directory.

Require the resolved ingest directory and current download directory to be
different. Using one directory for both would make finished library files look
like new inbox candidates and create an ingestion loop. Recheck this invariant
when processing a candidate because the download-directory preference can
change after application startup.

## Producer completion protocol

### Strict handoff

Automated producers and operators who require a race-free handoff use this
sequence:

1. Copy the movie to an ignored dotfile or temporary suffix inside the ingest
   filesystem, for example `.movie.mkv.part`.
2. Close the file after every byte has been written.
3. Rename it to its final eligible basename in the same ingest directory.

The final rename is atomic only when both names are on the same mounted
filesystem. VDL still applies the normal stability and validation checks after
the rename; the producer's rule that rename happens only after close is what
makes completion authoritative.

### Direct-copy fallback

Manual copying under the final filename is supported as a convenience. It is a
best-effort workflow because a writer can stall for longer than any finite
settle period and later resume.

For a direct copy, VDL must:

- observe an identical source signature at least three times;
- require those observations to span the configured settle period;
- restart the settle period whenever any signature field changes;
- compare the signature again through the open file descriptor before and
  after the library copy;
- compare the source path immediately before validation and again after the
  bounded `ffprobe` call; and
- discard the unpublished copy and restart observation if any comparison no
  longer matches.

`ffprobe` validates that the completed copy contains a video stream. It is a
content check, not a substitute for the producer completion protocol.

## Discovery and eligibility

Scan only direct children of the configured inbox. Do not recurse into
subdirectories. On every pass, use fresh directory-entry metadata and consider
only regular files without following symlinks.

Ignore:

- any basename beginning with `.`;
- directories and other non-regular filesystem objects;
- symlinks; and
- basenames ending case-insensitively in `.part`, `.partial`, `.tmp`,
  `.crdownload`, or `.download`.

Do not require a video filename extension. Extensions and browser MIME labels
are not authoritative; successful `ffprobe` video-stream detection is.

Perform one scan immediately when the watcher thread starts, then wait the
configured scan interval between passes. A scan error logs a concise message
and leaves existing candidate state intact for a later pass. One malformed
candidate or database failure must not terminate the watcher thread.

## Ingestion and publication lifecycle

Process settled candidates serially in the single watcher thread. For each
candidate:

1. Reduce its name through the existing safe upload-basename validation.
2. Resolve and prepare the current configured download directory.
3. Open the source read-only with no-final-symlink following where supported.
4. Require the open descriptor's signature to equal the settled signature.
5. Stream the source in bounded chunks to a unique hidden
   `.vdl_<id>.*.ingest.part` file inside the library directory.
6. Require the copied byte count and the descriptor/path signatures to remain
   equal to the settled source.
7. Validate the temporary copy with the existing uploaded-video `ffprobe`
   inspection and capture its optional `<height>p` resolution.
8. Recheck the source after inspection.
9. Reserve a collision-safe final basename through exclusive file creation,
   then atomically replace that reservation with the validated temporary file.
10. Insert the finished library row and ingest receipt in one SQLite
    transaction.
11. Publish the normal SSE insert event and log the successful import.

Never expose the hidden temporary copy through playback or History. On any
error before database registration, remove the temporary and any unregistered
final file while leaving the read-only source untouched. On startup, remove
stale app-owned `.ingest.part` files from the current library directory before
starting the watcher.

If the original basename already exists in the library, preserve it and append
` (1)`, ` (2)`, and so on before the extension. Folder ingestion uses the same
serialization lock and collision rules as browser uploads.

## Library metadata

Register a watched-folder import directly as a finished library item. It does
not pass through Current and does not publish byte progress while the
server-side copy is running.

Persist these download fields:

| Field | Value |
| --- | --- |
| `id` | New eight-character generated ID |
| `url` | Empty string |
| `status` | `finished` |
| `progress` | `100%` |
| `created_at` / `finished_at` | Registration time |
| `filename` | Absolute collision-safe final library path |
| `resolution` | First video stream height as `<height>p`, or unset |
| `filesize` | Exact copied byte count |
| `downloaded_bytes` / `total_bytes` | Exact copied byte count |
| `speed` / `eta` | `0` |
| `title` | Original basename without its final extension |
| `output_dir` | Absolute library directory used for this import |
| `requested_filename` | Validated source basename |
| `source_type` | `upload` |
| `visibility` | Existing database default, `public` |
| owner fields | Unset because no signed-in user initiated the import |

Using `source_type == upload` gives watched imports the established Local
upload presentation and preserves playback, rename, tags, favorites, search,
download-file, thumbnail, preview, visibility, and removal behavior.

## Receipt and retry model

Create the `ingest_receipts` table idempotently during database
initialization. Each receipt stores:

- absolute source path as the primary key;
- device and inode;
- byte size and nanosecond modification time;
- resulting download ID; and
- ingestion time.

Before candidate tracking, compare each eligible file with the current receipt
for its path. An exact signature match is already ingested and requires no
copy, `ffprobe`, or database event. A changed signature starts a new settle
period and may be ingested as a new library item.

After a successful complete scan, delete receipts whose source paths are no
longer present as eligible regular files in that inbox. Removing an original
therefore makes a later file at that path eligible again, even if it happens to
have the same metadata.

When a source changes during copying or validation, clear its in-memory
candidate state without logging it as a malformed movie; the next pass begins
a fresh settle period. For another per-file error, log it once and mark that
signature failed in memory. Retry only after its signature changes or the
application restarts so an unchanged invalid file cannot cause repeated full
copies and `ffprobe` work every scan.

Deleting the resulting History item does not itself clear an unchanged source
receipt. Operators who want to ingest that source again must remove it long
enough for a successful scan to prune the receipt, modify it, or replace it.

## Service lifecycle and resource bounds

Start at most one daemon watcher thread per application process. Werkzeug's
debug reloader has a parent and serving child; only the serving child owns the
watcher. Stop the thread through an interruptible event when the HTTP server
returns, with a bounded join.

The watcher performs one flat `scandir()` and a bounded number of receipt
queries per scan. Idle work is O(number of top-level inbox entries) and does
not read movie contents. At the default interval this is six directory
enumerations per minute. Movie bytes are read only once per actual import, and
imports are serialized so a burst cannot create concurrent disk and `ffprobe`
pressure.

Do not add watchdog or another dependency for this feature. A future native
event listener may request an earlier reconciliation scan, but startup and
periodic scans remain authoritative for network filesystems, missed events,
and event-queue overflow.

## Security and integrity requirements

- Keep the container ingest bind read-only and scoped to the dedicated inbox.
- Treat every source basename and filesystem entry as untrusted.
- Ignore symlinks during discovery and request no-final-symlink opening on
  platforms that provide it.
- Use the existing safe upload basename rules and collision-safe destination
  reservation.
- Copy into the configured library instead of authorizing playback directly
  from the inbox.
- Publish only after full copying, repeated source-signature checks, and
  successful video validation.
- Keep temporary files hidden and uniquely tied to the generated ID.
- Preserve the existing stored-path playback allowlist and all authenticated
  media-route checks.
- Leave host inbox contents unchanged on success and failure.
- Use parameterized SQL for receipt and download metadata.

## Logging and operator experience

Log:

- the resolved watched directory, scan interval, and settle period when the
  watcher starts;
- one line for each successful import with source basename and generated ID;
- a concise scan-level failure without stopping later scans; and
- one concise per-file failure for an unchanged bad candidate.

Do not log on idle scans. Do not add browser polling, a new Current state, or a
new frontend status vocabulary. The completed item appears through the normal
SSE insert event and History reconciliation after registration.

Document in the README:

- the default `./ingest` Compose path;
- the read-only container mount and preservation of originals;
- host-path override and timing variables;
- the strict temporary-name/rename workflow;
- the limitation of direct-copy stability detection;
- ignored entry types and suffixes; and
- the need to remove successful originals to keep scan work bounded.

## Acceptance criteria

- The default Compose deployment exposes `./ingest` at `/ingest` read-only and
  starts one watcher with a 10-second scan and 60-second settle period.
- Native execution leaves the watcher disabled unless `VDL_INGEST_DIR` is set.
- Missing, unreadable, non-directory, non-finite timing, sub-one-second timing,
  and identical ingest/library configurations fail clearly.
- Hidden files, temporary suffixes, directories, and symlinks are never
  imported.
- A direct-copy candidate is not opened for ingestion before three identical
  observations span the settle period.
- Any signature change before, during, or after copying/validation discards
  unpublished artifacts and starts a new settle cycle.
- A valid settled video is copied to the library, validated, registered once as
  a finished local upload, and available to every existing finished-media
  feature.
- The host source remains unchanged after success, validation failure,
  filesystem failure, or database failure.
- A non-video creates no library row or retained library artifact and is not
  recopied on every scan while unchanged.
- Missing `ffprobe` produces a clear logged failure and no accepted library
  item.
- Existing library basenames are preserved and the imported copy receives the
  next numeric collision suffix.
- An unchanged source is not imported again after application restart.
- Removing the source causes its receipt to be pruned; a later replacement can
  enter a new settle cycle.
- Restart removes stale app-owned ingest temporary files without touching
  ordinary media or browser-upload partials.
- A scan or per-file failure does not terminate the watcher or the Flask
  server.
- Debug reloading does not create watcher threads in both parent and child.
- Recreating the container against the same SQLite and media volumes preserves
  the receipt and produces no duplicate History item.
- An empty inbox scan reads directory metadata only and does not perform
  size-proportional work.

## Verification

Automated coverage must include:

- settle timing, minimum observation count, and signature-change reset;
- ignored dotfiles, temporary suffixes, directories, and symlinks;
- successful copy, `ffprobe` validation, metadata defaults, and receipt
  persistence;
- source mutation during validation and cleanup of unpublished artifacts;
- invalid-video cleanup and unchanged-failure suppression;
- receipt skip behavior across watcher reconstruction and receipt pruning after
  source removal;
- same-directory rejection, timing validation, missing/inaccessible directory
  errors, singleton thread startup, and clean shutdown;
- stale ingest-partial cleanup without unrelated-file removal;
- migration of an existing database to include `ingest_receipts`; and
- a shipping-container smoke test that creates a real video in a mounted
  ingest volume, waits for the finished History item, restarts the container,
  and proves the source was not duplicated.

Run the relevant repository gates with:

```bash
VDL_PYTHON=.venv/bin/python ./tests/run-all.sh --unit
./tests/container/smoke.sh --build
```

## Non-goals

- Recursive directory watching or importing directory trees.
- A browser file picker, inbox management UI, or live server-copy progress.
- Moving, renaming, archiving, or deleting host source files.
- Treating inotify, close-write events, file locks, open-file inspection, or
  `ffprobe` success as universal proof that an arbitrary writer is finished.
- Content hashing, cross-name duplicate detection, or media fingerprinting.
- Transcoding, remuxing, codec normalization, or quality changes.
- Subtitle, image, sidecar, or audio-only ingestion.
- Parallel folder imports or sharing the URL-download concurrency preference.
- Per-user inboxes, ownership inference, private-by-default imports, or an
  account-selection rule for unattended files.
- An HTTP endpoint for configuring, scanning, or inspecting the watcher.
- Replacing the existing browser drag-and-drop upload workflow.
