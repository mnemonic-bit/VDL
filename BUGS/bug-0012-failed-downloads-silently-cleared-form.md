## 12. [Resolved] Failed download submissions silently clear the form

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

The submit handler parses every `/api/download` response and resets the URL and
options without checking `response.ok`. An HTTP error response is therefore
treated like a successful start. The user's URL disappears, no error is shown,
and the unavailable-server banner stays hidden because the server did respond.

The recheck intercepted `/api/download` with an HTTP 500 JSON response. The URL
field was cleared and the response's error message was absent from the page.

**Expected:** Preserve the entered URL and options after a rejected request and
show the server-provided error message.

**Reproduction:** Make `/api/download` return HTTP 400 or 500 with a JSON error,
then submit a valid-looking URL through the form.

Permanent coverage: `tests/browser/download-form.spec.cjs`.

Rejected download submissions now use the shared action-error boundary. HTTP
errors retain the entered URL and Download Options while showing the server's
JSON error message; only accepted submissions clear the form.

