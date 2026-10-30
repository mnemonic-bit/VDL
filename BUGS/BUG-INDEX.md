# Known Bugs

Issues 1-8 were found during a container review on 2026-09-06 and rechecked on
2026-09-07. Issues 9-13 were found during that recheck. Their valuable
reproductions now live in the permanent deterministic suite under `tests/`;
historical screenshots and logs were retired after that migration.
Issues 14-22 were found during a repository and test-coverage audit on
2026-09-14. Their deterministic reproductions now live in the permanent
suite, with open behavior guarded by expected-failure markers. Issue 22
records both the expanded coverage and the remaining behavioral debt.
Issue 23 was reproduced in the running container on 2026-09-16 and reduced
to a deterministic progress-hook reproduction. Issues 24-26 record the UI
regression introduced by its first fix and the subsequent size and ETA
smoothing behavior.
Issue 27 was found by the first GitHub Actions publication run on 2026-09-19
and reproduced with pip's ARM64 platform resolver. The combined lock now
admits only the reviewed wheels for both published architectures, and the
validation workflow resolves both platforms before publication.
Issue 28 was reported as an intermittent Stop-button failure on 2026-09-19.
A deterministic browser reproduction showed that an SSE reconciliation can
replace the pressed button between pointer down and pointer up, preventing the
browser from emitting a click or sending the stop request. Row reconciliation
now waits for pressed actions to finish before replacing their controls.
Issue 29 was reported and observed in the running container on 2026-09-19.
Initial progress and ETA values can be implausible until the same download is
stopped and continued. The latest post-Continue state is credible, but the
original samples still need to be captured for a deterministic reproduction.
Issue 30 was reproduced in the running Podman container on 2026-09-27. Removing
a stopped download unlinked its partial and deleted its database row while the
worker still held the file descriptor, retaining approximately 555 MiB until
the worker exits or the container restarts. Worker lifetime is now tracked
separately from terminal row status, and removal is rejected until the worker
has released its resources.
Issue 31 was reproduced after that worker-lifetime fix on 2026-09-27. A
cancelled fragmented download could finish its worker and become removable
while an unreachable yt-dlp progress-hook cycle still retained the locked
partial-file descriptor. Worker completion now forces cyclic finalization
before removal is allowed.
Issue 32 was reported, resolved, and visually refined on 2026-09-27. The
download icon beside the page title was visually undersized, and its
aggregate-progress ring was too thin. The icon is now larger while remaining
vertically centered. A persistent green track becomes lighter during active
downloads while blue determinate progress covers it, without clipping the
broader stroke against the SVG viewport. A follow-up contrast refinement
darkened both active colors while keeping the track lighter than the icon, and
a second pass moved the progress stroke toward navy for stronger separation
before a small lightening adjustment settled its final shade. The active green
track was then slightly darkened while remaining lighter than the icon.
Issue 33 was reported and resolved on 2026-09-27. Starting a download opened
the Current Downloads drawer without user intent, the drawer stopped below the
fixed header instead of covering the full viewport, and the count badge stayed
visible after the final active download moved to History. Submission now leaves
the drawer closed, the drawer spans the viewport at desktop and mobile widths,
and the empty badge honors its hidden state.
Issue 34 was reported and resolved during the same redesign follow-up on
2026-09-27. Native quality-selector clicks could dismiss New download, the URL
draft lifecycle was not explicit, Current Downloads appeared without entrance
motion, and a redundant History heading weakened the content-first hierarchy.
Dialog hit testing and draft behavior are now covered, the drawer slides in
with reduced-motion support, and the main content keeps only an accessible
History label.
Issues 35-37 were found by the GitHub Actions run for commit `e522dd9` on
2026-09-27. Both CodeQL matrices completed their scans but could not read the
workflow run while uploading their results because the job lacked
`actions: read`. The Main job also exposed two browser timing races: its Stop
test aimed at a control before the animated drawer reached its final position,
and a burst of insert/update SSE events could replace a new History card before
its insertion animation started. The CodeQL job now has the required scope,
the pointer test waits for a stable target, and insertion animations remain
pending only until a rendered card emits `animationstart`.
Issue 38 was reported and resolved on 2026-09-29. The History Info popover had
an understated and unevenly spaced heading, placed File after Status and
Source, misaligned the File label with its rename control, offered no inline
way to copy Source, and grew when Tags entered edit mode. The heading now uses
the shared info icon and uppercase text, the detail rows follow the intended
order and alignment, Source has a compact copy action, and the Tags display
and edit states keep the same height.
Issue 39 was reported and resolved on 2026-09-29. The primary New download
action occupied unnecessary header space with a text label, while Current
downloads remained visible even when its drawer was empty. New download is now
a compact circular plus action, and Current downloads is hidden until the
drawer contains active or resumable work.
Issue 40 was reported after deploying version `0.20.1` on 2026-10-01. An
already-open tab continued to render the previous **Download file** action even
though the replacement container, current bundle, and fresh browser sessions
all exposed **Download**. The existing footer warning detects the UI/API
version mismatch but does not keep an old client from continuing to interact
with the newer backend or make the required refresh prominent near the active
workflow.
Issue 41 was reported and resolved through an interactive History-preview
review on 2026-10-01. Video thumbnails carried a redundant play overlay and
tooltip, lacked a delayed moving preview, sampled unhelpful opening and closing
frames, and initially generated H.264 level-6.2 montages that some Firefox
decoders rejected. The thumbnail is now unobscured, its seven-excerpt montage
loads only after intentional hover, skips five seconds at both timeline edges,
uses Firefox-compatible level-2.1 encoding, and preserves the favorite star's
state-specific tooltip. The related full player now omits its repeated title
and reveals an inner top-right close control only during mouse activity or
keyboard focus.
Issue 42 was reported and resolved during a UI cleanup review on 2026-10-01.
Account actions crowded the header, operational status was fragmented,
favorite-star hover stopped moving previews, History pagination was rigid,
and its long-range controls appeared for only three pages. More importantly,
normal users could see and invoke the destructive Danger Zone. Account actions
now live in a rightmost username menu, status stays compact in the footer,
preview and pagination behavior follow their intended boundaries, and both the
Danger Zone markup and clear-history APIs are restricted to administrators.
Issue 43 was reported and resolved through a Preferences Users review on
2026-10-01. Account editors were fragmented, lacked a distinct display name
and single-row draft lifecycle, and used inconsistent creation and removal
flows. Follow-up review also refined the final-administrator guard and the
feedback shown for locked roles and rows. Users now share one table with an
empty creation row, explicit Save/Cancel state, application dialogs, backend
last-active-admin enforcement, and explanatory lock tooltips.
Issue 44 was reported from two intermittent GitHub Actions failures on
2026-10-01. A late Preferences response could restore the saved System theme
after a test selected Dark, while an early-exiting digest parser could close
Buildx's output pipe and make `pipefail` report status 255. Settings now waits
for its data and rejects stale preference responses. Image publication now
resolves every digest from structured manifest JSON and retries brief registry
propagation delays.
Issue 45 was reported and resolved on 2026-10-04. Leaving a video that had
started in full screen returned to the original-size overlay because the
browser consumed Escape without sending the page's close-player key event.
Playback now remembers how full screen was entered: leaving an initially
full-screen session closes playback, while leaving full screen entered later
through the video controls returns to the overlay.
Issue 46 was reported on 2026-10-09 and resolved and deployed in version
`0.32.1` on 2026-10-10. Choosing a known tag rebuilt the suggestion list while
its click was still bubbling, so the detached target looked like an outside
click and closed the History Info popover. The Info Escape branch also failed
to cancel the handled key event, allowing Firefox to leave macOS application
fullscreen. Suggestion clicks now stop before the rebuild reaches the outside
handler, and Info Escape prevents the browser default before closing. Browser
regressions cover both event boundaries, and the reporter confirmed the fix in
Firefox on macOS after deployment.
Issue 47 was reported, resolved, and deployed in version `0.32.2` on 2026-10-10.
Dragging a local video onto the page displayed the upload overlay, but moving
the file back outside the page without dropping could leave the overlay open.
Nested `dragenter` events left the depth counter above zero after the final
page-level `dragleave`. A leave with no related in-document target now clears
the complete drag state and closes the overlay. A browser regression covers
the nested-entry exit sequence, and the reporter confirmed the deployed fix.
Issue 48 was reported and resolved through an iterative Settings and library
review on 2026-10-10, then deployed in version `0.32.5`. Settings terminology,
spacing, search alignment, and persistent navigation were made consistent;
follow-up regressions restored the browser-owned scrollbar and limited the
sticky header background to the left navigation column while preserving the
search-height gap. The library also gained persisted endless scrolling, and
hover previews now start after 250 milliseconds, use two-second excerpts, and
show total duration in place of quality while playing.
Issue 49 was reported on 2026-10-16. After closing one video midway, opening a
different video can appear to reuse the first video's playback position. The
reporter observed this while ingestion was adding and shifting video cards;
that connection remains unconfirmed. A follow-up report on 2026-10-20 described
the same apparent timestamp carryover and raised possible network or server
delay during heavy folder import; reproducibility and cause remain unconfirmed.
Issue 50 was reported on 2026-10-21 and resolved in version `0.46.3` on
2026-10-23. Numeric-input buttons and unchecked checkboxes retained their light
native appearance because the page did not declare its effective color scheme.
Native controls now inherit the selected light or dark scheme. Keyboard,
persistence, and system-theme regressions pass, with visual verification in
Chromium, Firefox, and WebKit.
Issue 51 was reported on 2026-10-21 and resolved in version `0.46.4` on
2026-10-23. The Settings quick-index only changed after clicks or searches,
leaving it stale during manual scrolling. It now follows the visible section
in both directions, accounts for overlapping sticky headers on mobile, and
reconciles after resizing, filtering, layout changes, and reopening Settings.
Browser regressions cover desktop/mobile viewports and navigation boundaries.
Issue 52 was reported on 2026-10-22 after a GitHub push failed CodeQL analysis
with a configuration-version mismatch. Git history confirms that Dependabot
commit `cadc995` advanced only `analyze` to `4.38.2`, leaving `init` at
`4.38.0`; both had matched before that commit. Version `0.45.1` aligns both
pins to `4.38.2`, groups future CodeQL updates, and checks full-SHA equality
per job in the existing deterministic validation gate. Hosted analysis and
confirmation of the live required-check ruleset remain outstanding.
Issue 53 was reported and corrected on 2026-10-23. Authenticated requests
to `/api/current-downloads` can fail with `sqlite3.OperationalError: database
is locked` in the user lookup before the endpoint handler runs. Controlled
reproductions confirm the exact traceback and rollback-journal reader/writer
conflicts. Version `0.46.1` enables WAL, bounds SQLite lock waits, returns
retryable 503 responses for uncaught contention without bypassing account
checks, and adds safe operation/commit diagnostics. The client retries affected
reads twice and preserves rows with a visible error if refresh still fails.
Concurrency regressions cover large writes, old readers, ingest publication,
authorization recovery, and atomic rollback. The production lock holder remains
unknown; active-import progress UI remains follow-up work.
Issue 54 was reported, investigated, and corrected on 2026-10-23. With
approximately 2,000 Library videos, unbounded overlapping refreshes amplified
slow responses, hid accepted Current Downloads, and repeatedly replaced
thumbnails. Version `0.46.2` bounds refreshes per collection, renders Current
independently, preserves cards and previews, distinguishes loading/failure from
empty state, and bounds thumbnail generation with capacity-aware retries.
Request-local directory snapshots reduce a 2,000-item Library response from
2,000 allowlist scans and 4,002 connections to one scan and three closed
connections. Status/tag filtering now runs in SQL. Deterministic backend and
browser regressions cover delayed/failed requests, sustained events, queued
acceptance, navigation intent, stable images and retained controls. The original
production trigger for minute-long waits remains unverified.
Issue 55 was reported by GitHub Actions and reproduced on 2026-10-24. Cards
received while Settings hid the Library were measured at zero height for their
entrance animations. Returning briefly exposed the endless-scroll sentinel and
loaded 20 cards instead of the initial 10. Version `0.46.5` skips insertion
animations for elements without layout boxes, with a browser regression for
hidden arrivals and subsequent scrolling.
Issue 56 was reported by GitHub Actions and reproduced on 2026-10-24. The
download-options debounce test installed Playwright's clock without pausing
it, allowing interactions and assertions to advance time past the deadline.
Version `0.46.6` pauses the clock before URL input so explicit time steps
control the test. The corrected test passed 20 consecutive local runs;
confirmation on the hosted runner remains outstanding.
Issue 57 was reported after the hidden-card fix and reproduced on 2026-10-24.
Visible cards with correctly measured heights still briefly collapsed during
entrance animations, exposing the endless-scroll sentinel and loading the
second batch before scrolling. Version `0.46.7` waits for animations to finish
and checks the sentinel's current visibility and position. Deterministic
regressions cover both the observer and scroll-event fallback; confirmation on
the hosted runner remains outstanding.
Issue 58 was reported and reproduced on 2026-10-25. Copy URL in Current
Downloads showed a success tick while leaving the clipboard empty whenever
the Clipboard API was unavailable or rejected the write. The fallback's text
field was outside the modal drawer and therefore inert, and its copy result
was ignored. Version `0.46.8` puts the field inside the active modal, restores
focus, and reports failed copies instead of showing success.
Issue 59 was reported and fixed locally in version `0.49.1` on 2026-10-28.
Equivalent URL input while acceptance was pending could invalidate the probe
generation and skip the successful submission's dialog close. Input with an
unchanged trimmed URL now preserves the generation, while a dialog-session
guard protects reopened drafts. Browser regressions cover pasted submissions,
immediate/delayed/queued acceptance, failures, and newer drafts. This race is
independently reproduced; the original reporter's exact trigger and deployed
confirmation remain outstanding.
Issue 60 was reported, investigated, and fixed locally in version `0.49.2` on
2026-10-28. Small capped reads amplified synchronous progress work, while
Unlimited also changed HLS downloader selection. Response reads now combine
accounted allowances with bounded latency, and transport selection preserves
the original options at 0, including live changes before subsequent transfers.
Real HTTP regressions cover costly progress callbacks, concurrent workers, and
50/10/0 Mbps; shared accounting, Stop/Pause, and external guards remain covered.
The original source-specific startup failure and deployment confirmation remain
outstanding.

