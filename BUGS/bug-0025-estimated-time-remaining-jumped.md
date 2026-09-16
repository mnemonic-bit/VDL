## 25. [Resolved] Estimated time remaining jumped between updates

**Severity:** Medium

**Status:** Resolved in version `0.2.20` on 2026-09-16.

The Current tab persisted and displayed every yt-dlp `eta` sample verbatim.
Short-lived transfer-rate changes therefore made the estimated time remaining
jump both forward and backward even after total-size smoothing stabilized the
neighboring progress display.

A deterministic reproduction submits five progress payloads one second apart
with ETA values of 120, 128, 116, 125, and 114 seconds. Before the fix, those
five values appeared unchanged in the API. A stable presentation should count
down from 120 to 116 seconds because their predicted completion times remain
within the normal noise band.

**Expected:** Keep ETA visible and naturally counting down, suppress small
completion-time revisions, and follow a sustained change in the prediction
without one large jump.

**Resolution:** ETA smoothing now operates on predicted completion timestamps
rather than directly averaging remaining seconds. A 10% exponentially weighted
moving average follows the prediction, while a 5-second or 5% deadband,
whichever is larger, suppresses noise. The filter resets across pauses, new
streams, and completed workers. Regression coverage verifies a steady countdown,
bounded adjustments, and convergence toward a sustained revised completion
time.

