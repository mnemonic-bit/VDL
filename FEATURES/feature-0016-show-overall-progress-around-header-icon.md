# Show overall download progress around the header icon

**Source:** User-requested feature
**Status:** Implemented
**Last refined:** 2026-09-25

## Decision summary

Turn the application icon introduced by Feature 0015 into a compact indicator
of overall download progress. While downloads are active, draw a blue progress
line around the icon. The line begins at the twelve-o'clock position, advances
clockwise, and forms a complete circle at 100%.

Calculate the displayed percentage from bytes, not by averaging the individual
downloads' percentages. Add together the current downloaded-byte counts for all
active downloads and divide that value by the sum of their total byte counts:

```text
overall progress = sum(downloaded bytes) / sum(total bytes)
```

This makes a large download contribute proportionally more than a small one
and gives the ring a direct interpretation: it shows what fraction of the
combined payload has been downloaded.

## Confirmed requirements

- Draw the progress indicator as a blue line encircling the green application
  icon in the main page header.
- Start the line at twelve o'clock and advance it clockwise as progress
  increases.
- Show no blue progress line at 0%, half of the circumference at 50%, and an
  unbroken blue circle around the icon at 100%.
- Keep the green disc, white download arrow, and white baseline legible inside
  the progress line.
- Include every active download in the aggregate: `starting`, `downloading`,
  and `paused` entries all represent unfinished work.
- Calculate the numerator as the sum of each active download's latest
  `downloaded_bytes` value.
- Calculate the denominator as the sum of each active download's latest
  positive `total_bytes` value.
- Clamp each downloaded-byte value to the range from zero through its total so
  malformed or transient upstream values cannot draw less than 0% or more than
  100%.
- Do not use an arithmetic mean of per-download percentages and do not give
  downloads equal weight. Their byte totals determine their contribution.
- Recalculate the aggregate whenever live download state is reconciled, so SSE
  updates change the ring without polling or a page reload.
- Restore the plain icon from Feature 0015 when no downloads are active.
- If any active download lacks a usable positive total, do not display a
  determinate ring. Showing progress for only the known-size subset would not
  represent the total of all active downloads.
- Keep the icon decorative for assistive technology. The download rows remain
  the accessible source of detailed progress information.

## Relationship to Feature 0015

Feature 0015 defines the header icon's design, placement, scale, and accessible
presentation. This feature adds a dynamic outer progress line without changing
the icon artwork or the adjacent heading text. The complete icon, including
its progress line, must continue to scale with the heading's text size.

## Data contract

The browser needs the underlying byte counts rather than a percentage string
rounded for display. Each active entry returned by `/api/history` must expose:

- `downloaded_bytes`: the latest non-negative byte count reported by yt-dlp;
- `total_bytes`: the current positive total used for progress calculation.

Prefer yt-dlp's exact `total_bytes`. When only `total_bytes_estimate` is
available, use the application's existing smoothed total estimate so the ring
does not jump backward as raw HLS estimates fluctuate. If neither value can
produce a positive total, the aggregate remains indeterminate.

Persist the latest values with the download entry so a history reconciliation
and a newly opened page receive the same progress state as an SSE-triggered
refresh. Add any required SQLite columns through `init_db()`'s migration list,
not the initial `CREATE TABLE`, so existing databases upgrade in place.

## Implementation decisions

- Render the progress line as a separate, unfilled SVG circle around
  `#i-app-download`; do not replace or recolour the icon's green disc.
- Rotate the circle's stroke origin to twelve o'clock and use its dash length
  to represent the clamped aggregate fraction. A 100% value must render as a
  closed circle without a visible seam.
- Leave enough room in the SVG view box for the stroke so the browser does not
  clip the blue line.
- Define a theme-aware CSS custom property for the progress blue rather than
  hard-coding the colour in update logic.
- Put the byte aggregation in one browser function. The existing dynamic
  favicon may consume the same aggregate, but the header ring must not maintain
  a second calculation that can drift from it.
- Preserve the most recent byte counts while a download is paused. Pausing
  stops the ring from advancing but does not remove that download from the
  aggregate.

## Acceptance criteria

- With one 1,000-byte active download at 250 downloaded bytes, the ring covers
  25% of the circumference clockwise from twelve o'clock.
- With active downloads at 100 of 200 bytes and 100 of 800 bytes, the ring
  covers 20%, derived from `200 / 1,000`, rather than the 31.25% arithmetic
  mean of their individual percentages.
- At 100%, the blue line forms a complete circle around the icon and does not
  obscure the icon artwork.
- Pausing a download leaves its bytes in the aggregate and freezes the ring at
  the last reported value until progress resumes or the active set changes.
- If any active download has no usable total, the header shows the plain icon
  rather than a misleading determinate percentage.
- When the last active download leaves the active set, the progress line is
  removed and the plain Feature 0015 icon remains.
- Browser regression coverage verifies byte-weighted aggregation, the
  twelve-o'clock origin, clockwise direction, the complete 100% circle, the
  indeterminate fallback, paused-download handling, and live reconciliation.
