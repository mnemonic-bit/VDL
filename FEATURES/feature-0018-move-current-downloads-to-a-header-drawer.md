# Move current downloads to a header drawer

**Source:** User-requested feature
**Status:** Implemented
**Last refined:** 2026-09-27
**Supersedes:** The Current-tab requirements in Feature 0017

## Decision summary

Remove the Current and Download History tab navigation. Download History is the
permanent primary view, while Current downloads opens from a persistent control
beside Settings in the fixed header. Present Current downloads in a
top-aligned, right-side drawer so live work remains easy to find without taking
space from the downloaded-content library.

Keep starting a new download prominent above Download History. Give the URL
form a visible `New download` heading and provide an onboarding action in an
empty history that returns keyboard focus to the URL field.

This feature supersedes Feature 0017's requirement to keep Current available
as a tab. It does not change the statuses or actions shown in Current.

## User flow

### Initial visit

- Open directly on Download History; there is no selected-tab state.
- Keep the New download form above the history library so the application's
  primary action remains discoverable.
- Keep the Current downloads header control visible even when its list is
  empty, allowing a new user to discover where active work will appear.
- If History is empty, explain that the user can begin by pasting a URL and
  provide a direct action that moves focus to the URL field.

### Starting and monitoring a download

- Submit the existing URL form without changing its validation or option
  behavior.
- When the server accepts the download, open the Current downloads drawer and
  show the newly starting row as soon as the reconciled history response
  contains it.
- Keep status, progress, speed, ETA, metadata, tags, and available row actions
  current through the existing SSE refresh path.
- Keep the drawer open as entries move between active and resumable Current
  states. Finished and failed entries leave Current and appear in Download
  History according to the existing status vocabulary.

### Opening and closing the drawer

- Open the drawer from the persistent Current downloads header control.
- Treat the drawer as modal while open so focus and interaction stay with the
  current-download workflow.
- Close it with the X control, Escape, or an interaction on the backdrop.
- Return focus to the header control when the drawer closes.
- Keep the drawer header fixed while its list scrolls independently.

## Confirmed requirements

- Remove the tab bar and show Download History as the page's permanent main
  content.
- Add a `Current downloads` control immediately before the Settings cog in the
  fixed header.
- Keep that control visible when there are no current entries.
- Display the number of Current entries as a badge when the count is non-zero.
- Include `starting`, `downloading`, `paused`, `cancelled`, and `interrupted`
  entries in the drawer, preserving their complete metadata and actions.
- Do not apply the Download History tag filter to Current entries; the drawer
  must always contain the complete Current list.
- Open the drawer from the right edge, aligned immediately below the fixed
  header rather than rising from the bottom of the viewport.
- Use a 480 px maximum width on larger screens and the full viewport width on
  small screens.
- Give the drawer its own scrolling body so its header and close action remain
  available with a long Current list.
- Show action errors inside the open drawer rather than behind its modal
  backdrop.
- Provide an X close action, support Escape, and restore focus to the opening
  header control after closing.
- Automatically open the drawer after the server accepts a new download.
- Show `Current downloads` as text on wider screens and retain an accessible
  icon-and-count control on narrow screens.
- Place a clearly labelled New download section above Download History.
- When history is empty, explain how to begin and provide a `Start a download`
  action that focuses the URL field.
- Preserve the fixed header, fixed footer, responsive history grid, history
  pagination, generated previews, and Settings dialog.

## Implementation decisions

- Use a native modal `<dialog>` styled as a right-side sheet. Its top edge is
  tied to the responsive fixed-header height.
- Keep the existing `activeList` rendering path inside the drawer so row
  status, progress, ETA, pause, resume, stop, continue, tag editing, URL
  actions, and deletion do not acquire a second implementation.
- Update the header button's accessible label with the current count and use
  `aria-expanded`, `aria-controls`, and `aria-haspopup="dialog"` to expose its
  relationship to the drawer.
- Continue reconciling the drawer through the existing SSE-driven history
  refresh; opening the drawer does not introduce polling.
- Render history and Current from the same `/api/history` response, but apply
  selected tag filters only to terminal History entries.
- Reuse the shared download and close SVG symbols.

## Accessibility and responsive behavior

- Give the opener an accessible name that includes the current entry count,
  while omitting the visible numeric badge when that count is zero.
- Expose the opener/drawer relationship with `aria-haspopup`, `aria-controls`,
  and `aria-expanded`.
- Give the drawer a programmatic title and announce action failures through
  its alert region.
- On compact screens, hide only the opener's visible text; preserve its icon,
  accessible name, and count.
- Keep touch targets usable and let the drawer occupy the full viewport width
  below the compact fixed header.

## Non-goals

- Do not change the canonical download statuses or their Current/History
  classification.
- Do not replace SSE with polling or create a separate Current data endpoint.
- Do not redesign Current row controls or alter pause, resume, cancel, retry,
  tagging, or deletion semantics.
- Do not change the Settings dialog, history-card layout, preview generation,
  playback behavior, or history pagination.

## Acceptance criteria

- The page contains no tab controls and Download History is visible on load.
- The fixed header shows Current downloads directly before Settings.
- With one Current entry, the header badge and drawer count both report one and
  the drawer contains that full row.
- At desktop width, the drawer is no wider than 480 px, touches the right edge,
  and begins at the bottom edge of the fixed header.
- At 390 px viewport width, the drawer spans the viewport, remains top-aligned,
  and the header control reduces to its icon and count badge.
- Escape and the X button close the drawer and return focus to its opener.
- A failed action from a Current row is announced and visibly reported inside
  the drawer while the affected row remains present.
- Selecting History tags changes only the history cards and never hides a
  Current entry from the drawer.
- An accepted download opens the drawer automatically; a rejected submission
  retains the entered URL and options and does not open it.
- With no History entries, activating `Start a download` focuses the URL field.
