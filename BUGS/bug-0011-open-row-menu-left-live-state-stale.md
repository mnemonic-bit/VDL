## 11. [Resolved] An open row menu can leave live download state stale

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

`fetchHistory()` returns immediately whenever any row action menu is open.
SSE change events received during that interval are discarded, and closing
the menu does not schedule a reconciliation. If a download finishes while its
menu is open, the UI can continue showing it in Current indefinitely even
though the API reports `finished`.

The recheck held a menu open until a slow download completed. The API reported
`finished`, but the item stayed in Current after the menu closed. Calling
`fetchHistory()` manually moved it to History.

**Expected:** Defer one refresh while a menu is open and run it when the menu
closes, or update the row without disrupting the open menu.

**Reproduction:** Start a slow download, open its action menu, and keep it open
until `/api/history` reports `finished`. Close the menu and observe that the
row remains in Current until another refresh occurs.

Blocked history refreshes are now coalesced while a row menu is open. Closing
the menu schedules one reconciliation; switching directly to another menu
keeps the new menu stable and carries the deferred refresh forward until it
also closes.

Permanent coverage: `tests/browser/live-updates.spec.cjs`.

