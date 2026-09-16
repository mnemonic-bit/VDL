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

