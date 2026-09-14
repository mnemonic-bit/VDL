# Feature 3: Permanent regression suite

**Status:** Implemented 2026-09-14

## Outcome

The one-off container review was replaced by deterministic permanent coverage
under `tests/`. Historical screenshots, logs, hashes, result JSON, fixed-port
scripts, and the alternate Dockerfile were removed after every useful finding
received one of these dispositions:

- a passing Python, browser, local-media, or shipping-container test;
- an expected-behavior test naming an open `BUG.md` issue;
- an explicit product decision in `tests/README.md`; or
- a documented platform/external limitation.

No permanent test contacts a public media site or asserts that a pending
roadmap feature must remain absent.

## Architecture delivered

| Layer | Entry point | Contract |
|---|---|---|
| Fast Python/Flask | `tests/run-all.sh --unit` | Requests, formats, lifecycle, history, rename, playback, SSE, persistence |
| Browser | `tests/run-all.sh --browser` | Real Chromium behavior against a dynamic-port deterministic fixture app |
| Local media | `tests/run-all.sh --media` | Generated combined MP4 and DASH through real yt-dlp, ffmpeg, ffprobe, Range, stop/continue |
| Shipping container | `tests/run-all.sh --container` | Root Dockerfile, UID/GID, tools, assets, persistence, no browser, local DASH merge |

`tests/run-all.sh --all` is the complete gate. Playwright retains traces and
screenshots only on failure. Mutable databases, media directories, ports,
worker state, and container resources are isolated and cleaned up.

## Coverage ledger

| Area | Permanent owner |
|---|---|
| Health, page, JavaScript, CSS, image contents | `tests/container/smoke.sh` |
| Download button, favicon, Enter, Ctrl-V | `tests/browser/download-form.spec.cjs` |
| Empty Options, probes, format selector, custom filename | `tests/test_download_requests.py`, `tests/test_formats.py`, `tests/browser/download-options.spec.cjs` |
| Preferences, themes, Save confirmation | `tests/browser/preferences.spec.cjs`, persistence unit tests |
| SSE movement, Current layout, quality, ETA, actions | `tests/test_sse.py`, `tests/browser/live-updates.spec.cjs` |
| Pause, cancel, resume, crash recovery, worker slots | `tests/test_download_lifecycle.py`, `tests/test_max_concurrent.py` |
| Rename, copy, reload, clear, URL-action injection | `tests/test_rename.py`, `tests/test_history_api.py`, `tests/browser/history-actions.spec.cjs` |
| Playback, MIME, ranges, overlay/new-tab modes | `tests/test_playback.py`, `tests/browser/playback.spec.cjs` |
| Merge path, cleanup, file ownership | `tests/test_merged_download.py`, `tests/test_cancelled_cleanup.py` |
| Real DASH merge, audio, stop/continue Range | `tests/integration/test_real_media.py` |

Expected failures protect Bugs 3, 4, 5, 7, and 10–13. Both unittest and
Playwright treat unexpected success as a failing result.

## Decisions and limitations

- The separate Download History tab replaces the older foldable finished
  section requirement.
- Empty Options keeps disabled fields visible behind explanatory guidance.
- Inline rename Save/Cancel ordering is not contractual.
- macOS native-fullscreen Escape remains a manual platform check.
- External extractor/authentication behavior stays in
  `scripts/network-smoke.sh`, outside deterministic automation.
- VLC is not installed without a codec-specific requirement.

Detailed setup and reproduction commands live in `tests/README.md`.
