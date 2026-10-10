# Show item progress around the primary action icon and compact row metadata

**Source:** User-requested feature
**Status:** Implemented
**Last refined:** 2026-09-27

## Decision summary

Replace the horizontal progress bar in each current download row with a compact
progress ring around that row's primary action icon. While a download is
starting or downloading, the ring surrounds a pause glyph formed by two
vertical bars within the same square footprint. When the download is paused,
cancelled, or interrupted, the same ring surrounds the play icon in the
`Resume` or `Continue` control at the last reported progress.

The ring follows the header application's progress-ring behavior: it starts at
twelve o'clock, advances clockwise, uses the row's byte counts for determinate
progress, and becomes a complete circle at 100%. Its stroke inherits the
button icon's `currentColor`, ensuring that the ring and icon always have the
same colour in normal, hover, focus, and paused states.

Current rows use one compact summary line for total size, quality, and
downloaded percentage, with ETA aligned at the far right. Status, source URL,
and warning-triangle rows are intentionally omitted; URL actions remain in the
three-dot menu.

History rows use compact paired metadata lines: quality, size, and a readable
requested format, then the start date and time with a human-readable duration.
The raw format ID and finished timestamp are not displayed separately.

## Follow-up refinements included

The implemented feature includes the original progress-ring change and the
subsequent UI refinements made during review:

1. Enlarge the row ring to 22 pixels and centre the pause/play glyph within it.
2. Add the same per-item ring to the paused `Resume` and resumable `Continue`
   actions, preserving the last reported progress.
3. Make `Stop` and `Continue` icon-only, and depict the running action with a
   square-footprint pause glyph made from two separated vertical bars.
4. Remove Current-row status, visible URL, and paused-state warning metadata.
5. Put total size, quality, and downloaded percentage on one Current-row line,
   with ETA at its far-right edge.
6. Put History quality, size, and requested format on one metadata row; put the
   local start date/time and human-readable duration on the next row.
7. Replace bare requested-format IDs and known selector expressions with
   readable descriptions derived from persisted format metadata.

## Confirmed requirements

- Remove the horizontal progress bar from rows whose status is `starting`,
  `downloading`, `paused`, `cancelled`, or `interrupted`.
- Show the item's progress around the primary action icon instead:
  - `starting` and `downloading`: ring around the square pause glyph in the
    icon-only `Stop` button;
  - `paused`: ring around the play triangle in the `Resume` button;
  - `cancelled` and `interrupted`: ring around the play triangle in the
    icon-only `Continue` button.
- Preserve the last reported ring position while an item is paused. Pausing
  must not reset, hide, or advance determinate progress.
- Restore the pause-glyph presentation, with the same progress value, when a
  paused item resumes downloading.
- Begin the progress stroke at twelve o'clock and advance it clockwise.
- Show no completed progress stroke at 0%, half the circumference at 50%, and
  an unbroken circle at 100%.
- Make the progress stroke the same colour as the button icon by using
  `currentColor`; do not introduce a separately hard-coded ring colour.
- Keep the ring and glyph visually distinct. A low-opacity track may use the
  same inherited colour, but it must not be mistaken for completed progress.
- Render the progress SVG at 22 pixels square while retaining the existing
  32-pixel button height. Centre the shared 16-by-16 glyph viewport exactly on
  the ring centre so pause and play artwork do not drift within the circle.
- Remove the visible `Stop` and `Continue` labels and render those controls as
  compact 32-by-32-pixel icon buttons. Keep the visible `Resume` label,
  endpoint behavior, menu actions, and keyboard interaction unchanged.
- Remove the `Status` line from Current-tab download rows. Preserve ETA,
  total-size, quality, and other metadata. Add `Downloaded: NN%`, derived from
  the same byte-based percentage as the progress ring, to the summary line
  beside total size and quality. Keep ETA aligned to the far-right end of that
  line.
- Remove the visible URL line from Current-tab download rows. Keep `Open URL`
  and `Copy URL` in the three-dot menu.
