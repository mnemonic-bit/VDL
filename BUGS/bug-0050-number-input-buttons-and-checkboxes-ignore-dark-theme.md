## 50. [Open] Number-input buttons and checkboxes do not match the dark theme

**Severity:** Low — visual inconsistency

**Status:** Open; reported on 2026-10-21. Not yet independently reproduced.

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

This report changes documentation only and does not change `VERSION`.