Issue 61 was reported from GitHub Actions on 2026-10-28 after pushing Feature
0045 (Shuffle Clips). A controlled local reproduction established that API-only
account switching leaves the old Library alive: a delayed 401 can redirect it
to `/login` and expire the new session cookie. Version `0.49.3` changes both
playback tests to use the browser's Sign out and Sign in flow, verifying the
authenticated Library and active account before checking the saved mode.
Both affected tests passed ten consecutive runs each and within the complete
browser run; that run has a separate upload-stop timeout. The original
hosted-runner artifacts were unavailable, and production impact is unconfirmed.

Issue 62 was reported and investigated on 2026-10-28, and fixed locally in
version `0.49.4`. Dropping files now closes the modal immediately and creates
individual preparation entries in Current downloads. Independent registrations,
stable client/server IDs, progress, per-file failure feedback, and deferred
Stop/Delete keep the page and sibling uploads usable through registration,
transfer, validation, and delayed collection reads. Deterministic browser
regressions cover the reproduced blocking cases and lifecycle races. Large real
video confirmation in the affected deployment remains outstanding.

Issue 63 was reported, reproduced in Chromium, and fixed locally in version
`0.49.5` on 2026-10-28. Continuous fullscreen playback let intrinsic video
dimensions expand its grid beyond the screen and crop the picture. Explicit
grid tracks now constrain the image to both viewport dimensions. Browser
regressions check rendered edge markers and black bars across four aspect
ratios, both fullscreen entry paths, resizing, exit, and re-entry.