- Do not show an action-required warning triangle before the summary for
  paused, cancelled, or interrupted items.
- In History, place `Quality`, `Size`, and `Requested format` on one
  middle-dot-separated line.
  Place `Started` and `Duration` on the next line, showing the local start date
  and time but not the finished timestamp.
- Describe requested formats with persisted format metadata instead of exposing
  a bare extractor-specific ID when possible. Give common selectors readable
  labels, support concrete multi-stream IDs, and retain an unknown selector as
  the fallback.
- Express History duration with at most the two most significant non-zero
  units, using full singular or plural unit names joined by `and`.
- Recalculate the ring whenever the row is reconciled after an SSE event or
  history fetch. Do not add polling or a separate animation timer.
- Treat the ring as decorative. Give icon-only controls explicit accessible
  names and matching hover titles (`Stop` and `Continue`); the visible
  `Resume` text remains that control's accessible name. The `Downloaded`
  summary remains the accessible textual progress description.

## State behavior

| Item status | Primary action | Ring behavior | Visible row metadata |
|---|---|---|---|
| `starting` | Icon-only `Stop` action with pause glyph | Show track; draw determinate progress when byte totals are usable | Available size/quality, downloaded percentage, and right-aligned ETA |
| `downloading` | Icon-only `Stop` action with pause glyph | Show track and update the clockwise progress stroke | Available size/quality, downloaded percentage, and right-aligned ETA |
| `paused` | Labelled `Resume` action with play icon | Show track and freeze the stroke at the last reported progress | Available size/quality and frozen downloaded percentage; no warning triangle |
| `cancelled` / `interrupted` | Icon-only `Continue` action with play icon | Show track and freeze the stroke at the last reported progress | Available size/quality and frozen downloaded percentage; no warning triangle |
| `finished` / `error` | Existing History actions | No action-icon ring | Group quality/size/requested format and started/duration into two compact lines |

No Current state renders the former horizontal progress bar.

The stop action in a paused row remains available in the overflow menu. Its
menu icon does not receive a ring: progress belongs to the row's always-visible
primary action, not to every use of the shared stop symbol.

## Current-row metadata

Current rows omit the former `Status` and URL lines. When present, summary
values appear in this order:

```text
Total size: ... · Quality: ... · Downloaded: NN%                 ETA
```

- Omit total size or quality independently when its value is unavailable.
- Always show `Downloaded`; use an em dash when byte totals cannot produce a
  determinate percentage.
- Show ETA only for `starting` and `downloading`, aligned to the far-right edge
  of the summary line.
- Do not prefix the summary with a warning triangle in paused, cancelled, or
  interrupted states.
- Keep `Open URL` and `Copy URL` available from the three-dot menu even though
  the source URL is not printed in the row.

## History-row metadata

Finished and error rows group related values instead of placing every field on
its own line:

```text
Quality: 2160p · Size: 2.0 GB · Requested format: 2160p 60fps MP4 video
Started: 27/09/2026, 14:30 · Duration: 11 Hours and 35 Minutes
```

- Format `Started` with the browser's local date and time conventions.
- Calculate `Duration` as `finished_at - created_at`, rounded to the nearest
  second. Do not display `finished_at` as a date and time.
- Use days, hours, minutes, and seconds with correct singular/plural forms.
- Show at most two non-zero units, from largest to smallest, joined by `and`.
  Examples: `1 Day and 5 Hours`, `11 Hours and 35 Minutes`, and
  `3 Minutes and 45 Seconds`.
- Omit an unavailable quality or size without leaving a separator. Omit
  requested format independently when unavailable. Omit duration when either
  timestamp is missing or the finish precedes the start.
- Resolve a concrete requested format ID against the persisted format table and
  describe its available resolution, frame rate, container, and stream type.
  For example, ID `625` may render as `2160p 60fps MP4 video`. Numeric IDs that
  cannot be resolved render as `Format 625` rather than as unexplained digits.
