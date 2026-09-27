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