Issue 64 was reproduced in Chromium and fixed locally in version `0.49.6`
on 2026-10-28. Shuffle Clips replaced the outgoing source at its excerpt end
before the successor was playable. It now keeps that video visible and
playing until readiness and authorization permit a fade, preserving the
incoming clock through promotion. Real-media regressions cover held loads,
seeks and confirmation, consecutive short clips, pause/cancellation, and EOF;
bounded recovery preserves the outgoing picture and exposes useful feedback.
Feature 0045's timing contract now permits this continuity fallback.

Issue 65 was reported from GitHub Actions on 2026-10-28. The endless-scroll
browser test loads its initial and second batches but times out with 20 cards
instead of the expected 21 after scrolling for the final batch. The run ended
with one failed and 278 passed tests. Local traces and controlled reproductions
show two cases: the test scrolls before newly inserted cards finish expanding,
and valid scrolls during a pending refresh are discarded. Version `0.49.7`
synchronizes the test's final scroll with the settled layout and rechecks the
sentinel after every loaded batch. All pagination checks pass repeatedly and
within the full Chromium suite; Python 3.12 coverage is 91.6%. The full browser
gate has a separate live-refresh request-count failure that also reproduces
with unchanged baseline JavaScript. Original CI artifacts and production impact
remain unverified.