- Resolve every component of a concrete multi-stream request when all component
  IDs are available, joining their readable descriptions with `+`. If any
  component cannot be resolved, retain the original selector rather than
  presenting a partially inferred description.
- Render known selectors as readable phrases, including `Best available`,
  `Best available audio`, `Best available video + audio`, and
  `Up to 720p video + audio`. Preserve an unknown non-numeric selector verbatim
  because interpreting arbitrary yt-dlp selector syntax could be misleading.
- Keep `Quality` and `Requested format` semantically distinct: quality reports
  the resulting file's resolution, while requested format describes the input
  selector or source stream requested from yt-dlp.
- Use the same readable requested-format formatter anywhere that field remains
  visible, including paused Current rows, while grouping it into the media row
  only in History.

## Progress calculation

Calculate each row independently from its persisted byte fields:

```text
item progress = downloaded_bytes / total_bytes
```

- Require a finite, positive `total_bytes` value for determinate progress.
- Clamp `downloaded_bytes` to the range from zero through `total_bytes` before
  calculating the percentage.
- Treat a missing or non-finite `downloaded_bytes` value as zero when a usable
  total exists, matching the header aggregate's existing calculation.
- Do not parse the human-readable `progress` string as the authoritative
  value and do not derive an item's ring from the header's aggregate.
- Round only the value exposed for rendering or test inspection; retain the
  underlying byte ratio for the calculation.
- If the total is missing or unusable, show only the track and display
  `Downloaded: —`. Do not animate a sweeping arc or imply a measurable
  percentage.

The existing `/api/history` contract already supplies `downloaded_bytes` and
`total_bytes` for current entries. The implementation reuses those fields and
does not add a route, database column, or worker-state change.

## Relationship to the header progress ring

Feature 0016 remains the source of the visual and mathematical conventions:
twelve-o'clock origin, clockwise direction, clamped byte-based progress, and
no determinate arc when the total is unknown. The header ring continues to
show byte-weighted aggregate progress across all active items; each row ring
shows only that row's progress.

The two presentations must not share mutable DOM state. They may share a small
pure helper that validates byte counts and returns a clamped percentage so the
calculation rules cannot drift.

## Implementation

- `static/app.js` uses a pure per-item byte calculation shared by the action
  ring and downloaded-percentage summary.
- The active row's primary icon is one SVG containing the existing
  shared `#i-pause` or `#i-play` symbol plus track and progress circles. The
  progress circle has `pathLength="100"` and a `-90`-degree rotation around the
  icon centre.
- The nested shared-symbol `<use>` has an explicit `16`-unit width and height,
  keeping its centre at `(8, 8)` inside the expanded progress view box. The
  complete progress SVG renders at 22 pixels square.
- The percentage is applied as `stroke-dashoffset: 100 - percentage`. The SVG
  view box includes the complete stroke so the ring is not clipped.
- CSS classes define the track and progress strokes. Both derive from
  `currentColor`; the track uses reduced opacity and the progress stroke uses
  full opacity. Keep fills off the circles so the action glyph remains clear.
- `.progress-bar-bg` markup is absent from active and resumable current rows.
  Finished and error rows do not receive an action-icon ring.
- Paused rows remain in the active progress path and use the same compact
  summary layout as running and resumable rows.
- URL values remain in escaped data attributes used by three-dot-menu actions;
  they are not emitted as visible row text.
- History metadata builds one quality/size/requested-format row and one
  started/duration row.
  A frontend duration formatter converts the persisted timestamp difference
  into at most two human-readable units.
- A frontend format formatter resolves concrete IDs against the persisted
  format table, resolves fully known multi-stream requests, and translates the
  selectors generated by the UI. It does not make another network request.

## Acceptance criteria

- A downloading row at 25 of 100 bytes has no horizontal progress bar and has
  a ring covering 25% of the pause icon's circumference clockwise from twelve
  o'clock.
