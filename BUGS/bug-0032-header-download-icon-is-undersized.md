## 32. [Resolved] Header download icon is undersized and its progress ring is too thin

**Severity:** Low

**Status:** Resolved in version `0.8.1` and refined through version `0.8.6` on
2026-09-27.

The download icon beside **Video Download Helper** is visually too small for
the header. Its surrounding aggregate-download progress ring is also too thin,
which makes the progress indicator less prominent than the title it belongs to.

Before resolution, the title rendered `.app-title-icon` at `1em` square. The
ring used a configured `stroke-width` of `1.2` in the icon's SVG coordinate
system.

### Reproduction

1. Open the main page at the default browser zoom and font size.
2. Compare the download icon with the **Video Download Helper** title.
3. Start a download so the blue aggregate-progress ring becomes visible.
4. Compare the ring weight with the icon and title.

**Actual:** The icon looks undersized beside the header text, and the active
progress ring is too fine.

**Expected:** The icon should be slightly larger, remain vertically centered
within the title row, and have a progress ring that is one pixel broader.

### Acceptance criteria

- Render the header icon at `1.3em` square instead of `1em` square.
- Preserve flex-based vertical centering. The icon's vertical midpoint must be
  within one CSS pixel of the title row's vertical midpoint at supported
  viewport widths; enlarging it must not shift the title or require a fixed
  positional offset.
- Increase the progress ring's configured stroke width by `1`, from `1.2` to
  `2.2`, while preserving its color, round line cap, progress direction, and
  percentage calculation.
- Keep a full ring track visible in the brand green while no downloads are
  active. When downloads are active, change that track to `#399748`, which is
  darker than the general accent but remains lighter than the brand green, and
  draw navy `#134d77` determinate progress over it.
- For active downloads with unknown size or zero progress, show the lighter
  green track without inventing blue progress.
- The larger icon and broader ring must not be clipped by the SVG viewport.
- Both light and dark themes must preserve the same ordering between the brand
  green, lighter active track, and darker blue progress stroke.

### Verification notes

- Add a browser assertion for the icon's computed `1.3em` size and its vertical
  midpoint relative to the title row.
- Extend the existing header-progress browser coverage to assert the `2.2`
  stroke width, the green idle track, the lighter active track, and the blue
  determinate overlay.

### Resolution

The header icon now renders at `1.3em` square while retaining the title row's
flex centering. The progress ring uses a `2.2` stroke width, and the SVG
viewport expands symmetrically so the broader stroke is not clipped. A
separate full-circle track stays brand green while idle, changes to a lighter
green while downloads are active, and remains beneath the blue
determinate-progress stroke. The active green and blue were subsequently
darkened to improve their visual separation without making the track darker
than the icon. A further contrast pass made the progress stroke substantially
darker so it remains unmistakable against the track, then a small lightening
adjustment balanced that separation against the stroke's visibility. Browser
feedback then slightly darkened the active track while preserving its lighter
relationship to the icon. Coverage locks down the size, centering, colors,
stroke width, viewport fit, and idle, indeterminate, and determinate progress
behavior.
