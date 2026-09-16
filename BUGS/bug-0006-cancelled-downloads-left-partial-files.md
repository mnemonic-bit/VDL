## 6. [Resolved] Cancelled downloads can leave partial files behind

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-13.

Some cancelled downloads have no path saved in the history row. Removing the
entry or clearing history therefore cannot locate their `.part`, fragment, and
`.ytdl` files, which remain in the download directory.

**Expected:** Removing a cancelled download should remove all partial files
owned by that download, without affecting unrelated files.

Permanent coverage: `tests/test_cancelled_cleanup.py`.

Each worker now records the directory it actually uses. Removal identifies
all final, split-format, fragment, `.part`, and `.ytdl` files by the random
download ID embedded in their output names, even when no filename reached the
database before cancellation. Cleanup remains confined to that worker's
directory and leaves files belonging to other download IDs untouched.

