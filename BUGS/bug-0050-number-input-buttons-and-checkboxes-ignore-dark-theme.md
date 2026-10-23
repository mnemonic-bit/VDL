## 50. [Resolved] Number-input buttons and checkboxes do not match the dark theme

**Severity:** Low — visual inconsistency

**Status:** Resolved in 0.46.3; reported on 2026-10-21, reproduced and fixed on 2026-10-23.

In dark mode, some form controls retain light backgrounds even though the
surrounding page and input fields use the dark theme. The reporter observed
this on the up/down buttons of numeric inputs, including **Max concurrent
downloads**, and on unchecked checkboxes. Checked checkboxes have a green
background, but clearing the check returns the background to white.

### Reproduction to confirm

1. Open **Settings** and select the application's dark theme.
2. Locate **Max concurrent downloads** and inspect its increment/decrement
   buttons. Hover over the field if the browser only reveals them on hover.
3. Locate a checkbox and compare its unchecked and checked appearances by
   toggling it. Restore its original value afterward.
4. Switch between light and dark themes and repeat the comparison.

**Reported actual:** Numeric-input up/down buttons remain light in dark mode.
Checkboxes are green when checked and white when unchecked, leaving the
unchecked state visually inconsistent with the dark page.

**Expected:** Numeric-input buttons and both checkbox states should follow the
selected page theme. In dark mode, unchecked checkboxes and numeric stepper
backgrounds should use appropriate dark surfaces, with visible borders,
arrows, check marks, and focus indicators. Checked checkboxes may retain the
application's green accent.

### Scope and verification notes

- Review numeric inputs and checkboxes throughout the application, using the
  reported Settings field as the initial reproduction case.
- Browser, browser version, operating system, and application version were
  not supplied with this report. Record them when confirming the issue;
  browser-rendered form controls may differ across environments.
- The cause has not been established. Confirm the rendered appearance in a
  real browser before choosing a styling change.

### Acceptance criteria

- Numeric increment/decrement buttons match the selected light or dark theme
  and remain visible and functional.
- Unchecked checkboxes use a dark-theme surface in dark mode; checked states
  retain a clear check mark and an appropriate application accent.
- Theme changes update these controls without requiring a page reload, and
  the correct appearance persists after reloading with the saved theme.
- Hover, focus, and disabled states remain distinguishable, and keyboard
  operation continues to work.
- Verify both themes in the reporting browser and supported browser engines;
  include visual inspection of native controls rather than relying solely on
  computed CSS values.

### Cause and resolution

The page changed its custom colors through `data-theme` but never set CSS
`color-scheme`. Native controls therefore kept the browser's default light
rendering inside the dark page. The initial Chromium regression failed with
`color-scheme: normal` on **Max concurrent downloads**.

The root now declares `color-scheme: light`, with `color-scheme: dark` on the
existing dark-theme selector. Native number steppers and checkboxes inherit
the selected theme throughout the application. Their native behavior and the
existing green checkbox accent remain intact; the existing theme switch also
updates these native surfaces immediately.

### Verification

- Reproduced against 0.46.2 on Linux 6.12.95 x86_64 using Chromium
  153.0.8010.12. The original reporter's browser and operating system remain
  unknown.
- `tests/browser/settings-controls.spec.cjs` passed both tests in Chromium
  153.0.8010.12, Firefox 155.0, and WebKit 26.6 (six passing cases total).
- Visually inspected screenshot attachments from every engine in both themes:
  hovered number steppers, focused unchecked and checked checkboxes, and
  disabled unchecked checkboxes. Dark steppers have dark surfaces with visible
  arrows; unchecked boxes have dark surfaces; checked boxes retain green
  backgrounds and visible check marks. Disabled checkboxes remain visibly dim.
  Light-theme controls retain appropriate light surfaces.
- Browser checks exercise ArrowUp/ArrowDown numeric input and Space checkbox
  operation, immediate light/dark switching, saved dark-theme appearance after
  reload, and live changes to the operating-system theme in system mode.
- The browser test retains screenshots as test attachments for visual review;
  computed `color-scheme` checks supplement that visual verification.
- Required unit gate: `./tests/run-all.sh --unit` passed with Python 3.12.14
  selected through `VDL_PYTHON` (319 tests, five optional
  media tests skipped); `vdl.py` line coverage is 91.4%, above the 90% minimum.