Issue 66 was reported from GitHub Actions on 2026-10-29. A controlled
Chromium reproduction confirms that the paused `0.03502`-second clock rounds
to zero in the seek range. Home then emits no change or media-clock write,
so the test's reset assumption fails. Version `0.50.1` makes the setup
deterministic by pressing ArrowRight before Home and checks zero seek writes
through pointer preview/cancellation and one per completed drag. The fix is
verified locally: the focused regression passes 20 repetitions, all 352
Chromium browser tests pass, and Firefox/WebKit each pass six focused checks.
The Python 3.12 unit gate passes with 91.6% coverage. The original CI artifacts
remain uninspected.

Issue 67 was reported and fixed in version `0.50.2` on 2026-10-30. A
deterministic startup reproduction showed visible thumbnails waiting through
100 unrelated registrations (30 simulated seconds with 300 ms commits).
Reconciliation now yields after a 50 ms time slice, bounded by the current
operation, so that reproduction generates the thumbnail after one registration.
Unchanged asset registrations also avoid write transactions while preserving
caches and retry budgets. Tests cover persistent cache delivery during startup,
eventual HTTP image delivery, and successful slow-commit warning fields.
SQLite timing and contention diagnostics remain enabled. The original deployed
image, complete logs, and storage conditions remain unconfirmed.

