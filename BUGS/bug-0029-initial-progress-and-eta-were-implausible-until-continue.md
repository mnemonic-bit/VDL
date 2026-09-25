## 29. [Open] Initial progress and ETA are implausible until Stop and Continue

**Severity:** Medium

**Status:** Open; reported and observed on version `0.6.0` on 2026-09-19.

When a download begins, the Current tab can show arbitrary-looking progress
telemetry. Both the percentage in the parenthesized **Status** value and the
estimated time remaining can be implausible. Stopping the same download and
then selecting **Continue** makes both values settle to credible values, even
though the download uses the same URL, requested format, and partial output.

The behavior was demonstrated against the running container with a 2160p HLS
download using requested format `625`. The server log records one
Continue-to-Stop cycle followed by a second Continue-to-Stop cycle for the same
download entry. After the second cycle, `/api/history` reported `56.7%`, an ETA
of 286 seconds, and an estimated total of 781,118,201 bytes while the partial
media file was approximately 419 MiB. Those post-Continue values were
plausible. The earlier incorrect samples could not be recovered because the
database stores only the latest progress state and the server does not log
individual progress-hook payloads.

### Reproduction

1. Start or continue a download with no worker currently running for it.
2. Watch the download entry in the Current tab as its first progress updates
   arrive.
3. Observe the percentage shown in `Status: downloading (...)` and the ETA at
   the right of the status row.
4. Select **Stop**, then select **Continue** on the same download entry.
5. Compare the percentage and ETA after progress resumes.

**Actual:** The first worker run displays implausible or arbitrary-looking
percentage and ETA values. A Stop/Continue cycle makes the telemetry credible.

**Expected:** Percentage and ETA should be credible from the first worker run
and should not require Stop/Continue to initialize or correct their baselines.
Continuing the same partial download should not materially change either value
unless the underlying transfer rate or size estimate has genuinely changed.

### Investigation notes

- Capture the raw `downloaded_bytes`, `total_bytes`, `total_bytes_estimate`,
  `eta`, and fragment fields from the first worker and the continued worker.
  A regression reproduction needs to assert the originally observed bad
  values; the latest-value-only database is not sufficient by itself.
- Check whether the issue is limited to HLS/fragment downloads or also occurs
  with direct HTTP formats whose total size is exact.
- Compare estimator initialization on a fresh process, a recovered
  `interrupted` entry, and a same-process `cancelled` entry. The observed
  server sequence began with Continue after container startup, so process-local
  estimator state may be relevant, but no cause has yet been established.
- Keep progress and ETA smoothing enabled. A fix should correct initialization
  rather than hide determinate progress or remove the ETA.
