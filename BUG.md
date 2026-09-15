# Known Bugs

Issues 1-8 were found during a container review on 2026-09-06 and rechecked on
2026-09-07. Issues 9-13 were found during that recheck. Their valuable
reproductions now live in the permanent deterministic suite under `tests/`;
historical screenshots and logs were retired after that migration.
Issues 14-22 were found during a repository and test-coverage audit on
2026-09-14. Their deterministic reproductions now live in the permanent
suite, with open behavior guarded by expected-failure markers. Issue 22
records both the expanded coverage and the remaining behavioral debt.

## 1. [Resolved] Merged downloads kept the deleted temporary audio filename

**Severity:** High

**Status:** Resolved by commit `aca3d58` and verified on 2026-09-07.

Before the fix, when yt-dlp downloaded separate video and audio streams,
ffmpeg successfully created the merged MP4. The download history row
nevertheless kept the path of the temporary audio stream, such as:

```text
/downloads/manifest_6b9f8195.f2.m4a
```

That temporary file no longer exists after merging. The actual finished file
is present at a path such as:

```text
/downloads/manifest_6b9f8195.mp4
```

This left the entry marked `finished`, but:

- playback through `/api/file/<id>` returns HTTP 404;
- inline rename returns HTTP 410, "Original file is missing on disk";
- deleting the history entry does not delete the merged MP4, leaving an
  orphaned file on disk;
- final size and resolution probing may operate on the wrong path.

The progress hook stored the filename reported when an individual stream
finished. The post-download recovery then removed only the stored extension
and tried common extensions. For a stored name ending in `.f2.m4a`, it looked
for paths beginning with `.f2`, while ffmpeg wrote the merged file without
that format suffix.

**Expected:** After post-processing, the history row must contain the actual
merged output path.

**Reproduction:** Download a source with separate video and audio streams,
such as the audit DASH fixture, and select a merged video format. Wait for the
entry to report `finished`, then try Play or Rename.

Permanent coverage: `tests/test_merged_download.py` and
`tests/integration/test_real_media.py`.

The fix now waits for post-processing to finish and stores the path reported
by the postprocessor. A current real DASH merge stored the resulting MP4 path;
playback returned HTTP 200, rename succeeded, and removal deleted the file.

## 2. [Resolved] Maximum concurrent downloads setting was not enforced

**Severity:** High

**Status:** Resolved by commit `a70d006` and verified on 2026-09-07.

Before the fix, the `max_concurrent` preference was saved and displayed, but
every accepted download started a new worker thread immediately. With the
value set to `1`, two test downloads simultaneously reached `downloading` at
9.9%.

**Expected:** At most the configured number of downloads should run; excess
downloads should remain queued until a worker slot is available.

Permanent coverage: `tests/test_max_concurrent.py`.

Workers now wait in FIFO order for a dynamically sized slot before entering
the probe and download phases. Focused tests verify that the configured limit
is enforced, queued downloads can be cancelled, and raising the limit wakes a
waiting download.

## 3. Download Options ignores the custom Title/Filename

**Severity:** Medium

The frontend sends the `filename` field in `POST /api/download`, but the
backend does not use it when building yt-dlp's output template. Entering
`requested-custom-name` produced a file named from the source title instead.

**Expected:** A valid custom filename entered in Download Options should be
used for the downloaded file while preserving the real output extension.

Expected-behavior coverage: `tests/test_download_requests.py` and
`tests/browser/download-options.spec.cjs`.

## 4. Audio-only behavior is inconsistent

**Severity:** Medium

There are two related failures:

1. `bestaudio/best` downloads only audio when the source offers a separate
   audio stream, but falls back to the complete video when the source is a
   combined MP4. No post-processing step extracts audio from that fallback.
2. The per-download Quality menu treats the extractor label `audio only` as a
   numeric resolution and generates the invalid selector
   `bestvideo[height<=NaN]+bestaudio/best`.

**Expected:** Audio-only must produce an audio-only output for supported
sources, and nonnumeric resolution labels must never generate height filters.

Expected-behavior coverage: `tests/test_formats.py`,
`tests/integration/test_real_media.py`, and
`tests/browser/download-options.spec.cjs`.

## 5. Clear History also removes cancelled and interrupted Current entries

