## 30. [Resolved] Removing a stopped download retains an unlinked partial file

**Severity:** Medium

**Status:** Resolved in version `0.7.0` on 2026-09-27.

Removing a stopped download can report success and leave `/downloads` empty
while the worker process still holds the deleted `.part` file open. The file
has no directory entry, but its inode and data blocks remain allocated until
the last descriptor closes. This makes the UI and ordinary filesystem listings
look fully cleaned up even though the download still consumes disk space.

This is distinct from Bug 0006. That bug covered partial files which remained
visible because cleanup could not identify them. Here cleanup found and
unlinked the partial, but it ran before the worker had released the file.

### Observed sequence

The affected row had download ID `c7674f90`. The container access log recorded:

```text
2026-09-27T09:53:21+02:00 POST /api/stop/c7674f90   200
2026-09-27T09:53:25+02:00 POST /api/remove/c7674f90 200
```

After removal:

- `find /downloads -xdev -mindepth 1` returned no entries.
- `du -a /downloads` reported only the empty directory.
- The `downloads` table contained zero rows.
- The Flask process still had two threads and held file descriptor 6:

```text
/proc/2/fd/6 -> /downloads/i didn't want to like this...._c7674f90.mp4.part (deleted)
```

The descriptor's inode had a link count of zero but still occupied space:

```text
size=581882122
blocks_bytes=581890048
links=0
pos=581882122
```

That is approximately 555 MiB retained after the Remove action. Three samples
over ten seconds showed the same descriptor, size, and allocated block count.
The data also remained accessible indirectly through the process descriptor,
despite no longer being reachable by a normal path under `/downloads`.

### Reproduction

1. Start a download large enough to leave a measurable `.part` file.
2. Select **Stop** while it is actively downloading.
3. As soon as the row becomes removable, select **Remove**.
4. Confirm that the row disappears and `/downloads` has no matching entry.
5. Inspect the app process's descriptors for paths ending in `(deleted)` and
   compare the descriptor's `st_size`, `st_blocks`, and `st_nlink` values.

### Actual

Remove returns HTTP 200, deletes the database row, and unlinks the partial
before the worker has closed it. The filesystem therefore retains the inode
and approximately 555 MiB of data blocks in the observed case. Restarting the
container closes the descriptor and releases the space, but this should not be
required after an ordinary Stop and Remove workflow.

### Expected

Remove must not report successful cleanup until the worker has stopped using
all files owned by the download. Once Remove succeeds, no matching directory
entries or open descriptors should remain, and the partial's allocated disk
space should be released without restarting the app or container.

### Investigation notes

- `db_remove_download_if_inactive()` treats a row as removable once its status
  is no longer `starting`, `downloading`, or `paused`. A terminal database
  status does not currently prove that the worker thread has completed its
  `finally` block or that yt-dlp has closed its output descriptor.
- Track worker liveness separately from the presentation status, or add an
  explicit worker-completed handoff before allowing removal.
- Cleanup should remain scoped to the random download ID as established by
  Bug 0006; waiting for ownership release must not broaden which files can be
  deleted.
- Add a regression test which keeps a partial descriptor open while the row
  becomes cancelled, attempts removal, and verifies both endpoint semantics
  and descriptor/block release after cleanup succeeds.

### Resolution

Worker resource ownership is now tracked independently from the persisted
download status. Remove returns HTTP 409 while the worker is still unwinding,
even when the row already says `cancelled`, so cleanup cannot unlink a partial
which that worker may still hold open. Once the worker has returned and
released its yt-dlp objects, a retry removes the partial and database row.

A deterministic regression test holds a real descriptor open across the
`cancelled` transition. It verifies that the first removal is rejected without
changing the file's link count, that worker completion closes the descriptor,
and that the following removal deletes the linked partial successfully.
