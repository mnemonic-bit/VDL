# Find duplicate media and uniquely name mounted imports

**Source:** User-requested feature

**Status:** Implemented

**Extends:** Feature 0033, Import mounted files once at startup

**Last refined:** 2026-10-13

## Decision summary

Find byte-identical files in VDL's finished media library using a SHA-256
digest of each file's final bytes, paired with its exact byte size. Show
duplicate groups for review. A duplicate is a relationship between two
library entries, not an import error: keep both entries and their independent
source paths, folder tags, titles, and ownership. Do not automatically merge
or delete either file.

Give every **new mounted-file import** its own internal library basename by
appending a short random UUID before the extension, even when its original
basename is unused. Keep the source basename as its user-facing filename. The
stored file path remains the authority for playback and removal; the
user-facing filename is the authority for labels, rename, and browser export.

This feature refines Feature 0033's final filename rule and defines the
duplicate finding referenced there. Feature 0033's one-time, recursive startup
snapshot and folder-to-tag behavior remain the import trigger and
classification rules. Duplicate indexing never scans the ingest mount for new
candidates.

## Terms and scope

- **Exact duplicate:** two distinct finished library rows with accessible
  regular files whose complete bytes match. Filename, source URL, folder tags,
  codec metadata, and video title do not determine duplicate identity.
- **Content hash:** lowercase hexadecimal SHA-256 digest of a completed file,
  plus the exact number of bytes hashed.
- **Internal filename:** the physical basename stored in `downloads.filename`.
- **Display filename:** the human-facing basename retained from the mounted
  source and later edited by Rename.
- **Source receipt:** Feature 0033's path-and-signature record that prevents an
  unchanged mounted source from being imported again after a restart. It is
  separate from duplicate detection.

Include all finished library media with an authorized, readable stored file
in duplicate comparisons: mounted imports, browser uploads, and URL downloads.
This does not change the naming scheme of browser uploads or URL downloads.
Active, interrupted, cancelled, failed, missing, and inaccessible files are
not assigned a confirmed duplicate group.

## Content hashing and index lifecycle

Use SHA-256 over the complete final file in bounded chunks. Hash the mounted
import's temporary library copy while streaming it from the read-only source;
only persist that digest after source checks, `ffprobe` validation, and final
publication succeed. For browser uploads and URL downloads, hash the final
stored artifact after all transfer, merge, and post-processing steps. Never
hash an unfinished `.part` file as though it were final media.

Store one hash record per finished download ID with algorithm, digest, exact
byte size, and enough file identity metadata to recognize a stale record
(device, inode, size, and nanosecond modification time). Index the digest and
size for group lookup. A mounted import's finished row, source receipt, folder
tags, and hash record commit atomically before its History insert event. For
other finish paths, a row may temporarily be marked **hash pending** until its
final file has been hashed. This is an indexing state, not a new download
status. A hash failure does not turn a valid finished download into an error;
show it as unindexed and allow retry.

On upgrade, enqueue existing finished rows without a current hash for a
single serial background backfill over their stored library paths. Bound I/O
memory and avoid multiple hashing workers for the same row. Resume unfinished
backfill work on a later startup. The backfill reads library files already
known from the database; it does not enumerate, watch, or import the mounted
inbox. Newly finished rows join this index without waiting for another
application startup.

Before presenting a stored match, confirm that each row still refers to an
allowed regular file with the recorded identity metadata. If the file is
missing, changed, or disallowed, remove it from confirmed groups and mark its
hash missing or stale. A stale accessible file can be rehashed once on demand
or by the normal hash worker. Provide an explicit **Refresh duplicate index**
action to rehash finished library files when operators know files were edited
outside VDL. This action only reads existing library rows and cannot trigger
another ingest-mount scan.

Group rows by matching byte size and SHA-256 digest. Before labeling a group
**confirmed**, compare the bytes of each candidate with a group representative
in bounded chunks while rechecking file identity; this rules out a digest
collision or an intervening file change. Cache that confirmation only while
the member files' recorded identities remain the same. Equal filenames with
different bytes are not duplicates. Equal bytes under different filenames or
source paths are duplicates. A file's own History row cannot duplicate itself.

Deleting a library row removes its hash record and updates visible groups.
Renaming only its display filename leaves the digest and group membership
unchanged. Any operation that changes media bytes must invalidate and refresh
the hash. Do not use a duplicate match to delete or overwrite a file during
import.

## Unique internal names for mounted imports

For each newly imported mounted source, choose an internal basename of the
form `<safe-stem>--<uuid12><extension>`, where `uuid12` is 12 lowercase
hexadecimal characters from a newly generated UUIDv4. For example,
`my_video.mp4` may be stored as `my_video--a1b2c3d4e5f6.mp4`. Preserve the
source extension for MIME selection and playback. Truncate the safe stem on a
character boundary as needed to stay within the filesystem's basename byte
limit, while retaining the complete validated source basename as the display
filename.

