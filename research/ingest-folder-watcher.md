# Safe ingest-folder watching in a Linux container

## Decision

Use a **flat, bind-mounted inbox scanned periodically with `os.scandir()`** as the reliable mechanism. A 10-second scan interval is a reasonable default; make it configurable. Mounting the inbox read-only and retaining a persistent source receipt lets VDL copy files without renaming or deleting host data. Operators should remove originals after successful ingestion to keep the inbox small. This is portable across ordinary Linux bind mounts and host-mounted network filesystems, has no new Python dependency, and its idle work is proportional to the number of directory entries rather than to movie sizes.

Filesystem notifications may be added later as a latency optimization: an event should merely request an immediate scan. They must not be the only discovery mechanism. Always scan at application startup and periodically thereafter.

Do **not** ingest a file merely because it was created, modified, closed, or renamed. Prefer a producer-side completion protocol; retain a conservative stability check for ordinary drag-and-drop/copy workflows.

## Why an appearance event is not enough

Linux inotify distinguishes creation, modification, writable-close, and move events. `IN_CLOSE_WRITE` means that *a file descriptor opened for writing was closed*; `IN_MOVED_TO` means that a name was renamed into the watched directory. Neither promises that another process will not reopen or continue work on that path later. Inotify also identifies an event by filename, and the file may already have been deleted or renamed by the time the consumer handles it. See [`inotify(7)` event definitions and caveats](https://man7.org/linux/man-pages/man7/inotify.7.html).

There is no general, reliable “is this file still being copied?” query. Linux file locks are advisory by default and therefore only help when the copy program cooperates; see [`fcntl_locking(2)`](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html). Looking for open writers is also unsuitable in a container: it is racy, host writers are normally hidden by the container's PID namespace, and a writer can reopen the path after the check. Docker documents that containers use a separate PID namespace unless explicitly run with `--pid=host`; see [Docker's PID settings](https://docs.docker.com/reference/cli/docker/container/run/#pid-settings---pid).

### Strong completion contract (preferred)

For automated producers, document this protocol:

1. Copy to a name the importer ignores, such as `.movie.mp4.part`, **inside the ingest filesystem**.
2. Close the completed file (and, when durability across host crashes matters, `fsync` it).
3. Rename it to the final supported filename in the same ingest directory.

`rename()` changes the visible name atomically on the same mounted filesystem; it fails with `EXDEV` across mount points. Open file descriptors remain valid across the rename, so the contract still depends on the producer renaming only after it has finished writing. See [`rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html). If crash durability is part of the contract, `fsync()` of the file alone does not guarantee that its directory entry reached storage; the directory must also be synced. See [`fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html).

An explicit sidecar marker (for example, `movie.mp4.ready`) is an equally strong option when the producer cannot rename. It is less friendly for manual copying, so it should be optional rather than the only workflow.

### Uncoordinated manual copies (best-effort fallback)

For files copied directly under their final names:

- Ignore dotfiles, known temporary suffixes (`.part`, `.tmp`, `.crdownload`), directories, and symlinks.
- Record a fresh `stat` signature: device, inode, size, and nanosecond modification time.
- Require the signature to remain unchanged across at least three scans spanning a configurable quiet period (recommend 60 seconds by default).
- Re-stat immediately before claiming the file. If anything changed or the file disappeared, restart the quiet period.
- Validate the claimed file with `ffprobe` before publishing it to the library. Validation is useful corruption screening, but it is not by itself proof that no writer will append later.
- While copying into the library, compare the source signature before and after the copy. If it changed, discard the unpublished destination temporary file and retry after it becomes quiet again.

The quiet-period rule is necessarily heuristic: a stalled transfer can remain unchanged for longer than the threshold. The UI/documentation should say that `.part`-then-rename (or a ready marker) is the guaranteed workflow; direct copying trades certainty for convenience.

## Claiming and publishing safely

One possible design is to move a ready candidate to an importer-owned `.processing/` directory on the **same ingest mount** using a collision-free generated name. This atomically claims the path against duplicate workers and removes it from the inbox scan. It also requires a read-write bind mount; Docker bind mounts are writable by default and container writes are reflected on the host. See [Docker's bind-mount documentation](https://docs.docker.com/engine/storage/bind-mounts/).

VDL instead uses a read-only inbox. It copies one candidate at a time and stores its device, inode, size, modification time, source path, and resulting library ID in SQLite. That receipt prevents re-import after restart while the unchanged original remains present. This is safer for user-owned host files and avoids crash recovery for a renamed source, at the cost of leaving inbox cleanup to the operator and retaining a small race that only the producer-side temporary-name protocol can close.

The ingest mount and the media-library mount may be different filesystems, so do not assume that the source can be renamed directly into the library. `rename()` cannot cross mounted filesystems. Instead:

1. Copy the claimed source to a unique hidden temporary file located **inside the final library directory**.
2. Flush and close it, then re-check the source signature.
3. Run `ffprobe` and derive authoritative metadata.
4. Rename the library temporary file to its collision-safe final name; temp and final are now on the same filesystem, so publication is atomic.
5. Insert/update the SQLite library row transactionally.
6. Store the source receipt in the same DB transaction as the finished library row; leave the read-only source unchanged.

Remove stale unpublished library temporary files on startup. Avoid hashing an entire movie merely for routine discovery: hashing adds size-proportional reads and CPU; if duplicate-content detection is desired later, calculate a digest while performing the one necessary library copy.

## Bind mounts and filesystem-event behavior

Docker bind mounts directly expose a path from the Docker daemon host inside the container. They are therefore appropriate for a host drop folder, but the source path must exist on the daemon host and its permissions must allow the container user to traverse/read it (and write it if VDL claims/removes files). Docker also warns that bind mounts are tied to the host path and that writable mounts allow the container to alter host files. See [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

On a Linux server with a local host filesystem, inotify on the mounted directory is a useful accelerator. One non-recursive directory watch uses one watch descriptor and waits on a readable file descriptor, so it does not continuously scan files. Kernel limits bound queued events, instances, and watches. However:

- Inotify does not catch remote changes on network filesystems; its manual explicitly requires polling as the fallback.
- Its event queue can overflow and lose events; robust applications must rebuild state by scanning.
- Directory watches are not recursive. Recursive trees require additional watches and introduce races while new subdirectories are being watched.
- Mounting another filesystem over an already watched directory does not generate a usable replacement watch automatically.

These limitations are documented in [`inotify(7)`](https://man7.org/linux/man-pages/man7/inotify.7.html). For VDL, a flat inbox plus periodic reconciliation avoids all four problems.

If `watchdog` is used, its default Linux observer uses inotify, while its maintainers specifically require `PollingObserver` for CIFS. Its polling observer compares directory snapshots and defaults to a one-second interval. See the [watchdog platform/CIFS guidance](https://github.com/gorakhargosh/watchdog#supported-platforms) and [`PollingObserver` API](https://python-watchdog.readthedocs.io/en/latest/api/observers_polling.html). Because VDL only needs a flat inbox and already needs custom stability state, a small application-owned scan loop is simpler and permits a much calmer interval.

## Resource impact

A flat scan with `os.scandir()` enumerates names and obtains file attributes without reading file contents. Python documents that `scandir()` can significantly reduce system calls versus `listdir()` plus attribute queries because directory entries expose metadata supplied by the operating system. Do not retain `DirEntry` objects between scans; Python notes that their metadata may be cached, so take fresh `stat` values for stability decisions. See [Python `os.scandir()` documentation](https://docs.python.org/3/library/os.html#os.scandir).

At a 10-second interval the importer performs six directory enumerations per minute. Its cost is O(number of inbox entries), not O(total movie bytes). Keeping the inbox non-recursive and draining completed entries bounds this work naturally. On a network share, metadata calls may still be comparatively expensive, so expose a 10–60 second interval and log scan duration/errors; increase the interval if scans overlap or the share is slow. Use an interruptible event wait rather than `sleep()` so shutdown is prompt, and ensure only one scanner thread is started even when Flask debug reloading is enabled.

Native events can reduce discovery latency without changing correctness: debounce bursts into one scan, and retain the periodic scan for startup discovery, queue overflow, network filesystems, watcher failure, and files placed while the process was down.

## Recommended VDL behavior

- Configuration: disabled unless an ingest path is configured; default container target such as `/ingest`; configurable scan interval and quiet period.
- Container: add an explicit read-only bind mount from a dedicated host directory, never a broad host path. Do not mount over an image directory containing application data because Docker says pre-existing container contents are obscured.
- Scope: regular files only, flat directory, supported video extensions, no symlink following.
- Discovery: startup scan plus `os.scandir()` every 10 seconds. Optional inotify/watchdog events only wake the scanner early.
- Readiness: guaranteed `.part`-then-rename/ready-marker protocol; otherwise three unchanged observations over 60 seconds, re-stat around claim/copy, then `ffprobe`.
- Publication: temporary destination inside the library filesystem, atomic final rename, then a transactional finished row and persistent source receipt. The source is not altered.
- Resilience: one bad file must not stop the scanner; do not retry an unchanged invalid candidate on every pass. Remove stale unpublished ingest temporaries on startup.
- Observability: log watcher startup, successful imports, scan failures, and per-file failures without logging every idle scan.

This design does not promise the impossible for arbitrary direct copies: only producer cooperation can prove completion. It does prevent eager ingestion in ordinary workflows, gives a documented race-free workflow when certainty matters, works when inotify cannot, and keeps idle server work small and predictable.
