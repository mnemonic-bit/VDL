## 26. [Resolved] Continued downloads began with a multi-day ETA

**Severity:** Medium

**Status:** Resolved in version `0.2.21` on 2026-09-16.

Immediately after continuing a paused or stopped download, yt-dlp can calculate
ETA from only the first small amount of post-continuation traffic. A download
with a previously reasonable ETA could therefore begin at six or seven days
remaining and take 10-20 seconds to settle.

The ETA smoother accepted an unbounded portion of that startup outlier. In a
deterministic reproduction, a download at five minutes remaining is paused and
continued, then receives one seven-day ETA sample. That single sample became a
stored ETA of 60,748 seconds (about 17 hours), so the moving average reduced the
error but did not make the starting value useful.

**Expected:** Continuing should retain the last reasonable ETA baseline. One
startup sample must not create a multi-hour or multi-day display, while a real
sustained slowdown must still move the estimate over time.

**Resolution:** Live pauses now shift the existing completion-time baseline by
the paused duration instead of discarding it. New Continue workers seed their
filter from the last persisted ETA. Each raw completion-time sample is bounded
to 25% of the displayed ETA or 30 seconds, whichever is larger, before entering
the existing moving average. This rejects isolated startup outliers without
preventing sustained estimates from converging. Regression coverage exercises
a seven-day post-pause sample followed by normal traffic.

