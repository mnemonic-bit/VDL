# Show when a new download is ready to start

**Source:** User-requested feature  
**Status:** Implemented\
**Implemented:** 2026-10-21 · Version `0.42.0`\
**Last refined:** 2026-10-16

## Decision summary

Make the New download dialog show the wait between entering a URL and receiving
its video information. During that wait, show a spinner and a short status
message over the Download Options controls. Disable the quality, container, and
filename controls until the current URL's probe succeeds. Keep the URL field,
Clear URL, and Close available so the user can correct or abandon the URL.

Keep Download disabled and visually neutral until the current URL's metadata
has arrived. On a successful probe, remove the loading treatment, populate any
available options, and turn Download green to signal that it is ready. A
successful probe with no selectable qualities or containers still permits a
download using the default format; those empty menus remain disabled. A failed
probe shows an actionable error and leaves Download disabled.

This is a frontend readiness state for the existing `/api/probe` request. It
does not introduce a new download status, server endpoint, or polling loop.

## User flow

1. Opening New download with an empty URL shows the existing invitation to
   enter a URL. Download is disabled and neutral.
2. When the user types or pastes a nonempty URL, the dialog immediately enters
   **Checking video information**, including during the existing debounce
   before the request starts. The options panel opens, its controls are dimmed
   and disabled, and a visible spinner accompanies the status text. Download
   remains disabled.
3. When the latest probe succeeds, the spinner disappears. The quality and
   container menus show the returned choices, the title hint is updated, and
   Download becomes enabled and green. The user may choose options and submit
   by clicking Download or pressing Enter.
4. If the probe fails, the dialog shows **Could not load video information**
   with a **Retry** action. The URL stays editable; Download stays disabled.
   Retrying checks the same URL again, while editing the URL starts a new
   checking cycle.
5. Clearing the URL returns to the initial invitation. Closing and reopening
   the dialog preserves its draft and accurately reflects the current URL's
   probe state.

## State contract

| State | Options panel | Download button |
|---|---|---|
| Empty URL | Invitation; quality, container, and filename disabled | Disabled, neutral |
| Checking, including debounce | Spinner and “Checking video information…” over dimmed controls; quality, container, and filename disabled | Disabled, neutral |
| Ready for current URL | Overlay removed; available choices enabled; menus with no choices disabled; filename enabled | Enabled, green |
| Probe error | Error text and Retry; dependent controls disabled | Disabled, neutral |
| Submitting | Keep the selected choices visible; prevent another submission | Disabled until the request resolves |

- Entering, pasting, changing, or clearing the URL immediately invalidates the
  previous ready state. The green button must never remain enabled for metadata
  belonging to an earlier URL, even during the debounce period. Reset old
  quality/container choices and the title hint when a new URL starts checking.
- Only a successful response for the current URL and probe generation can move
  the dialog to Ready. Late success or failure from an older request must not
  change the message, controls, filename hint, or Download button.
- A successful response with an empty `resolutions` or `containers` list is
  Ready: show the existing default choice and keep only that unavailable menu
  disabled. An absent title leaves the generic filename hint in place.
- Treat HTTP errors, `{ "error": ... }` responses, invalid response data, and
  network failures as probe errors. Show a concise, safe message and Retry;
  never insert server error text as HTML.
- Pressing Enter while Checking or after a probe error cannot submit the form.
  Pressing Enter in Ready follows the same path as clicking Download. On a
  rejected `/api/download` request, retain the URL and chosen options, report
  the existing submission error, and return to Ready for that URL so the user
  can try again without another probe.
- A successful submission keeps the existing form reset and dialog close
  behavior. Reopening after that reset shows the empty state, with no spinner
  or green button.

## Visual and accessibility requirements

- Scope the loading treatment to Download Options. The URL input, clear
  control, dialog Close button, and dialog heading remain readable and usable.
  Dim the options controls behind the status; do not blur the URL field or
  cover the dialog's form buttons.
- Give the spinner adjacent visible text; color and motion alone must not
  convey state. Use an accessible status announcement for Checking, Ready, and
  Error without announcing every debounce restart or animation frame. Mark
  the options region busy only while checking.
- Use the existing theme's green tokens for the enabled Download button, with
  legible text and icon in light and dark themes. Hover and keyboard focus must
  remain clear. The disabled state stays visually distinct from green and
  uses the native `disabled` attribute, not color alone.
- Honor `prefers-reduced-motion` by stopping the spinner animation while
  keeping its status text visible. Keep the overlay and status legible at
  narrow viewport widths.

## Implementation touchpoints

- `templates/index.html`: give the Download submit button a stable selector
  and add a status/spinner and Retry control within Download Options.
- `static/app.js`: centralize the empty, checking, ready, error, and submitting
  UI transitions around `scheduleProbe`, `probeVideoUrl`, `invalidateProbe`,
  `resetOptions`, and `startDownload`. Reuse the existing generation check.
- `static/styles.css`: style the options loading/error treatment and the
  neutral, disabled, and green Download button states with theme variables.
- `tests/browser/download-options.spec.cjs` and
  `tests/browser/download-form.spec.cjs`: cover the new states and submission
  gate, including the existing Enter behavior after a probe completes.

## Acceptance criteria

- With a delayed probe, the spinner and “Checking video information…” appear
  as soon as a URL is entered. The quality and container menus, filename
  field, and Download button are disabled throughout the debounce and request.
  The URL field, Clear URL, and Close remain usable.
- When that probe succeeds, the spinner goes away, the returned choices become
  available, and Download becomes enabled with a green background. Clicking it
  or pressing Enter submits exactly once.
- A successful probe with no video resolutions still enables the green
  Download button while the unavailable quality menu stays disabled.
- If URL A's slow probe finishes after URL B's probe, only B's result can set
  the controls or green button. Clearing the URL during a probe restores the
  empty state and ignores its late response.
- A failed probe presents an error and Retry, keeps Download disabled, and
  allows a retry or URL correction without closing the dialog.
- A rejected download submission preserves the draft and chosen options,
  reports its error, and re-enables the green button for the same ready URL.
- The status is understandable with motion reduced, keyboard navigation, and
  screen reader announcements in both themes and at a narrow viewport.

## Verification

Add deterministic browser tests that delay, succeed, and fail `/api/probe`,
including stale responses and a successful response with empty option lists.
Update the existing Enter submission test to wait for Ready. Run
`./tests/run-all.sh --browser` and `./tests/run-all.sh --unit`; verify the
required `vdl.py` coverage result before declaring the implemented feature
complete.

## Implementation validation

- `./tests/run-all.sh --browser`: all 170 browser tests passed, including
  delayed and stale probes, invalid responses, Retry, empty option lists,
  submission gating, draft preservation, keyboard submission, both themes,
  narrow layouts, and reduced motion.
- `./tests/run-all.sh --unit` with Python 3.12: 235 tests run, 5 skipped;
  `vdl.py` line coverage was 90.9% (4551/5008), above the 90% minimum.