**Severity:** Medium

The UI presents Clear History inside the Download History tab, but the backend
clears every terminal status. This includes `cancelled` and `interrupted`,
which the UI places in Current so they can be continued. A cancelled audit
entry disappeared from Current after Clear History was used.

**Expected:** Clear History should remove only statuses displayed in Download
History (`finished` and `error`), or the UI should clearly disclose and confirm
that resumable Current entries will also be removed.

Expected-behavior coverage: `tests/test_history_api.py`.

## 6. [Resolved] Cancelled downloads can leave partial files behind

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-13.

Some cancelled downloads have no path saved in the history row. Removing the
entry or clearing history therefore cannot locate their `.part`, fragment, and
`.ytdl` files, which remain in the download directory.

**Expected:** Removing a cancelled download should remove all partial files
owned by that download, without affecting unrelated files.

Permanent coverage: `tests/test_cancelled_cleanup.py`.

Each worker now records the directory it actually uses. Removal identifies
all final, split-format, fragment, `.part`, and `.ytdl` files by the random
download ID embedded in their output names, even when no filename reached the
database before cancellation. Cleanup remains confined to that worker's
directory and leaves files belonging to other download IDs untouched.

## 7. History insertion animation does not make room before revealing the row

**Severity:** Low

The item animation changes opacity only. The list layout changes immediately,
so existing rows jump rather than moving smoothly to make room before the new
entry fades in.

**Expected:** Animate the inserted row's occupied space and visibility, as
described by the TODO marked complete.

Expected-behavior coverage: `tests/browser/live-updates.spec.cjs`.

## 8. [Resolved by product decision] Finished-download section is not foldable

**Severity:** Low

Finished downloads correctly move to the Download History tab, but that
section has no disclosure control and cannot be folded despite the TODO being
marked complete.

**Status:** Resolved on 2026-09-14. The separate Download History tab is the
accepted replacement for the older foldable-section design. `TODOs.md` and
`tests/README.md` record this contract.

Permanent coverage: `tests/browser/live-updates.spec.cjs` verifies movement
between Current and Download History.

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

## 10. Stale URL probes overwrite newer or cleared Download Options

**Severity:** Medium

Each URL edit starts an asynchronous `/api/probe` request, but responses are
not associated with the URL that initiated them. If probe A is slow and probe
B finishes first, A can later append its title, qualities, and containers to
B's options. Clearing the URL while a probe is in flight also allows the late
response to repopulate and re-enable the otherwise-empty Options panel.

The recheck delayed probe A and allowed probe B to return immediately. The
input still contained B, but the filename hint showed A and the Quality menu
contained results from both requests. In a second run, clearing the input was
followed by A's qualities reappearing in an enabled selector.

**Expected:** Only the latest probe may update Download Options. Clearing or
changing the URL must cancel or invalidate all earlier responses.

**Reproduction:** Enter URL A, wait for its probe to start, then enter URL B or
clear the input before A completes. Arrange for A to respond last and inspect
the title hint and quality selector.

Expected-behavior coverage: `tests/browser/download-options.spec.cjs`.

## 11. An open row menu can leave live download state stale

**Severity:** Medium

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

Expected-behavior coverage: `tests/browser/live-updates.spec.cjs`.

## 12. Failed download submissions silently clear the form

**Severity:** Medium

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

Expected-behavior coverage: `tests/browser/download-form.spec.cjs`.

## 13. [Resolved] Special characters were double-escaped in the filename hint

**Severity:** Low

**Status:** Resolved and verified on 2026-09-15.

The title returned by `/api/probe` was HTML-escaped before being assigned to
the input's `placeholder` property. Property assignment does not parse HTML,
so characters such as `&` and `<` appeared as literal `&amp;` and `&lt;` text.

**Expected:** The filename hint should display the title's original text.

**Reproduction:** Probe a source whose title contains `&` or `<` and inspect
the Title/Filename placeholder.

Permanent coverage: `tests/browser/download-options.spec.cjs`.

The filename hint now assigns the probe title directly to the DOM property,
preserving the original text without introducing an HTML-injection sink.

## 14. [Resolved] Renamed filenames could inject JavaScript into the Play action

**Severity:** High

**Status:** Resolved and verified on 2026-09-15.

