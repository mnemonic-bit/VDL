## 16. [Resolved] An unusable download directory leaves workers stuck at Starting

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

`POST /api/preferences` accepts an empty, invalid, or unwritable
`download_dir`. `background_download()` calls `os.makedirs()` before entering
its exception-handling block. A directory preparation error therefore escapes
the worker thread instead of updating the row to `error`, and the UI can show
that row at `starting` / `0%` indefinitely.

The deterministic reproduction saved an empty directory, which returned HTTP
200, then started a worker. `os.makedirs('')` raised `FileNotFoundError` and the
database row remained active.

**Expected:** Validate the download directory when preferences are saved and
also keep worker setup inside the failure boundary so filesystem errors become
terminal rows with useful messages.

Expected-behavior coverage: `tests/test_preferences.py`.

Preferences now prepare and validate a nonempty, writable download directory
before saving it. Workers repeat that check at startup so a directory that
becomes unusable after it was saved is recorded as a terminal `error` with a
useful message; the failure occurs before a concurrency slot is acquired.