Issue 68 was reported and fixed in version `0.50.3` on 2026-10-30. The
redundant header New download Plus button and its styles were removed while
preserving the existing Ctrl/Cmd+V workflow. Dialog closure restores the
original focus target or falls back to the account menu when that target is
unavailable. Browser regressions cover native paste, successful submission,
editable controls, modal guards, focus restoration, and header spacing in
both themes at desktop and mobile widths.

Issue 69 is fixed in version `0.50.4`. URL worker setup failures now publish
an actionable outcome, with transient SQLite terminal-write failures retried
until persistence recovers. Stop reconciles dead URL workers without a restart.
Extraction and media requests have finite socket waits and retries, with Stop
checked around requests and reads; ownership is retained through cleanup.
Current downloads exposes preparation/stopping stages and byte counts. Real
SQLite-lock and local-HTTP regressions cover recovery and queued successors at
Unlimited and 50 Mbps. The affected deployment's precise trigger and any
connection to Bug 0067 remain unconfirmed.

Issue 70 records the reported player-control visibility and interaction gaps.
After three seconds of inactivity, the title/Close header should fade out and
the bottom controls should slide out of sight. The video surface should toggle
Play/Pause on click, the speed selector should show rate factors without a
visible Speed label, and a dedicated button should repeat the current video.
In fullscreen, the video should use its final viewport-based size immediately,
with both bars overlaid; hiding or revealing them must not resize the video.
The report is open and documentation-only; these behaviors have not yet been
reproduced or repaired for this request.

## Bug reports