Before the fix, the rename endpoint permitted HTML entity text such as
`&apos;`, and the History renderer interpolated the resulting filename into an
inline `onclick` attribute. `escapeJs()` escaped literal apostrophes but did
not HTML-escape ampersands. The browser decoded the entity before compiling
the handler, so a filename could close the JavaScript string and append script
that ran when Play was clicked.

A deterministic Chromium reproduction renamed a finished file to an otherwise
valid basename containing encoded apostrophes and a harmless marker assignment.
Clicking Play set the marker on `window`.

**Expected:** Filenames must remain data. Bind Play through a delegated event
handler or another non-executable data channel; do not interpolate filenames
into inline JavaScript.

**Reproduction:** Rename a finished file to a basename containing an HTML-
encoded apostrophe and JavaScript expression, then click Play. The expression
runs in the VDL origin.

Permanent coverage: `tests/browser/history-actions.spec.cjs`.

The Play action now carries the filename in HTML-escaped data attributes and
uses the delegated click handler to pass it to the player as data. No filename
is compiled as inline JavaScript.

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

## 16. [Resolved] An unusable download directory leaves workers stuck at Starting

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

`POST /api/preferences` accepts an empty, invalid, or unwritable
`download_dir`. `background_download()` calls `os.makedirs()` before entering
its exception-handling block. A directory preparation error therefore escapes
the worker thread instead of updating the row to `error`, and the UI can show
that row at `starting` / `0%` indefinitely.

The deterministic reproduction saved an empty directory, which returned HTTP
200, then started a worker. `os.makedirs('')` raised `FileNotFoundError` and the
database row remained active.

**Expected:** Validate the download directory when preferences are saved and
also keep worker setup inside the failure boundary so filesystem errors become
terminal rows with useful messages.

Expected-behavior coverage: `tests/test_preferences.py`.

Preferences now prepare and validate a nonempty, writable download directory
before saving it. Workers repeat that check at startup so a directory that
becomes unusable after it was saved is recorded as a terminal `error` with a
useful message; the failure occurs before a concurrency slot is acquired.

## 17. [Resolved] Concurrent Resume requests could start duplicate workers

**Severity:** High

**Status:** Resolved and verified on 2026-09-14.

Before the fix, `/api/resume/<id>` read the row, checked that it was resumable,
and updated it in separate database operations. Two requests could both
observe `cancelled` or `interrupted` before either wrote `starting`; both then
returned HTTP 200 and launched workers using the same download ID and output
template. The workers could write the same `.part` and final paths
concurrently.

A barrier-synchronised reproduction sent two resume requests for one cancelled
row. Both returned HTTP 200 and two worker starts were recorded.

**Expected:** Claim the resumable row with one atomic conditional state
transition, and start exactly one worker only when that claim succeeds.

Permanent coverage: `tests/test_download_lifecycle.py`.

Resume now claims a resumable row with one conditional update. Only the
request that changes the row to `starting` clears stale cancellation state and
launches a worker; competing Resume or Remove requests are rejected according
to the resulting state.

## 18. [Resolved] The playback allow-list authorizes a tampered row's own directory

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

Before the fix, `/api/file/<id>` built its allowed directory set from every finished row,
including the row currently being served. If a database row points directly to
an existing file outside the configured or historically trusted download
directories, that file's parent is added to the allow-list and the check always
passed for that row. This contradicted the route's stated tampered-row defense.

The deterministic reproduction stored a finished row pointing to an external
fixture file. `/api/file/<id>` returned HTTP 200 and the external contents.

**Expected:** Derive trusted roots independently of the candidate row, such as
persisted worker output directories, and reject a filename outside those roots.

Permanent coverage: `tests/test_playback.py`.

Playback now derives historical trusted roots from the output directory
captured when each worker starts, independently of the filename later reported
by yt-dlp. Legitimate files remain playable after a preference change, while a
forged filename cannot authorize its own external parent directory.

## 19. [Resolved] Unknown-size downloads never leave Starting in the UI

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

The progress hook writes status and metadata only when `total_bytes` or
`total_bytes_estimate` is positive. For streams where yt-dlp reports downloaded
bytes but no total, every `downloading` event is ignored. The row stays at
`starting` / `0%` and omits title, resolution, and speed until the final event.

