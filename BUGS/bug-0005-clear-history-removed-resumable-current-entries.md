## 5. [Resolved] Clear History also removes cancelled and interrupted Current entries

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-16.

The UI presents Clear History inside the Download History tab, but the backend
clears every terminal status. This includes `cancelled` and `interrupted`,
which the UI places in Current so they can be continued. A cancelled audit
entry disappeared from Current after Clear History was used.

**Expected:** Clear History should remove only statuses displayed in Download
History (`finished` and `error`), or the UI should clearly disclose and confirm
that resumable Current entries will also be removed.

Permanent coverage: `tests/test_history_api.py`.

Clear History now uses the same `finished` and `error` status boundary as the
Download History tab. Its preview, artifact cleanup, and row deletion all
preserve resumable `cancelled` and `interrupted` Current entries.

