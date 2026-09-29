## 38. [Resolved] History info panel had inconsistent layout and no source-copy action

**Severity:** Low

**Status:** Resolved and verified in version `0.16.3` on 2026-09-29.

The History card's Info popover mixed several small layout and interaction
problems that weakened its hierarchy and made editing feel unstable:

- The `Info` heading had no identifying icon, used title case while the nearby
  section labels were uppercase, and had more space above it than between it
  and the first content line.
- The File row appeared after Status and Source instead of directly after Tags.
  Its `File` label aligned to the top of the 28-pixel rename control rather
  than its vertical center.
- Source displayed the stored URL but offered no direct copy action.
- Entering tag-edit mode replaced a 28-pixel display row with a 36-pixel input,
  causing the remaining popover content to jump downward.

### Reproduction

1. Open History and choose **Info** from a finished download's action menu.
2. Compare the heading's top inset with the gap below the heading.
3. Inspect the order and vertical alignment of Tags, Status, Source, and File.
4. Try to copy Source without opening the action menu.
5. Select the Tags field and watch the rows below it move.

**Actual:** The heading hierarchy and spacing were uneven, File was separated
from Tags and misaligned with its rename field, Source lacked an inline copy
control, and activating Tags changed the panel's height.

**Expected:** The popover should have a clear, balanced heading; present File
between Tags and Status; align the File label with its control; copy Source in
place; and keep the Tags row at a stable height when editing begins.

### Acceptance criteria

- Prefix the uppercase `INFO` heading with the shared `#i-info` icon instead of
  duplicating SVG paths.
- Keep the heading's top inset within one CSS pixel of the gap to the title
  line below it.
- When a filename exists, order the relevant rows as Tags, File, Status, then
  Source.
- Keep the vertical midpoint of the `File` label within one CSS pixel of the
  rename control's midpoint.
- Add an accessible **Copy source URL** button beside Source. It must copy the
  original stored URL, show the existing checkmark confirmation, and restore
  its original icon and accessible label after the confirmation interval.
- Keep the Tags display row and active token input at the same height so
  entering edit mode does not shift later content.
- Preserve data-attribute URL handling and HTML escaping for untrusted stored
  URLs; the new control must not introduce an inline JavaScript URL sink.

### Resolution

The popover now uses the shared circled-info symbol beside an uppercase
`INFO` heading, with a reduced top inset that balances the following gap. File
is rendered first in the metadata group, immediately after Tags, and its label
uses center alignment with the inline rename control. Source now includes a
compact copy button that reuses the existing clipboard path and temporarily
changes to the shared check icon without expanding the row. The copy helper
preserves and restores each invoking button's original markup, title, and
accessible label, so it supports both the full action-menu button and the new
icon-only control. Finally, the Tags display row uses the editor's 36-pixel
minimum height and matching padding, eliminating the mode-change jump.

Permanent coverage: `tests/browser/history-actions.spec.cjs` verifies the
heading text and icon, balanced spacing, row order, File-label centering,
equal Tags heights, clipboard contents, confirmation icon, and safe
data-attribute URL handling. The complete History-actions and Tags browser
suites passed with 21 tests, and the Python suite passed 87 tests with four
opt-in real-media tests skipped.