Generate a new UUID for every import attempt, including files with distinct
source names or identical content. Reserve the destination with exclusive
creation; if the candidate path already exists, generate another UUID and
retry. Randomness alone is not the collision guard. Never overwrite a
pre-existing library file. The UUID is a storage detail and does not become a
tag, title, duplicate identity, or user-visible filename.

Record the imported source basename in a dedicated display-filename field.
The `filename` field continues to hold the absolute, unique physical path;
`requested_filename` retains its existing source-name meaning. For new
mounted imports, Rename changes the display filename while preserving the
original file extension and leaving the physical path and UUID unchanged.
History cards, detail views, filename search, and attachment responses use the
display filename. Playback, previews, file removal, and path authorization
continue to use the stored physical path. Existing library rows without a
display filename fall back to their current stored basename and retain their
current rename behavior. No existing files are renamed during migration.

Two mounted sources named `my_video.mp4` in different subfolders therefore
produce two unique physical files and two History rows. Each row receives its
own folder tags from Feature 0033. If the bytes match, the duplicate finder
places the two rows in one group; the UUID suffix neither creates nor hides a
duplicate.

## Finding and reviewing duplicates

Add a **Duplicates** view in History that lists confirmed groups with at least
two entries visible to the signed-in user. Show each member's
display filename, existing thumbnail and metadata, source type, tags, size,
and a link to its normal History item. Show the group size and item count.
When indexing is incomplete, show a clear pending/unavailable count so an
empty result is not mistaken for a complete clean library.

Apply existing ownership and visibility checks before grouping results for a
request. A private item must not leak its existence through group counts,
hashes, filenames, or another user's UI/API response. Keep the digest and
absolute filesystem paths out of ordinary browser responses. Users may act on
individual entries through the existing playback, rename, and Delete controls;
there is no bulk or automatic duplicate deletion in this feature.

## Persistence and compatibility

Add the display-filename column through `init_db()`'s migration list. Create
an idempotent hash-record table keyed by download ID with a digest-and-size
index. Do not add columns to the initial `downloads` `CREATE TABLE` statement.
Use the existing stored-path allowlist before hashing, comparing, or serving
files. Keep receipt lookup by source path and signature: an unchanged receipt
still skips reimport even if its content matches another library file. A new
source path with identical bytes still receives its own row, physical file,
tags, receipt, and duplicate-group membership.

## Acceptance criteria

- Two mounted files with identical bytes but different paths import as two
  independently tagged History rows and appear in one confirmed duplicate
  group after hashing completes.
- Two files with the same basename and different bytes are not grouped.
  Different basenames with identical bytes are grouped.
- Existing finished URL downloads and browser uploads can participate after
  their hashes are indexed; legacy rows are backfilled without rescanning the
  ingest mount.
- A mounted import gets a UUID-suffixed internal basename even when no other
  file uses its original name. A forced UUID candidate collision retries
  without overwriting either file.
- The original basename appears in History and as the browser download name;
  Rename changes that displayed/exported name without removing the internal
  UUID or changing duplicate membership.
- A missing, changed, or disallowed file does not appear as a confirmed
  duplicate. Hashing failure leaves its finished media row intact and reports
  indexing as incomplete.
- A private row cannot affect another user's visible duplicate groups or
  counts. Deleting one duplicate leaves other files and rows untouched.
- The duplicate finder does not cause a second ingest-mount enumeration,
  periodic watcher, or automatic removal of duplicate media.

## Verification

Cover streaming SHA-256 of final bytes, interrupted and failed hash cleanup,
atomic mounted-import registration, legacy backfill, exact and nonmatching
content, confirmation after hash matches, stale/missing file handling,
visibility filtering, row deletion, and unchanged receipt behavior. Cover
internal-name generation with an occupied UUID candidate, long basenames,
extension preservation, rename, browser attachment naming, and stored-path
playback/removal. A container test should import two identical videos from
different tagged subfolders, verify two UUID-suffixed physical files and one
duplicate group, then restart and verify neither source is imported again.

When implemented, run the repository unit suite with its enforced 90%
`vdl.py` line-coverage gate and the relevant container smoke test.

## Non-goals

- Perceptual or visual-similarity matching; differently encoded videos are
  distinct unless their complete bytes match.
- Skipping an import, merging tags, hard-linking files, or sharing storage
  because the content hash matches another entry.
- Automatic or bulk deletion of duplicates.
- Renaming existing physical library files solely to add UUIDs.
- Watching or rescanning the ingest mount to update duplicate groups.
