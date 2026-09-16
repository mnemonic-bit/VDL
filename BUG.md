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

## Bug reports

- [Bug 0001 — Merged downloads kept the deleted temporary audio filename](BUGS/bug-0001-merged-downloads-kept-deleted-temporary-audio-filename.md)
- [Bug 0002 — Maximum concurrent downloads setting was not enforced](BUGS/bug-0002-maximum-concurrent-downloads-was-not-enforced.md)
- [Bug 0003 — Download Options ignores the custom Title/Filename](BUGS/bug-0003-custom-title-filename-was-ignored.md)
- [Bug 0004 — Audio-only behavior is inconsistent](BUGS/bug-0004-audio-only-behavior-was-inconsistent.md)
- [Bug 0005 — Clear History also removes cancelled and interrupted Current entries](BUGS/bug-0005-clear-history-removed-resumable-current-entries.md)
- [Bug 0006 — Cancelled downloads can leave partial files behind](BUGS/bug-0006-cancelled-downloads-left-partial-files.md)
- [Bug 0007 — History insertion animation does not make room before revealing the row](BUGS/bug-0007-history-insertion-did-not-make-room.md)
- [Bug 0008 — Finished-download section is not foldable](BUGS/bug-0008-finished-downloads-were-not-foldable.md)
- [Bug 0009 — Download URLs could inject JavaScript into row actions](BUGS/bug-0009-download-urls-could-inject-javascript.md)
- [Bug 0010 — Stale URL probes overwrite newer or cleared Download Options](BUGS/bug-0010-stale-probes-overwrote-download-options.md)
- [Bug 0011 — An open row menu can leave live download state stale](BUGS/bug-0011-open-row-menu-left-live-state-stale.md)
- [Bug 0012 — Failed download submissions silently clear the form](BUGS/bug-0012-failed-downloads-silently-cleared-form.md)
- [Bug 0013 — Special characters were double-escaped in the filename hint](BUGS/bug-0013-special-characters-were-double-escaped.md)
- [Bug 0014 — Renamed filenames could inject JavaScript into the Play action](BUGS/bug-0014-renamed-filenames-could-inject-javascript.md)
- [Bug 0015 — Cross-origin form posts can invoke destructive API actions](BUGS/bug-0015-cross-origin-posts-invoked-destructive-actions.md)
- [Bug 0016 — An unusable download directory leaves workers stuck at Starting](BUGS/bug-0016-unusable-directory-left-workers-stuck.md)
- [Bug 0017 — Concurrent Resume requests could start duplicate workers](BUGS/bug-0017-concurrent-resume-started-duplicate-workers.md)
- [Bug 0018 — The playback allow-list authorizes a tampered row's own directory](BUGS/bug-0018-playback-allow-list-authorized-tampered-row.md)
- [Bug 0019 — Unknown-size downloads never leave Starting in the UI](BUGS/bug-0019-unknown-size-downloads-stayed-at-starting.md)
- [Bug 0020 — Format fallback triggers on noncanonical diagnostic errors](BUGS/bug-0020-format-fallback-triggered-on-diagnostic-errors.md)
- [Bug 0021 — Failed Preferences saves are displayed as successful](BUGS/bug-0021-failed-preference-saves-appeared-successful.md)
- [Bug 0022 — Important backend, UI, and container contracts lacked regression coverage](BUGS/bug-0022-important-contracts-lacked-regression-coverage.md)
- [Bug 0023 — Estimated HLS size and progress jump during download](BUGS/bug-0023-hls-size-and-progress-jumped.md)
- [Bug 0024 — First HLS stabilization fix hid size and progress](BUGS/bug-0024-first-hls-fix-hid-size-and-progress.md)
- [Bug 0025 — Estimated time remaining jumped between updates](BUGS/bug-0025-estimated-time-remaining-jumped.md)
- [Bug 0026 — Continued downloads began with a multi-day ETA](BUGS/bug-0026-continued-downloads-began-with-multi-day-eta.md)

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
