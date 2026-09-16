## 9. [Resolved] Download URLs could inject JavaScript into row actions

**Severity:** High

**Status:** Resolved and verified on 2026-09-07.

Before the fix, download URLs were HTML-escaped and then interpolated into
inline `onclick` handlers for Open URL, Continue, Reload, and Copy URL. HTML
entity decoding happened before the JavaScript handler was compiled, so an
apostrophe in a URL broke the handler. A crafted URL could append and execute
arbitrary JavaScript when one of these actions was clicked.

The recheck used a harmless payload that set a marker on `window`. Clicking
Reload executed the marker, confirming stored script execution in the VDL
origin. A URL containing only an apostrophe also produced a JavaScript syntax
error and prevented Reload from sending a request.

**Expected:** Treat URLs as data rather than executable markup. Row actions
must work for valid URLs containing apostrophes, and no URL text may execute as
JavaScript.

**Reproduction:** Submit a URL containing an apostrophe and allow it to reach a
terminal state. Open its action menu and click Reload, Continue, Open URL, or
Copy URL. Inspect the inline handler and the browser's page errors.

URL actions now store the URL in an escaped data attribute and a delegated
click handler reads it as data. Open URL additionally accepts only HTTP and
HTTPS URLs. Apostrophes and markup characters round-trip without becoming
executable JavaScript.

Permanent coverage: `tests/browser/history-actions.spec.cjs`.

