## 17. [Resolved] Concurrent Resume requests could start duplicate workers

**Severity:** High

**Status:** Resolved and verified on 2026-09-14.

Before the fix, `/api/resume/<id>` read the row, checked that it was resumable,
and updated it in separate database operations. Two requests could both
observe `cancelled` or `interrupted` before either wrote `starting`; both then
returned HTTP 200 and launched workers using the same download ID and output
template. The workers could write the same `.part` and final paths
concurrently.

A barrier-synchronised reproduction sent two resume requests for one cancelled
row. Both returned HTTP 200 and two worker starts were recorded.

**Expected:** Claim the resumable row with one atomic conditional state
transition, and start exactly one worker only when that claim succeeds.

Permanent coverage: `tests/test_download_lifecycle.py`.

Resume now claims a resumable row with one conditional update. Only the
request that changes the row to `starting` clears stale cancellation state and
launches a worker; competing Resume or Remove requests are rejected according
to the resulting state.

