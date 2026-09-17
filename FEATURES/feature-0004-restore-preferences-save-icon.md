# Restore the Preferences Save icon

**Source section:** Further things to add to the download helper
**Status:** Implemented
**Last refined:** 2026-09-17

## Decision summary

Use the Preferences Save button itself to provide short-lived confirmation of
a successful save. Replace its normal disk icon and **Save** label with a check
icon and **Saved** label, then restore the complete original button after 1.5
seconds.

Restoring both the label and the disk icon keeps the control's purpose clear
after the confirmation ends. The current 1.5-second interval supersedes the
four-second duration mentioned in the original note.

## Confirmed requirements

- Show the disk icon and **Save** label before a preferences save.
- Change the button to a check icon and **Saved** only after the server accepts
  the preferences.
- Disable the button while the success confirmation is visible so repeated
  clicks cannot start another save during that interval.
- Restore the disk icon, **Save** label, and enabled state after 1.5 seconds.
- Do not show the success state when the request fails. Leave the button ready
  to retry and surface the server's error separately.
- Use text as well as an icon for both states so the meaning does not depend on
  icon recognition alone.
- Reuse the shared `#i-save` and `#i-check` symbols from the page's icon
  library rather than embedding duplicate SVG paths in JavaScript.

## Relationship to Feature 0003

Feature 0003 controls the Save button's colours in each theme. This feature
controls its temporary content and enabled state. The restored disk icon uses
the button's current text colour, so it continues to follow Feature 0003's
theme styling.

## Implementation decisions

- The normal disk icon is rendered in the initial page markup, so it remains
  visible before JavaScript runs.
- A successful `POST /api/preferences` replaces the button contents with the
  shared check icon and **Saved** label and starts a 1.5-second timer.
- When the timer expires, JavaScript restores the shared disk icon and
  **Save** label before re-enabling the button.
- Failed saves use the common action-error presentation and do not start the
  confirmation timer.
- Browser regression coverage verifies the check icon, restored disk icon,
  re-enabled button, and absence of a false success state after a failed save.
