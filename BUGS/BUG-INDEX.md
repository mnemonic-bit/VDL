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
