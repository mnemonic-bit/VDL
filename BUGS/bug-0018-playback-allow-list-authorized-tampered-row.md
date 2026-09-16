## 18. [Resolved] The playback allow-list authorizes a tampered row's own directory

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

Before the fix, `/api/file/<id>` built its allowed directory set from every finished row,
including the row currently being served. If a database row points directly to
an existing file outside the configured or historically trusted download
directories, that file's parent is added to the allow-list and the check always
passed for that row. This contradicted the route's stated tampered-row defense.

The deterministic reproduction stored a finished row pointing to an external
fixture file. `/api/file/<id>` returned HTTP 200 and the external contents.

**Expected:** Derive trusted roots independently of the candidate row, such as
persisted worker output directories, and reject a filename outside those roots.

Permanent coverage: `tests/test_playback.py`.

Playback now derives historical trusted roots from the output directory
captured when each worker starts, independently of the filename later reported
by yt-dlp. Legitimate files remain playable after a preference change, while a
forged filename cannot authorize its own external parent directory.

