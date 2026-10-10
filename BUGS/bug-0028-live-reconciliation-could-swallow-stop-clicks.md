## 28. [Resolved] Live reconciliation can swallow Stop clicks

**Severity:** Medium

**Status:** Resolved in version `0.5.1` on 2026-09-19.

The primary Stop button on an active download can ignore a click when a live
update is reconciled between the pointer press and release. The timing makes
the control appear intermittent: clicking it again usually works, and no error
is displayed after the ignored attempt.

This is not a focus problem or a delayed backend cancellation. Each progress
update writes the download row and publishes an SSE `change` event. The client
schedules `fetchHistory()`, which replaces the complete contents of both
`#activeList` and `#historyList` with `innerHTML`. If that replacement occurs
after `pointerdown` on Stop but before `pointerup`, the pressed button is
detached from the document. A new, enabled Stop button appears at the same
coordinates, but the browser does not synthesize a `click` for two different
DOM nodes. Consequently `stopDownload()` never runs and no request is sent to
`POST /api/stop/<id>`.

The action-menu refresh guard does not protect the primary Stop button because
no menu is open. This makes Stop particularly exposed: it is displayed while
progress updates, and therefore SSE reconciliations, are frequent. Stop inside
the paused row's open action menu is protected by the existing deferred-refresh
behavior.

A deterministic Playwright reproduction:

1. Seed one row with status `downloading` and render Current.
2. Intercept `POST /api/stop/<id>` and count requests.
3. Move the pointer over the primary Stop button and send `mouse.down()`.
4. Await `fetchHistory()` to reproduce an SSE reconciliation.
5. Send `mouse.up()` at the unchanged coordinates.
6. Assert that one stop request was made.

The assertion failed in three consecutive runs with zero requests. Browser
instrumentation after step 4 showed that the original Stop button had
`isConnected === false`; `elementFromPoint()` found a different, enabled Stop
button at the release coordinates. A document-level click listener also
recorded zero clicks. An ordinary uninterrupted Stop click remains covered and
does send the endpoint request.

**Expected:** A press begun on Stop must still request cancellation when a
live update arrives before release. Reconciliation should preserve the active
control or otherwise retain the user's activation across the render. Add a
browser regression test that forces reconciliation between pointer down and
pointer up and verifies exactly one stop request. The solution should retain
live progress updates and the existing deferred reconciliation for open row
menus.

**Resolution:** Row reconciliation is now deferred while a pointer is held on
an action button, including when an already-started history request completes
during the press. Releasing or cancelling the pointer schedules the deferred
refresh after the browser has had a chance to synthesize the click. The same
guard continues to protect open action menus, and a deterministic Playwright
test verifies that Stop sends exactly one request when reconciliation is
forced between pointer down and pointer up.
