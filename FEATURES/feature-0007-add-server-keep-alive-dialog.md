# Add a server keep-alive dialog

**Source section:** Further things to add to the download helper
**Status:** Implemented
**Last refined:** 2026-09-17

## Decision summary

Check the server when the page loads and every 30 seconds thereafter. If the
browser can no longer communicate with the server, show a prominent,
non-blocking banner explaining that actions will not work until the connection
is restored.

Use the existing local `/api/health` endpoint for the periodic check. The
warning is a banner rather than a modal dialog so a temporary outage does not
interrupt inspection of the page or require the user to acknowledge every
failed check.

## Confirmed requirements

- Run a health check immediately when the page loads.
- Repeat the health check every 30 seconds while the page remains open.
- Keep the health check local and inexpensive. It must not access SQLite,
  invoke yt-dlp, or contact an external media site.
- Show the connection warning when a normal API request cannot reach the
  server.
- Also show the warning when the browser's Server-Sent Events connection
  reports an error, so loss of live updates is visible even before the next
  periodic health check.
- Explain that the server is unavailable and that actions will not work until
  the connection is restored.
- Present the warning as an accessible alert at the top of the viewport.
- Let the user dismiss the warning without blocking the rest of the UI.
- Hide the warning after a later API request succeeds. The page therefore
  recovers automatically when the server becomes reachable again.
- Keep the API-version footer in sync with the same health request. A failed
  health check reports the API version as unavailable as well as showing the
  connection warning.

## Relationship to Feature 0006

Feature 0006 covers surfacing a request failure when the user performs an
action. This feature adds proactive liveness detection, including outages that
occur while the user is not interacting with the page. Both paths intentionally
share the same server-unavailable banner.

## Implementation decisions

- The browser calls `GET /api/health` once at startup and then on a 30-second
  interval.
- All ordinary browser API requests use the shared `apiFetch` wrapper. Network
  failures show the banner and successful HTTP responses clear it.
- The `EventSource` error handler shows the same banner. EventSource retains
  its native automatic reconnection behavior; a subsequent history fetch
  clears the warning when communication resumes.
- The `/api/events` stream sends an SSE comment approximately every 15 seconds.
  This transport keepalive prevents an otherwise idle stream from being
  discarded by browsers or intermediaries; it is separate from the 30-second
  application-level health check.
- The banner uses `role="alert"` and a labelled dismiss button. It does not
  disable controls or obscure the current download state.
