## 15. [Resolved] Cross-origin form posts can invoke destructive API actions

**Severity:** High

**Status:** Resolved and verified on 2026-09-15.

Before the fix, state-changing endpoints such as `/api/clear`,
`/api/remove/<id>`, `/api/stop/<id>`, and `/api/resume/<id>` did not validate
`Origin`, require a CSRF token, or require a non-simple request content type.
In particular,
`POST /api/clear` accepts an empty `application/x-www-form-urlencoded` request,
so a web page or browser context able to reach the loopback service can submit
a form without needing to read the cross-origin response.

The deterministic Flask reproduction sent `/api/clear` with
`Origin: https://attacker.invalid`; the endpoint returned HTTP 200 and deleted
both the finished row and its media file.

**Expected:** Destructive requests must be resistant to cross-origin form
submission, for example by validating the request origin and/or requiring a
CSRF-resistant request contract consistently across every mutating route.

Permanent coverage: `tests/test_request_security.py`.

All mutating API requests now pass through one request-boundary guard. It
rejects a supplied origin unless it matches the service origin and also
rejects cross-site Fetch Metadata, while retaining compatibility with direct
API clients that do not send browser security headers.

