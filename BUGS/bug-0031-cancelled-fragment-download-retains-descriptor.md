## 31. [Resolved] Cancelled fragment downloads retain their partial descriptor after worker completion

**Severity:** Medium

**Status:** Resolved in version `0.7.1` on 2026-09-27.

A stopped fragmented download can remain open in the Flask process after its
worker has returned and Remove has deleted both its database row and partial
path. The unlinked inode continues consuming disk space until Python's cyclic
garbage collector runs or the container stops.

This is distinct from Bug 0030. That bug allowed removal while the worker was
still unwinding. Its fix correctly waits for the worker to return, but assumed
that returning releases every yt-dlp object through normal reference counting.
Fragmented downloads can violate that assumption.

### Observed sequence

The affected row had download ID `f79c6485`. The container access log recorded
the final Stop and Remove requests:

```text
2026-09-27T08:27:22Z POST /api/stop/f79c6485   200
2026-09-27T08:27:29Z POST /api/remove/f79c6485 200
```

After removal, `/downloads` contained no entries, `/api/history` returned an
empty list, and the `downloads` and `download_tags` tables contained no rows.
The Python process nevertheless retained the deleted partial as descriptor 7:

```text
/proc/2/fd/7 -> /downloads/i didn't want to like this...._f79c6485.mp4.part (deleted)
```

The descriptor still held yt-dlp's advisory write lock and approximately
87.4 MiB of allocated space:

```text
size=91666542
blocks=179040
block_size=512
links=0
pos=91666542
```

Restarting the container closed the descriptor and released the allocation,
confirming that the old Python process was its owner.

### Root cause

VDL cancels an active transfer by raising `DownloadCancelled` from its yt-dlp
progress hook. For fragmented media, yt-dlp's `FragmentFD` stores the locked
destination stream in a fragment context. That context also owns an inner HTTP
downloader whose progress-hook closure refers back to the context:

```text
fragment context
├─ dest_stream -> yt_dlp.utils.locked_file -> partial descriptor
└─ dl -> HttpQuietDownloader -> progress hook closure -> fragment context
```

When `DownloadCancelled` escapes before `FragmentFD._finish_frag_download()`,
the normal destination-stream close is skipped. The cycle becomes unreachable
after VDL's worker returns, but reference counting alone cannot finalize it.
VDL therefore removed the ID from `_live_worker_ids`, Remove unlinked the
partial, and the cycle retained the now-deleted inode until cyclic collection.

A minimized real-DASH reproduction disabled automatic garbage collection,
cancelled on the first fragment progress callback, and inspected the process
descriptors after yt-dlp returned. The `.part` descriptor remained open. A
forced `gc.collect()` closed it. The equivalent direct-HTTP cancellation did
not retain a descriptor.

### Expected

Worker completion must mean that resources owned by the download have been
released, including objects reachable only through third-party reference
cycles. Once Remove succeeds, no matching visible path or deleted descriptor
may continue consuming filesystem space.

### Resolution

`background_download()` now runs cyclic collection after `_background_download()`
returns but before it removes the ID from `_live_worker_ids`. This preserves the
worker-lifecycle invariant: Remove cannot proceed until unreachable yt-dlp
cycles have been finalized and their locked destination streams have closed.

The cancellation regression test now models the fragmented-downloader cycle
and disables automatic collection, so it fails unless worker completion
explicitly closes the descriptor. A real slow-DASH verification with automatic
collection disabled found no held descriptor after the worker returned, and
the following Remove request succeeded.