- [Bug 0001 — Merged downloads kept the deleted temporary audio filename](bug-0001-merged-downloads-kept-deleted-temporary-audio-filename.md)
- [Bug 0002 — Maximum concurrent downloads setting was not enforced](bug-0002-maximum-concurrent-downloads-was-not-enforced.md)
- [Bug 0003 — Download Options ignores the custom Title/Filename](bug-0003-custom-title-filename-was-ignored.md)
- [Bug 0004 — Audio-only behavior is inconsistent](bug-0004-audio-only-behavior-was-inconsistent.md)
- [Bug 0005 — Clear History also removes cancelled and interrupted Current entries](bug-0005-clear-history-removed-resumable-current-entries.md)
- [Bug 0006 — Cancelled downloads can leave partial files behind](bug-0006-cancelled-downloads-left-partial-files.md)
- [Bug 0007 — History insertion animation does not make room before revealing the row](bug-0007-history-insertion-did-not-make-room.md)
- [Bug 0008 — Finished-download section is not foldable](bug-0008-finished-downloads-were-not-foldable.md)
- [Bug 0009 — Download URLs could inject JavaScript into row actions](bug-0009-download-urls-could-inject-javascript.md)
- [Bug 0010 — Stale URL probes overwrite newer or cleared Download Options](bug-0010-stale-probes-overwrote-download-options.md)
- [Bug 0011 — An open row menu can leave live download state stale](bug-0011-open-row-menu-left-live-state-stale.md)
- [Bug 0012 — Failed download submissions silently clear the form](bug-0012-failed-downloads-silently-cleared-form.md)
- [Bug 0013 — Special characters were double-escaped in the filename hint](bug-0013-special-characters-were-double-escaped.md)
- [Bug 0014 — Renamed filenames could inject JavaScript into the Play action](bug-0014-renamed-filenames-could-inject-javascript.md)
- [Bug 0015 — Cross-origin form posts can invoke destructive API actions](bug-0015-cross-origin-posts-invoked-destructive-actions.md)
- [Bug 0016 — An unusable download directory leaves workers stuck at Starting](bug-0016-unusable-directory-left-workers-stuck.md)
- [Bug 0017 — Concurrent Resume requests could start duplicate workers](bug-0017-concurrent-resume-started-duplicate-workers.md)
- [Bug 0018 — The playback allow-list authorizes a tampered row's own directory](bug-0018-playback-allow-list-authorized-tampered-row.md)
- [Bug 0019 — Unknown-size downloads never leave Starting in the UI](bug-0019-unknown-size-downloads-stayed-at-starting.md)
- [Bug 0020 — Format fallback triggers on noncanonical diagnostic errors](bug-0020-format-fallback-triggered-on-diagnostic-errors.md)
- [Bug 0021 — Failed Preferences saves are displayed as successful](bug-0021-failed-preference-saves-appeared-successful.md)
- [Bug 0022 — Important backend, UI, and container contracts lacked regression coverage](bug-0022-important-contracts-lacked-regression-coverage.md)
- [Bug 0023 — Estimated HLS size and progress jump during download](bug-0023-hls-size-and-progress-jumped.md)
- [Bug 0024 — First HLS stabilization fix hid size and progress](bug-0024-first-hls-fix-hid-size-and-progress.md)
- [Bug 0025 — Estimated time remaining jumped between updates](bug-0025-estimated-time-remaining-jumped.md)
- [Bug 0026 — Continued downloads began with a multi-day ETA](bug-0026-continued-downloads-began-with-multi-day-eta.md)
- [Bug 0027 — ARM64 container builds reject x86-only dependency hashes](bug-0027-arm64-container-builds-reject-x86-only-dependency-hashes.md)
- [Bug 0028 — Live reconciliation can swallow Stop clicks](bug-0028-live-reconciliation-could-swallow-stop-clicks.md)
- [Bug 0029 — Initial progress and ETA are implausible until Stop and Continue](bug-0029-initial-progress-and-eta-were-implausible-until-continue.md)
- [Bug 0030 — Removing a stopped download retains an unlinked partial file](bug-0030-removing-stopped-download-retains-unlinked-partial.md)
- [Bug 0031 — Cancelled fragment downloads retain their partial descriptor after worker completion](bug-0031-cancelled-fragment-download-retains-descriptor.md)
- [Bug 0032 — Header download icon is undersized and its progress ring is too thin](bug-0032-header-download-icon-is-undersized.md)
- [Bug 0033 — Current Downloads opens unexpectedly and retains a stale count](bug-0033-current-downloads-opens-and-retains-stale-count.md)
- [Bug 0034 — Download workflow redesign left modal and visual-hierarchy regressions](bug-0034-download-workflow-redesign-left-ui-regressions.md)
- [Bug 0035 — CodeQL could not upload results without Actions read access](bug-0035-codeql-could-not-upload-without-actions-read.md)
- [Bug 0036 — Animated drawer made the Stop reconciliation test miss its target](bug-0036-animated-drawer-made-stop-test-miss-target.md)
- [Bug 0037 — SSE bursts could cancel History insertion animations before they started](bug-0037-sse-bursts-cancelled-history-insertion-animation.md)
- [Bug 0038 — History info panel had inconsistent layout and no source-copy action](bug-0038-history-info-panel-had-inconsistent-layout-and-missing-source-copy.md)
- [Bug 0039 — Header download actions occupied space without useful state](bug-0039-header-download-actions-occupied-space-without-useful-state.md)
- [Bug 0040 — Open tabs retain stale UI code after an application upgrade](bug-0040-open-tabs-retain-stale-ui-after-upgrade.md)
- [Bug 0041 — History video previews were redundant and Firefox-incompatible](bug-0041-history-video-previews-were-redundant-and-firefox-incompatible.md)
- [Bug 0042 — UI cleanup left navigation, preview, pagination, and authorization gaps](bug-0042-ui-cleanup-left-navigation-preview-pagination-and-authorization-gaps.md)
- [Bug 0043 — User administration was fragmented and lacked safe edit guards](bug-0043-user-administration-was-fragmented-and-lacked-safe-edit-guards.md)
- [Bug 0044 — GitHub Actions had intermittent theme and image-digest failures](bug-0044-github-actions-had-intermittent-theme-and-image-digest-failures.md)
- [Bug 0045 — Fullscreen Escape ignored the playback launch mode](bug-0045-fullscreen-escape-ignored-playback-launch-mode.md)
- [Bug 0046 — History Info tag selection closed the popover and Escape exited macOS fullscreen](bug-0046-info-tag-selection-closed-popover-and-escape-exited-fullscreen.md)
- [Bug 0047 — Upload overlay remained open after a file drag left the page](bug-0047-upload-overlay-remained-open-after-drag-left-page.md)
- [Bug 0048 — Settings and hover-preview controls were inconsistent](bug-0048-settings-and-hover-preview-controls-were-inconsistent.md)
- [Bug 0049 — Opening another video can reuse the previous playback position](bug-0049-next-video-reuses-previous-playback-position.md)
- [Bug 0050 — Number-input buttons and checkboxes do not match the dark theme](bug-0050-number-input-buttons-and-checkboxes-ignore-dark-theme.md)
- [Bug 0051 — Settings quick-index highlight does not follow scrolling](bug-0051-settings-quick-index-highlight-does-not-follow-scrolling.md)
- [Bug 0052 — Dependabot CodeQL updates can desynchronize action versions](bug-0052-dependabot-codeql-updates-can-desynchronize-action-versions.md)
- [Bug 0053 — Database locks fail authenticated API requests](bug-0053-database-locks-fail-authenticated-api-requests.md)
- [Bug 0054 — Live refresh overload stalls the download UI](bug-0054-live-refresh-overload-stalls-download-ui.md)
- [Bug 0055 — Hidden card animations trigger endless scrolling on return from Settings](bug-0055-hidden-card-animations-trigger-endless-scroll.md)
- [Bug 0056 — Debounce browser test clock kept advancing between explicit time steps](bug-0056-debounce-browser-test-clock-kept-advancing.md)
- [Bug 0057 — Visible card animations trigger endless scrolling before user scrolling](bug-0057-visible-card-animations-trigger-endless-scroll.md)
- [Bug 0058 — Current Downloads confirms copying without filling the clipboard](bug-0058-current-downloads-copy-leaves-clipboard-empty.md)
- [Bug 0059 — Download dialog remains open after a successful submission](bug-0059-download-dialog-remains-open-after-submission.md)
- [Bug 0060 — Downloads stall or slow down after bandwidth controls were added](bug-0060-downloads-stall-or-slow-after-bandwidth-controls.md)
- [Bug 0061 — Playback account-switch tests fail in GitHub Actions after Shuffle Clips](bug-0061-playback-account-switch-tests-fail-after-shuffle-clips.md)
- [Bug 0062 — Drag-and-drop uploads block access to the main screen](bug-0062-drag-and-drop-uploads-block-main-screen.md)
- [Bug 0063 — Fullscreen playback crops non-widescreen videos](bug-0063-fullscreen-playback-crops-non-widescreen-videos.md)
- [Bug 0064 — Shuffle Clips shows an empty player before the next video is ready](bug-0064-shuffle-clips-shows-empty-player-before-next-video-is-ready.md)
- [Bug 0065 — Endless scrolling stalls before the final batch in GitHub Actions](bug-0065-endless-scroll-stalls-before-final-batch-in-github-actions.md)
- [Bug 0066 — Custom-controls Home seek does not reach zero in GitHub Actions](bug-0066-custom-controls-home-seek-does-not-reach-zero-in-github-actions.md)
- [Bug 0067 — Container startup delays previews and logs SQLite registration warnings](bug-0067-container-startup-delays-previews-and-logs-sqlite-warnings.md)
- [Bug 0068 — Redundant Plus button in the download header](bug-0068-redundant-plus-button-in-download-header.md)
- [Bug 0069 — URL downloads remain at zero bytes without recovery](bug-0069-downloads-remain-at-zero-bytes-without-recovery.md)
- [Bug 0070 — Player controls stay visible and lack direct playback actions](bug-0070-player-controls-stay-visible-and-lack-direct-playback-actions.md)

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
