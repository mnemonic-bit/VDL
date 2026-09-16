## 2. [Resolved] Maximum concurrent downloads setting was not enforced

**Severity:** High

**Status:** Resolved by commit `a70d006` and verified on 2026-09-07.

Before the fix, the `max_concurrent` preference was saved and displayed, but
every accepted download started a new worker thread immediately. With the
value set to `1`, two test downloads simultaneously reached `downloading` at
9.9%.

**Expected:** At most the configured number of downloads should run; excess
downloads should remain queued until a worker slot is available.

Permanent coverage: `tests/test_max_concurrent.py`.

Workers now wait in FIFO order for a dynamically sized slot before entering
the probe and download phases. Focused tests verify that the configured limit
is enforced, queued downloads can be cancelled, and raising the limit wakes a
waiting download.

