# Remove the circle from the copy confirmation

**Source section:** Further things to add to the download helper
**Status:** Implemented
**Last refined:** 2026-09-17

## Decision summary

After a download URL is copied, replace that row-menu action's copy icon and
**Copy URL** label with a plain check icon and **Copied** label. Do not place
the check inside a green circle. Restore the normal copy action after 1.5
seconds.

The confirmation stays inside the menu action that initiated the copy, keeping
the feedback next to the user's action without adding a toast or changing the
rest of the download entry.

## Confirmed requirements

- Offer **Copy URL** from a download entry's row menu wherever that action is
  available.
- Copy the entry's stored URL rather than rebuilding or normalising it.
- Show confirmation only after the clipboard operation completes.
- Use the shared plain `#i-check` symbol for confirmation; do not use
  `#i-check-circle` or add a coloured circular background.
- Pair the check icon with the **Copied** label so confirmation does not rely
  on colour or iconography alone.
- Keep the confirmation visible for 1.5 seconds, then restore the copy icon and
  **Copy URL** label.
- If another copy completes before restoration, restart the timer so the most
  recent action receives a full confirmation interval.
- Support the modern Clipboard API in secure browser contexts and retain the
  existing hidden-textarea fallback for other contexts.

## Relationship to Feature 0004

Features 0004 and 0005 use the same plain check symbol and the same 1.5-second
feedback duration, but they remain independent controls. Saving preferences
temporarily disables the Save button; copying a URL leaves the row-menu action
available so another copy can refresh its confirmation timer.

## Implementation decisions

- The normal and confirmed menu contents are defined once as **Copy URL** with
  `#i-copy` and **Copied** with `#i-check`.
- The timer belongs to the clicked menu button. Confirmation therefore remains
  scoped to the download entry from which the URL was copied.
- Starting a new confirmation on the same button clears its previous timer
  before scheduling restoration.
- The check symbol contains only the tick path and inherits the menu action's
  current colour; it has no circle of its own.
- Browser regression coverage verifies the clipboard contents, the plain check
  symbol, and restoration of the original action after the timer expires.
