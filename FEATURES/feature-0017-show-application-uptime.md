# Show application uptime in the footer

**Source:** User-requested feature
**Status:** Implemented
**Last refined:** 2026-09-27

## Decision summary

Show how long the current VDL server process has been running alongside the UI
and API versions in the page footer. Define uptime as the elapsed time between
application startup and the current time.

The server is authoritative for the initial elapsed duration. It returns that
duration from the existing lightweight health endpoint, and the browser advances
the displayed value locally once per second. The normal 30-second health check
periodically resynchronises the browser with the server without introducing a
new polling request.

Present one human-readable unit at a time. Short uptimes retain more detail;
longer uptimes progressively use minutes, hours, days, months, and years.

## Confirmed requirements

- Place uptime in the existing footer after the UI and API versions.
- Measure the lifetime of the current application process, not the age of the
  database, container, host, or browser page.
- Calculate uptime from the current monotonic time minus the monotonic time
  captured during application startup.
- Keep `/api/health` local and inexpensive. Calculating uptime must not access
  SQLite, invoke yt-dlp, inspect downloads, or contact another service.
- Add `uptime_seconds` to the successful `/api/health` JSON response as the
  non-negative number of complete seconds since startup.
- Use the existing startup and 30-second health requests to obtain and
  resynchronise uptime. Do not add another network polling loop.
- Advance the displayed uptime in the browser between health checks so the
  value does not remain stale for 30 seconds at a time.
- Show only the largest suitable unit and discard smaller partial units. For
  example, 13 elapsed seconds displays as `Uptime 13 Seconds`, while 5 minutes
  and 42 seconds displays as `Uptime 5 Minutes`.
- Use singular labels only for a value of one and plural labels for every other
  value, including zero.
- Show `Uptime checking…` in the initial server-rendered page until the first
  health response arrives.
- Show `Uptime unavailable` when the health request cannot reach a healthy
  server. Do not continue presenting an estimated uptime for a process that may
  no longer be running.
- Show `Uptime unknown` when a successful health response omits
  `uptime_seconds` or supplies an invalid value.
- Preserve the footer's existing wrapping, centring, theme, version-mismatch,
  and accessible version-status behavior.

## Human-readable duration rules

Convert elapsed seconds using fixed display thresholds and truncate toward the
lower whole unit:

| Elapsed duration | Display unit | Example |
|---|---|---|
| Less than 60 seconds | Seconds | `Uptime 13 Seconds` |
| At least 60 seconds, less than 1 hour | Minutes | `Uptime 5 Minutes` |
| At least 1 hour, less than 1 day | Hours | `Uptime 3 Hours` |
| At least 1 day, less than 30 days | Days | `Uptime 8 Days` |
| At least 30 days, less than 365 days | Months of 30 days | `Uptime 6 Months` |
| At least 365 days | Years of 365 days | `Uptime 2 Years` |

Calendar months and years are not appropriate because uptime is an elapsed
duration without a wall-clock start date. Fixed 30-day months and 365-day years
keep the labels deterministic.

## Relationship to existing health and version features

Feature 0007 defines the shared `/api/health` request, its 30-second schedule,
and the server-unavailable presentation. The runtime-version feature defines
the UI/API version values already shown in the footer. This feature extends
those same seams rather than adding a second endpoint, request schedule, or
footer component.

The health response remains backward compatible: `uptime_seconds` is an
additive field, and existing consumers that only inspect `ok` or `version` can
continue unchanged.

## Implementation decisions

- Capture `APP_STARTED_AT` once with `time.monotonic()` when `vdl.py` loads.
  A monotonic clock prevents host clock corrections from making uptime jump
  backward or forward.
- Return complete elapsed seconds from `_get_uptime_seconds()`, clamped to zero
  as a defensive guard.
- Add the uptime span to `templates/index.html` so its loading state exists in
  the initial markup and does not depend on JavaScript creating DOM elements.
- Store the most recent server duration and the browser receipt time as a local
  baseline. Re-render once per second from that baseline and replace it after
  each successful health response.
- Keep duration formatting in one browser function so thresholds, truncation,
  and pluralisation cannot drift between initial rendering and later updates.
- Clear the local baseline on health failure or malformed uptime data. A later
  valid health response establishes a new baseline and restores the live
  display automatically.
- Do not persist the startup time or uptime. A process restart intentionally
  resets the value even when the same database and download volumes are reused.

## Acceptance criteria

- Thirteen seconds after server startup, the footer shows
  `UI v… · API v… · Uptime 13 Seconds`.
- A server duration of zero displays `Uptime 0 Seconds`; one second displays
  `Uptime 1 Second`.
- Five minutes displays `Uptime 5 Minutes`, and the formatter similarly selects
  Hours, Days, Months, and Years at the documented thresholds.
- Partial smaller units are truncated: 5 minutes and 59 seconds still displays
  `Uptime 5 Minutes`.
- The visible value advances from 13 to 15 seconds after two seconds pass
  without requiring another request.
- A later successful health check replaces accumulated browser time with the
  server-provided duration and resumes local advancement from that value.
- A failed health request displays `Uptime unavailable`; a valid later response
  restores a live uptime without reloading the page.
- A missing, non-numeric, non-finite, or negative `uptime_seconds` value
  displays `Uptime unknown`.
- Restarting the application resets uptime while preserving existing database
  and download-volume contents.
- Backend regression coverage verifies elapsed-time calculation and the health
  response contract. Browser coverage verifies all units, singular/plural
  labels, local advancement, and unavailable-server behavior.