- At 50%, the ring covers half of the circumference; at 100%, it forms a
  complete, unclipped circle without a visible seam.
- The progress stroke's computed colour matches the action glyph's computed
  colour in light theme, dark theme, hover, and keyboard-focus states.
- Pausing a row at 40% changes the primary action from `Stop` to `Resume` but
  leaves a 40% ring visible around the play icon. The value does not advance
  while subsequent paused-state reconciliations retain the same byte counts.
- Resuming that row changes the glyph back to the pause symbol without
  resetting the ring, and later SSE updates advance it from the stored value.
- Cancelling or interrupting a row changes the primary action to `Continue`
  while preserving the last progress around its play icon and without
  restoring a horizontal progress bar.
- A starting or downloading row with no usable total shows the track but no
  determinate arc or indeterminate sweep; its final line reads
  `Downloaded: —`.
- Current-tab rows do not show a `Status` field. Their last metadata line reads
  `Total size: ... · Quality: ... · Downloaded: NN%` when those values are
  available, including while paused, cancelled, or interrupted. ETA sits at
  the far-right end of that line.
- Current-tab rows do not display their source URL. The URL remains reachable
  through `Open URL` and `Copy URL` in the three-dot menu. Paused, cancelled,
  and interrupted rows do not add a warning triangle before the summary.
- The ring never renders below 0% or above 100%, even when upstream byte counts
  are negative or exceed the total.
- `Stop` and `Continue` have no visible text, remain discoverable through
  `aria-label` and `title`, and occupy a 32-by-32-pixel button. `Resume` keeps
  its visible label. All three retain their accessible names and API actions.
- The progress SVG renders at 22 pixels square, and the pause or play glyph is
  geometrically centred on the ring in every applicable state.
- Paused-row overflow actions, including `Stop`, remain unchanged and do not
  receive duplicate progress rings.
- Finished and error rows do not gain a progress ring.
- Header and favicon progress behavior from Feature 0016 remains unchanged.
- History rows show quality, size, and a readable requested format together,
  followed by start date/time and duration together. They do not show a
  separate requested-format row or finished timestamp.
- A stored concrete format ID such as `625` renders from its stored descriptor,
  for example as `2160p 60fps MP4 video`; an unresolved numeric ID renders as
  `Format 625`.
- Known format selectors use readable phrases, while unknown non-numeric
  selectors remain intact and are never partially interpreted.
- Durations render as `1 Day and 5 Hours`, `11 Hours and 35 Minutes`, and
  `3 Minutes and 45 Seconds` for the corresponding timestamp differences.

## Verification

Extend `tests/browser/live-updates.spec.cjs` to cover:

- absence of the horizontal bar for each active status;
- absence of Current-tab status text, placement of `Downloaded: NN%` beside
  total size and quality, and far-right alignment of ETA on that line;
- absence of visible Current-tab URLs while the three-dot `Open URL` action
  remains available;
- per-item byte calculation, clamping, ring geometry, and stroke direction;
- colour inheritance from the primary action icon;
- the stop-to-resume-to-stop icon transition without progress loss;
- unknown-total behavior without an indeterminate animation;
- cancelled/interrupted `Continue` rings and unchanged action endpoint behavior;
- continued header and favicon aggregation behavior.

Extend `tests/browser/history-actions.spec.cjs` to cover:

- grouped History metadata and representative day/hour/minute/second duration
  formatting.
- readable concrete format IDs and known format selectors on the History media
  line.

Run the fast backend suite and the deterministic browser tier:

```bash
./tests/run-all.sh --unit
./tests/run-all.sh --browser
```

Manually inspect a running and paused item in both themes at narrow and wide
viewports. Confirm that the ring is not clipped, the labelled `Resume` control
is not crowded, and every state remains legible through hover and keyboard
focus. Inspect finished and error rows to confirm their two metadata groups are
ordered correctly and long requested-format descriptions remain readable.
