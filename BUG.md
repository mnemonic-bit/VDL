# Known Bugs

These issues were confirmed during the container feature audit performed on
2026-09-06 against commit `73214c1`. The complete audit and its limits are in
[`feature-audit/REPORT.md`](feature-audit/REPORT.md).

## 1. Merged downloads keep the deleted temporary audio filename

**Severity:** High

When yt-dlp downloads separate video and audio streams, ffmpeg successfully
creates the merged MP4. The download history row nevertheless keeps the path
of the temporary audio stream, such as:

```text
/downloads/manifest_6b9f8195.f2.m4a
```

That temporary file no longer exists after merging. The actual finished file
is present at a path such as:

```text
/downloads/manifest_6b9f8195.mp4
```

This leaves the entry marked `finished`, but:

- playback through `/api/file/<id>` returns HTTP 404;
- inline rename returns HTTP 410, "Original file is missing on disk";
- deleting the history entry does not delete the merged MP4, leaving an
  orphaned file on disk;
- final size and resolution probing may operate on the wrong path.

The progress hook stores the filename reported when an individual stream
finishes. The post-download recovery then removes only the stored extension
and tries common extensions. For a stored name ending in `.f2.m4a`, it looks
for paths beginning with `.f2`, while ffmpeg wrote the merged file without
that format suffix.

**Expected:** After post-processing, the history row must contain the actual
merged output path.

**Reproduction:** Download a source with separate video and audio streams,
such as the audit DASH fixture, and select a merged video format. Wait for the
entry to report `finished`, then try Play or Rename.

Evidence: [focused result](feature-audit/evidence/merge-evidence.json),
[failing reproduction](feature-audit/evidence/merge-repro.log), and
[orphaned-file result](feature-audit/evidence/deletion-evidence.json).

## 2. Maximum concurrent downloads setting is not enforced

**Severity:** High

The `max_concurrent` preference is saved and displayed, but every accepted
download starts a new worker thread immediately. With the value set to `1`,
two test downloads simultaneously reached `downloading` at 9.9%.

**Expected:** At most the configured number of downloads should run; excess
downloads should remain queued until a worker slot is available.

Evidence: [browser audit results](feature-audit/evidence/results.json).

## 3. Download Options ignores the custom Title/Filename

**Severity:** Medium

The frontend sends the `filename` field in `POST /api/download`, but the
backend does not use it when building yt-dlp's output template. Entering
`requested-custom-name` produced a file named from the source title instead.

**Expected:** A valid custom filename entered in Download Options should be
used for the downloaded file while preserving the real output extension.

Evidence: [browser audit results](feature-audit/evidence/results.json).

## 4. Audio-only behavior is inconsistent

**Severity:** Medium

There are two related failures:

1. `bestaudio/best` downloads only audio when the source offers a separate
   audio stream, but falls back to the complete video when the source is a
   combined MP4. No post-processing step extracts audio from that fallback.
2. The per-download Quality menu treats the extractor label `audio only` as a
   numeric resolution and generates the invalid selector
   `bestvideo[height<=NaN]+bestaudio/best`.

**Expected:** Audio-only must produce an audio-only output for supported
sources, and nonnumeric resolution labels must never generate height filters.

Evidence: [browser audit results](feature-audit/evidence/results.json) and
[DASH supplemental results](feature-audit/evidence/supplement.json).

## 5. Clear History also removes cancelled and interrupted Current entries

**Severity:** Medium

The UI presents Clear History inside the Download History tab, but the backend
clears every terminal status. This includes `cancelled` and `interrupted`,
which the UI places in Current so they can be continued. A cancelled audit
entry disappeared from Current after Clear History was used.

**Expected:** Clear History should remove only statuses displayed in Download
History (`finished` and `error`), or the UI should clearly disclose and confirm
that resumable Current entries will also be removed.

Evidence: [supplemental results](feature-audit/evidence/supplement.json).

## 6. Cancelled downloads can leave partial files behind

**Severity:** Medium

Some cancelled downloads have no path saved in the history row. Removing the
entry or clearing history therefore cannot locate their `.part`, fragment, and
`.ytdl` files, which remain in the download directory.

**Expected:** Removing a cancelled download should remove all partial files
owned by that download, without affecting unrelated files.

Evidence: [deletion evidence](feature-audit/evidence/deletion-evidence.json).

## 7. History insertion animation does not make room before revealing the row

**Severity:** Low

The item animation changes opacity only. The list layout changes immediately,
so existing rows jump rather than moving smoothly to make room before the new
entry fades in.

**Expected:** Animate the inserted row's occupied space and visibility, as
described by the TODO marked complete.

Evidence: [browser audit results](feature-audit/evidence/results.json).

## 8. Finished-download section is not foldable

**Severity:** Low

Finished downloads correctly move to the Download History tab, but that
section has no disclosure control and cannot be folded despite the TODO being
marked complete.

**Expected:** Either make the finished section foldable or update the TODO to
record the tab-based design as the accepted replacement.

Evidence: [supplemental results](feature-audit/evidence/supplement.json).

## Minor UI differences

- In inline rename mode, Cancel appears to the right of Save, while the TODO
  specifies an X to the left of the tick.
- With no URL entered, Download Options shows the explanatory message as an
  overlay over visible disabled fields rather than showing an empty section.

The Debian package-server DNS failure seen while building `Dockerfile.vdl` is
not listed as an application bug. The same hosts were unreachable from the
test host, and the Dockerfile could not be assessed on a network with working
Debian repositories.
