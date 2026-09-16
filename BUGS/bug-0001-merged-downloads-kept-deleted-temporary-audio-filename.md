## 1. [Resolved] Merged downloads kept the deleted temporary audio filename

**Severity:** High

**Status:** Resolved by commit `aca3d58` and verified on 2026-09-07.

Before the fix, when yt-dlp downloaded separate video and audio streams,
ffmpeg successfully created the merged MP4. The download history row
nevertheless kept the path of the temporary audio stream, such as:

```text
/downloads/manifest_6b9f8195.f2.m4a
```

That temporary file no longer exists after merging. The actual finished file
is present at a path such as:

```text
/downloads/manifest_6b9f8195.mp4
```

This left the entry marked `finished`, but:

- playback through `/api/file/<id>` returns HTTP 404;
- inline rename returns HTTP 410, "Original file is missing on disk";
- deleting the history entry does not delete the merged MP4, leaving an
  orphaned file on disk;
- final size and resolution probing may operate on the wrong path.

The progress hook stored the filename reported when an individual stream
finished. The post-download recovery then removed only the stored extension
and tried common extensions. For a stored name ending in `.f2.m4a`, it looked
for paths beginning with `.f2`, while ffmpeg wrote the merged file without
that format suffix.

**Expected:** After post-processing, the history row must contain the actual
merged output path.

**Reproduction:** Download a source with separate video and audio streams,
such as the audit DASH fixture, and select a merged video format. Wait for the
entry to report `finished`, then try Play or Rename.

Permanent coverage: `tests/test_merged_download.py` and
`tests/integration/test_real_media.py`.

The fix now waits for post-processing to finish and stores the path reported
by the postprocessor. A current real DASH merge stored the resulting MP4 path;
playback returned HTTP 200, rename succeeded, and removal deleted the file.

