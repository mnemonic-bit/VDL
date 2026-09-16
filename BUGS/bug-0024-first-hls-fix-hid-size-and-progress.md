## 24. [Resolved] First HLS stabilization fix hid size and progress

**Severity:** Medium

**Status:** Resolved in version `0.2.19` on 2026-09-16.

The first fix for issue 23 stopped consuming `total_bytes_estimate` during
active downloads. HLS formats without an exact `total_bytes` value therefore
lost their **Total size** entirely and changed from a determinate percentage
bar to the indeterminate **Downloading** state. This removed useful feedback
and was a worse user experience than the original fluctuating estimate.

A deterministic reproduction sends the progress hook a `downloading` payload
with 400 MiB downloaded and an 800 MiB `total_bytes_estimate`. The first fix
stored a null `filesize` and the text `Downloading`; the expected useful state
is an approximately 800 MiB total and 50.0% progress. Consecutive estimate
updates are required to verify that restoring those values does not also
restore issue 23's jitter.

**Expected:** Keep estimated totals and determinate progress visible. Smooth
short-lived fragment variation, follow sustained changes over time, and never
move the displayed percentage backward solely because the estimate increased.
Exact totals and the final on-disk size remain authoritative.

**Resolution:** The backend now keeps a per-download exponentially weighted
moving average with a 10% update weight. It publishes a revised total only when
the average moves by at least 0.5% or 1 MiB, whichever is larger, and prevents
estimate revisions from decreasing displayed progress. Smoothing resets for a
new stream or completed worker; exact totals bypass it, and final completion
still records the filesystem size. The regression test holds the displayed
total steady across small 794-806 MiB revisions, verifies convergence toward a
sustained 820 MiB estimate, and checks monotonic percentage progress.

