# Add the application icon to the page header

**Source:** User-requested feature
**Status:** Implemented
**Last refined:** 2026-09-25

## Decision summary

Show the application's established download icon immediately before the main
page heading. Use the same green disc and white download-arrow design as the
idle favicon so the browser tab and visible page share a consistent visual
identity.

Scale the icon with the heading text rather than assigning it a fixed pixel
size. The icon should remain aligned with the heading and retain the same
relative size when browser zoom, user font settings, or responsive styling
changes the heading's rendered size.

## Confirmed requirements

- Place the application icon directly before the main page-heading text.
- Match the idle favicon's green circular background, white download arrow,
  and white baseline.
- Size the icon to `1em` in both dimensions so it follows the heading's
  computed text size.
- Vertically centre the icon and heading text and leave a small, consistent
  gap between them.
- Render the icon in the initial page markup so it does not depend on
  JavaScript.
- Treat the icon as decorative and hide it from assistive technology; the
  adjacent heading text remains the accessible page label.
- Keep the icon visually consistent in both light and dark themes.
- Define the icon in the page's shared SVG symbol library and reference that
  symbol from the heading rather than duplicating its paths in the heading
  markup.

## Implementation decisions

- Add `#i-app-download` to the inline SVG definitions in
  `templates/index.html`. Its geometry and colours mirror the favicon's idle
  design.
- Render the heading as an icon-and-text flex row. The icon uses `width: 1em`,
  `height: 1em`, and `flex: none`; the row uses centred alignment and an
  `0.4em` gap.
- Use the shared `--brand` colour for the icon's disc in both themes. The arrow
  and baseline remain white, matching the favicon.
- Give the heading SVG `aria-hidden="true"` because it adds visual identity,
  not information beyond the heading text.

## Acceptance criteria

- On initial page load, the favicon design appears directly before the main
  heading text without waiting for client-side JavaScript.
- The icon's height tracks the heading's font size at normal and zoomed text
  scales.
- The icon and text remain vertically aligned with visible separation in both
  themes.
- A screen reader announces only the heading text, not a redundant icon label.
