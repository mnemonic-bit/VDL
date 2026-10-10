# Make download history the primary thumbnail library

**Source:** User-requested feature
**Status:** Implemented
**Last refined:** 2026-09-27

> **Supersession note:** Feature 0018 removes the Current tab described below
> and replaces it with a top-aligned right-side drawer opened from the fixed
> header. Feature 0018 is authoritative wherever the two specifications differ.

## Decision summary

Make Download History the application's primary view and present completed
downloads as a responsive, visual library. Each history card leads with a
locally generated preview image, shows the title beneath it, and keeps detailed
metadata and editing controls in an Info popover opened from the card's
three-dot menu. Clicking a playable preview starts playback.

Keep application-level navigation outside the scrolling content. A fixed
header contains the application icon and title on the left and an icon-only
Settings control on the right. Settings opens as a blocking modal dialog rather
than occupying a tab. A fixed footer reports how many download records the
application currently holds alongside its existing version and uptime state.

## User experience

### History as the default view

- Open the application with Download History selected.
- Keep Current available as a tab for active, stopped, and resumable work.
- Give the history area more horizontal space than the download form so the
  visual library is the central focus of the page.
- Centre the bounded history area within the viewport.

### History cards

- Render each history item in this order:
  1. a 16:9 preview area;
  2. the download title;
  3. a three-dot action menu beside the title.
- Use the stored title when available, fall back to the stored filename without
  its extension, and finally use `Untitled download`.
- Show one through five cards per row according to available viewport width:
  one below 520 px, two from 520 px, three from 780 px, four from 1060 px, and
  five from 1320 px.
- Keep the complete grid centred, but left-align every incomplete final row
  with the first column of the rows above it.
- Preserve the existing history pagination and tag filtering behavior.
- Show an explicit unavailable state when a preview cannot be generated or an
  entry has no playable finished file.

### Preview and playback behavior

- Generate a JPEG preview for a successfully downloaded video without making
  download success depend on preview generation.
- Prefer a frame one second into the video and retry at the first frame when
  that seek does not produce an image.
- Scale generated previews down to at most 480 pixels wide while preserving
  their aspect ratio.
- Cache each preview as a hidden sidecar beside the media file, using the
  download ID as stable identity.
- Generate the sidecar at download completion and lazily generate it on first
  request for older completed entries that predate this feature.
- Serve previews only for finished entries whose stored media and thumbnail
  paths pass the same download-path allow-list boundary used for playback.
- Reuse the cached preview on later requests and remove the sidecar whenever
  the corresponding download artifacts are deleted.
- Treat the preview image as decorative because the adjacent title identifies
  the card.
- Make a playable preview a button with a visible play affordance. Clicking it
  must use the stored download ID and the configured playback mode: either the
  existing in-page player overlay or a new browser tab.
- Retain the fallback artwork and keep playback available when the image itself
  is missing but the finished media file exists.

### Card actions and Info popover

- Keep the three-dot menu on each card.
- Put Info, Open URL, Copy URL, and Delete in that menu; also expose Reload for
  failed history entries.
- Open Info as an anchored popover containing the information and editable
  controls removed from the card face:
  - full display title;
  - tags and tag editing;
  - status and source URL;
  - filename and rename control where applicable;
  - quality, size, and requested format;
  - start time and elapsed duration;
  - expandable error details and format information where applicable.
- Size the popover to 560 px on larger screens and reduce it only as needed to
  preserve a 12 px viewport margin on narrow screens.
- Place the popover above or below its originating menu according to available
  viewport space.
- Draw a triangular speech-bubble pointer from the popover to the centre of the
  card's three-dot button, including when the popover is constrained against a
  viewport edge.
- Allow the popover body to scroll when its content is taller than the
  viewport.
- Close the popover on Escape, on an outside interaction, when switching tabs,
  and when the viewport is resized.

## Fixed application chrome

### Header

- Fix the header to the top edge of the viewport so content scrolls beneath it.
- Span the full viewport width.
- Align the application icon and `Video Download Helper` title to the left.
- Preserve the icon's aggregate progress indicator defined by Features 0015
  and 0016.
- Put an icon-only Settings button at the upper-right corner. Use the shared
  cogwheel SVG symbol and expose `Settings` as its accessible name.
- Reserve enough body padding that the fixed header does not obscure page
  content, including at the compact mobile header size.

### Footer

- Fix the footer to the bottom edge of the viewport independently of content
  length.
- Reserve enough body padding that the footer does not cover the last content.
- Display the total number of records returned by the history endpoint,
  including both Current and Download History entries, with correct singular
  and plural labels.
- Keep the existing UI version, API version, uptime, and version-mismatch
  information.