The deterministic reproduction called the real progress hook with a valid
`downloading` payload, 4096 downloaded bytes, and no total. The database row
remained `starting` with no captured metadata.

**Expected:** Mark the row `downloading` and persist available metadata even
when a percentage cannot be calculated; show an indeterminate progress state.

The progress hook now persists an explicit `Downloading` state and all
available live metadata independently of percentage calculation. The Current
tab renders that non-percentage state with an animated indeterminate bar.

Expected-behavior coverage: `tests/test_download_lifecycle.py` and
`tests/browser/live-updates.spec.cjs`.

## 20. [Resolved] Format fallback triggers on noncanonical diagnostic errors

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

Before the fix, `_is_format_unavailable_error()` accepted any error containing
`--list-formats`, in addition to yt-dlp's literal `Requested format is not
available` message. A network, authorization, or extractor error that merely
suggested that diagnostic command could therefore cause VDL to retry with a
different format, masking the original request and doing unnecessary work.

A deterministic fake raised `HTTP 403; run --list-formats for diagnostics` on
the `best` attempt. VDL selected format `v1`, persisted that replacement, and
made a second download attempt.

**Expected:** Only the literal `Requested format is not available` condition
may trigger automatic format fallback. Other failures must surface unchanged.

Permanent coverage: `tests/test_formats.py`.

Format fallback now recognizes only yt-dlp's canonical `Requested format is
not available` message. Errors that merely mention `--list-formats` retain the
original selector, make no second download attempt, and surface unchanged.

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

## 22. [Resolved] Important backend, UI, and container contracts lacked regression coverage

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

The permanent suite is broad and all four tiers currently pass under the
documented expected-failure policy, but the coverage ledger overstates several
areas. In addition to Bugs 14-21 having no permanent red-capable tests, these
important contracts are unprotected:

- atomic and rejected backend transitions for pause, unpause, stop, resume, and
  remove (the browser test only proves which URL is called);
- upgrades from an older SQLite schema through every migration;
- history pagination and page-boundary behavior;
- UI rendering for matching, mismatched, missing, and malformed API versions;
- failed Preferences, Clear, Reload, Continue, Pause, Stop, and Delete requests;
- shipping-container parity for pause/unpause/cancel/resume and partial cleanup;
  the container tier runs only the real DASH merge lifecycle test; and
- cleanup failure behavior when a file cannot be removed.

There is also no coverage report or minimum threshold in the release gate, so
future code can silently introduce additional unexercised paths.

**Expected:** Add focused unit/browser/container tests at the real seams above,
give each open behavior bug an expected-failure regression until fixed, and
enforce a reviewed coverage baseline without treating line coverage alone as
proof of correctness.

Permanent coverage now includes:

- `tests/test_download_lifecycle.py` for accepted/rejected transitions,
  simultaneous Resume, and Resume/Remove races;
- `tests/test_migrations.py` for upgrades from the initial schema through every
  current migration;
- `tests/browser/history-pagination.spec.cjs` for ordering and page-boundary
  clamping;
- `tests/browser/version-status.spec.cjs` for matching, mismatched, missing,
  malformed, and unavailable API versions;
- `tests/browser/action-errors.spec.cjs` and
  `tests/browser/preferences.spec.cjs` for rejected UI actions;
- `tests/container/smoke.sh` for shipping-image lifecycle and partial cleanup
  parity;
- `tests/test_cancelled_cleanup.py` for cleanup failures; and
- `tests/coverage_gate.py` for a dependency-free reviewed 90% `vdl.py` line
  baseline in the unit/release gate.

The remaining expected failures were retired after rejected Pause, Stop,
Continue, Delete, Reload, and Clear actions began showing the server's error
without losing their rows or continuing a failed action chain. Artifact cleanup
now runs before its database row is removed; a filesystem failure returns an
error and retains the row so cleanup can be retried.

## Accepted UI decisions

- Inline rename requires working Save and Cancel actions; their relative order
  is not a product contract.
- With no URL entered, Download Options intentionally shows its explanatory
  message over visible disabled fields.

The Debian package-server DNS failure seen while building the former
`Dockerfile.vdl` seed is
not listed as an application bug. The same hosts were unreachable from the
test host, and the Dockerfile could not be assessed on a network with working
Debian repositories.
