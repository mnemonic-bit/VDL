## 3. [Resolved] Download Options ignores the custom Title/Filename

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-16.

The frontend sends the `filename` field in `POST /api/download`, but the
backend does not use it when building yt-dlp's output template. Entering
`requested-custom-name` produced a file named from the source title instead.

**Expected:** A valid custom filename entered in Download Options should be
used for the downloaded file while preserving the real output extension.

Expected-behavior coverage: `tests/test_download_requests.py` and
`tests/browser/download-options.spec.cjs`.

Custom basenames are now validated and persisted with the download so resumed
workers retain them. yt-dlp downloads to an ID-bearing staging name, preserving
safe partial-file cleanup, then the completed output is renamed to the requested
basename with the media's actual extension.