## Settings dialog

- Remove Settings from the tab bar; the remaining tabs are Current and Download
  History.
- Open Settings from the cogwheel control in the fixed header.
- Use a native modal dialog so its backdrop blocks interaction with the page
  beneath it and keyboard focus remains in the dialog.
- Reload current preferences whenever the dialog opens.
- Preserve every setting from the former Settings tab:
  - download directory;
  - quality or custom yt-dlp format;
  - maximum concurrent downloads;
  - player mode;
  - light, dark, or system theme.
- Move Clear History into the dialog. It continues to remove finished and
  failed rows and their files while leaving resumable Current entries intact.
- Provide a labelled Save button. Successful saves briefly show a Saved state;
  rejected saves keep the entered values editable and display their error
  inside the modal.
- Provide an icon-only X close button in the dialog's upper-right corner.
- Support Escape as an additional close action.
- Restore focus to the control that opened Settings after the dialog closes.
- Make the dialog body independently scrollable, and stack label/control rows
  vertically on small screens.

## Implementation decisions

- Define and reuse `#i-cog`, `#i-play`, `#i-camera`, and the other shared SVG
  symbols from `templates/index.html`; do not duplicate SVG path data in card
  templates.
- Render the header and Settings dialog in the initial HTML so their semantics
  do not depend on an asynchronous render.
- Use the native `<dialog>.showModal()` API for blocking Settings behavior.
- Route action errors to the dialog's alert while Settings is open and to the
  page-level alert otherwise.
- Implement the responsive history layout with a wrapping flex container and
  fixed breakpoint-based card bases. `justify-content: flex-start` guarantees
  incomplete rows begin in the first column.
- Position Info popovers relative to viewport geometry because cards can be
  close to any browser edge. Store the calculated pointer offset in a CSS
  custom property shared by the popover's border and fill triangles.
- Generate previews with ffmpeg into a unique temporary path, then atomically
  replace the stable sidecar. Failed or interrupted generation must not leave a
  partial thumbnail behind.
- Expose previews through `GET /api/thumbnail/<download_id>` as conditional JPEG
  responses with a one-day client cache lifetime.
- Preserve the stored media location when deriving the thumbnail path so
  changing the download-directory preference does not disconnect older rows
  from their previews.
- Keep all light/dark differences in CSS custom properties, including the modal
  backdrop and shadow.

## Accessibility requirements

- Give the Settings control, close controls, preview playback buttons, and
  three-dot menus explicit accessible names.
- Connect the Settings button to the dialog with `aria-controls`, expose its
  modal-haspopup relationship, and reflect its open state with
  `aria-expanded`.
- Label the modal with its visible Settings heading.
- Mark decorative preview images and SVG artwork as hidden from assistive
  technology where adjacent text or the owning button already supplies the
  name.
- Keep errors in assertive live regions, including errors displayed within the
  Settings modal.
- Make the Info popover identifiable as download information and expose the
  originating Info action's expanded state.

## Acceptance criteria

- A fresh page load displays Download History, not Current or Settings.
- The header remains flush with the top of the viewport and the footer remains
  flush with the bottom while long history content scrolls.
- At viewport widths of 480, 650, 900, 1150, and 1500 px, a populated history
  displays one, two, three, four, and five cards in its first row respectively.
- With six entries in a five-column layout, the sixth card begins at the same
  horizontal position as the first card.
- A finished video card shows its preview before its title; clicking that
  preview starts playback through `/api/file/<download_id>`.
- A missing thumbnail shows the fallback state without removing playback from
  an otherwise playable card.
- Repeated requests for a generated preview reuse one cached JPEG, and deleting
  the row deletes both media and preview artifacts.
- A tampered history row pointing outside the allowed download paths cannot be
  used to generate or retrieve a preview.
- Info is reached through the three-dot menu. On desktop it is 560 px wide, on
  a narrow screen it fits the viewport, and its pointer terminates at the menu
  button that opened it.
- The footer count includes all stored Current and History records.
- No Settings tab is present. The header cogwheel opens a visibly blocking
  modal containing all preference controls, Clear History, Save, and an
  upper-right close button.
- Saving valid preferences persists them and reports Saved; a failed save
  remains open, preserves the edits, and displays the server error in the
  dialog.
- Closing Settings by its X or Escape returns focus to the opener.
- Browser regression coverage verifies the default view, card ordering,
  responsive grid and alignment, preview playback, anchored Info popover,
  fixed header and footer, total item count, Settings modal, preference save
  states, and Clear History behavior.
- Backend regression coverage verifies preview generation and caching, legacy
  media paths, missing-preview fallback, artifact cleanup, and path-boundary
  enforcement.
