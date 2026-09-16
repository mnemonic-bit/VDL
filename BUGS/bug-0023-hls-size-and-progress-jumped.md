## 23. [Resolved] Estimated HLS size and progress jump during download

**Severity:** Medium

**Status:** Resolved on 2026-09-16.

While downloading `https://www.youtube.com/watch?v=G3jvn7n-68Y` as format
`625` (2160p), the Current tab's Total size changed on nearly every update and
the progress percentage sometimes moved backward. Sixteen API samples over
eight seconds produced sixteen different totals between 835.2 MB and 858.4 MB;
for example, progress changed from 66.7% to 66.2% while the reported total
increased from 836,352,172 to 846,237,715 bytes.

Format `625` is a single `m3u8_native` video stream with no declared filesize.
For fragmented downloads, yt-dlp supplies `total_bytes_estimate` and
recalculates it from the average size of the fragments received so far. The
progress hook treats that changing estimate like an exact `total_bytes` value,
uses it as the percentage denominator, and persists it in `filesize`. The
frontend then presents the value as **Total size** without indicating that it
is an estimate.

A deterministic minimal reproduction sends the real progress hook two
`downloading` payloads for the same row and downloaded-byte count, first with
`total_bytes_estimate=800` and then with `total_bytes_estimate=725`. The stored
`filesize` changes from 800 to 725 and the displayed progress changes from
50.0% to 55.2%.

The affected live download completed successfully. Its final database size
and actual file size both became the authoritative 818,715,111 bytes, so this
does not indicate media corruption.

**Expected:** Keep showing estimated total size and determinate progress, but
stabilize the estimate so fragment-to-fragment revisions do not make either
value dance. The displayed estimate should follow a sustained change and
converge to the final authoritative size over the life of the download.

**Resolution:** Estimated totals now pass through an exponentially weighted
moving average and a display deadband. Small revisions do not alter the shown
total, sustained changes converge in measured steps, and estimated progress is
kept monotonic. Exact totals still bypass smoothing, and the completed output's
filesystem size remains authoritative after post-processing. Both estimate and
exact-total behavior are covered by the download-lifecycle suite.

