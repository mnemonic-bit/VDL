## 40. [Open] Open tabs retain stale UI code after an application upgrade

**Severity:** Medium

**Status:** Open; reported after upgrading from version `0.20.0` to `0.20.1`
on 2026-10-01.

An application image can be rebuilt and its Podman container replaced while a
browser tab remains open. The tab reconnects to the new backend, but it keeps
executing the JavaScript and rendering functions that were loaded before the
upgrade. As a result, the page can continue presenting behavior and labels
from the previous release even though `/api/health`, the current page, and the
current static bundle all expose the new version.

The issue was reported after the History action label changed from **Download
file** to **Download**. The running container reported version `0.20.1`, its
served `app.js` contained only the new History-menu label, and a fresh browser
session rendered zero **Download file** buttons and eleven **Download**
buttons. The already-open tab nevertheless continued to show **Download
file** until it was refreshed.

The client checks `/api/health` every 30 seconds and eventually exposes a
version-mismatch warning with a **Refresh page** link in the footer. That
warning does not replace the stale code, interrupt stale interactions, or draw
attention near the controls the user is operating. The rest of the page stays
interactive, so the stale UI can look like a failed deployment rather than a
client that needs to reload. More consequential frontend/backend differences
could also leave an old client invoking contracts from the previous release.

### Reproduction

1. Open version `0.20.0` and leave the tab running.
2. Build and deploy version `0.20.1`, including a visible frontend change such
   as renaming the History action from **Download file** to **Download**.
3. Do not navigate or reload the existing tab. Allow its SSE connection and
   health checks to reconnect to the replacement container.
4. Open a History card's three-dot menu in the existing tab.
5. Open the application in a fresh tab and compare the same menu.

**Actual:** The existing tab continues to render **Download file** from its
old in-memory JavaScript while communicating with the `0.20.1` backend. Only
the footer eventually reports the version mismatch. A fresh tab renders the
new **Download** label.

**Expected:** Once the client detects that the API version differs from its UI
version, it should make the stale state unmistakable and guide the user into
the current frontend before normal interaction continues. Updating should not
silently discard an in-progress form or other user input.

### Acceptance criteria

- Detect a UI/API version mismatch after a container replacement without
  requiring navigation or a manual diagnostic check.
- Present the required refresh prominently enough that a user operating the
  main application controls cannot reasonably mistake the stale UI for the
  deployed release.
- Prevent an acknowledged-stale client from continuing ordinary actions
  indefinitely against the newer backend, while protecting unsaved user input
  from an unexpected reload.
- Preserve the existing same-tab refresh behavior and ensure the refreshed
  page loads versioned static assets for the current API version.
- Add a deterministic browser regression that starts with one UI version,
  changes the mocked health response to a newer API version without reloading,
  and verifies the complete stale-client prompt and refresh flow.

### Investigation notes

- A container restart cannot replace JavaScript already loaded into a browser
  execution context. Static asset cache busting protects the next navigation,
  not the currently running page.
- The existing 30-second health interval bounds detection but leaves a window
  in which the old client reconnects and remains fully interactive.
- Automatic reload should be considered only with an explicit safe-state
  policy. New-download drafts, open dialogs, rename edits, and tag edits must
  not be lost without warning.
