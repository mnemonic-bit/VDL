## 21. [Resolved] Failed Preferences saves are displayed as successful

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

Before the fix, `savePreferences()` did not check `response.ok`. Any HTTP
response, including a 400 or 500, changed the button to Saved and temporarily
disabled it. The UI also applied player and theme choices before persistence
succeeded, so the page could claim and display settings that the server did
not store.

A deterministic browser reproduction intercepted the Preferences POST with an
HTTP 500 response. The button still changed to Saved.

**Expected:** Show Saved only after a successful response. On rejection, retain
the editable values, report the server error, and make clear that the changes
were not persisted.

Permanent coverage: `tests/browser/preferences.spec.cjs`.

Preferences now use the shared checked-action request path. Rejected responses
leave the form editable, display the server-provided error, and do not change
the Saved state or commit runtime player settings. The Saved confirmation and
runtime settings are applied only after the server accepts the request.

