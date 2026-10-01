# Move settings to a searchable, sectioned page

**Source:** User-requested feature  
**Status:** Implemented  
**Last refined:** 2026-10-01  
**Supersedes:** The Settings-dialog requirements in Features 0017 and 0018

## Decision summary

Replace the blocking Settings dialog with a dedicated application view that
appears in place of Download History. Keep Settings within the existing
single-page application: opening it does not navigate to a new URL or reload
the document, and returning to videos restores the normal history view.

Organize preferences into named sections so the page can grow without becoming
one long, undifferentiated form. Begin with `General`, `Playback`, and `Danger
Zone`. Present those sections in a left navigation rail on wider screens and as
a horizontally scrollable section bar on narrow screens. Add a settings search
field that filters individual setting rows and takes the user directly to the
first matching section.

Move the existing Clear History action into Danger Zone. Add a persisted
`Start videos in full screen` preference to Playback alongside `Play videos
in`. The fullscreen option applies only to the in-page overlay player; failure
or lack of browser fullscreen support must never prevent the video from
playing.

This feature supersedes only the modal-specific Settings decisions in Features
0017 and 0018. Their decisions about Download History as the primary view, the
fixed application header and footer, and the Current downloads drawer remain
in force.

## User experience

### Entering and leaving Settings

- A fresh application load continues to show Download History.
- Keep the Settings cog in the fixed header. Activating it replaces the video
  list area with the Settings page and indicates that the control is active.
- Do not render or open a Settings `<dialog>`. Settings is a non-modal page
  state, so no backdrop or focus trap is required.
- While Settings is open, hide controls that operate on the video library,
  including history search, New download, and Current downloads. Keep the
  application identity, Settings control, and footer visible.
- Provide a clearly labelled `Back to videos` action at the top of the Settings
  page. Activating it restores Download History and its normal header actions.
- Pressing Escape closes Settings only when the settings search field is empty.
  When the field contains a query, Escape clears the query first and keeps the
  Settings page open.
- Reload current preferences whenever Settings opens so the form reflects
  changes made through another browser session or API client.

### Section navigation

Show these navigation items in this order:

1. `General`
2. `Playback`
3. `Danger Zone`

- Selecting an item scrolls its section heading into view, marks the item as
  the current section, and clears any active settings search.
- Use smooth scrolling for ordinary pointer and keyboard navigation. Use
  immediate scrolling when the operating system requests reduced motion.
- Keep section identifiers and navigation relationships stable so additional
  sections can be added without changing the overall page structure.

### Searching settings

- Put a search field near the page heading with the visible purpose `Search
  settings`.
- Search case-insensitively across each setting's label, supporting text, and
  explicit search keywords.
- Split the query into whitespace-delimited terms. A setting matches only when
  every term appears somewhere in that setting's searchable text.
- Filter at the setting-row level. Hide a section when none of its settings
  match, and retain the section heading when at least one row matches.
- Select the first visible section in the section navigation while search
  results are displayed.
- Show `No settings match your search.` when the query has no results.
- Clearing the search restores every setting and returns the normal section
  navigation behavior.

## Settings inventory

### General

The General section contains the existing application-wide preferences:

- `Download directory`
- `Quality`
- `Custom format`, visible only when Quality is set to the custom choice
- `Max concurrent downloads`
- `Theme`

Preserve each preference's existing validation, supporting copy, defaults, and
runtime behavior. Theme changes may continue to preview immediately so the
user can assess the selected appearance before saving.

### Playback

The Playback section contains:

- `Play videos in`, with the existing choices for the in-page overlay and a
  separate browser tab;
- `Start videos in full screen`, represented by a checkbox and disabled by
  default.

The fullscreen preference has these semantics:

- Persist it as the preference key `start_fullscreen`, encoded as the string
  `"true"` or `"false"` to match the existing key/value preference store.
- Initialize the key to `"false"` for installations that do not yet have it.
- Enable the checkbox only when `Play videos in` is set to the in-page overlay.
  When playback is configured for a new tab, disable the checkbox and explain
  that automatic fullscreen applies only to the overlay player. Do not erase
  the stored choice merely because it is temporarily inapplicable.
- When an overlay video opens and the preference is enabled, begin normal media
  playback and request fullscreen from the video element.
- Prefer the standard `requestFullscreen()` API and use
  `webkitEnterFullscreen()` as a compatibility fallback when available.
- Treat fullscreen as a best-effort enhancement. Browser policy may reject the
  request because it is asynchronous or no longer considered part of a user
  gesture. Unsupported or rejected requests must not close the overlay, show a
  fatal error, or prevent playback.
- Do not attempt to force a video opened in a separate browser tab into
  fullscreen.

### Danger Zone

- Place `Clear History` only in Danger Zone; it must not also appear in General
  or Playback.
- Visually distinguish the section from routine preferences using the
  application's theme-aware warning and danger colors.
- Explain the consequence before the action: clearing History removes finished
  and failed records and their associated files, while Current downloads and
  resumable entries remain untouched.
- Preserve the existing preview and confirmation flow. Moving the control does
  not broaden which records or files are deleted and does not bypass the
  existing server endpoint or safety checks.

## Persistence and failure behavior

- Continue loading and saving preferences through `/api/preferences`; do not
  introduce separate endpoints for sections or individual settings.
- Store `start_fullscreen` in the existing SQLite preferences table. It is a
  preference key, not a downloads-table column, so it requires no schema
  migration.
- Include `start_fullscreen` in the backend preference allowlist and default
  initialization so both new and upgraded installations return it.
- Save the form as one preference update. Only update runtime settings after a
  successful server response.
- If saving fails, keep Settings open, preserve the user's edits, and display
  the server-provided error in the Settings page's alert region.
- On success, report that the settings were saved without leaving the page.

## Accessibility and responsive behavior

- Use a labelled settings region, semantic section headings, and navigation
  controls whose accessible names match their visible labels.
- Connect the Settings header control to the Settings page with
  `aria-controls`, and reflect its active state with `aria-pressed`.
- Mark the selected section navigation item with `aria-current="page"`.
- Associate every form control with its visible label and supporting text.
- Announce save failures through an assertive live alert. Keep focus on the
  Save control and change its visible label to `Saved` after a successful
  update.
- Preserve visible keyboard focus for the Settings control, Back to videos,
  search field, section navigation, form controls, Save, and Clear History.
- At desktop widths, use a left navigation rail and a separately readable
  settings content column. The page must remain usable as more sections are
  added.
- At narrow widths, including 390 px, move section navigation above the content
  as a sticky, horizontally scrollable row. Controls and action buttons must
  remain within the viewport without horizontal page overflow.
- Maintain complete light- and dark-theme support. Use existing CSS custom
  properties instead of hard-coded theme colors.

## Implementation decisions

- Keep the feature in the existing server-rendered shell and vanilla
  JavaScript application. Do not add a frontend framework, bundler, client
  router, or build step.
- Render the Settings page and its section structure in the initial HTML so its
  semantics do not depend on an asynchronous template render.
- Switch between history and Settings by controlling the visibility and
  interaction state of the existing application regions.
- Keep search metadata close to each setting row so future settings can become
  searchable by adding markup rather than extending a central JavaScript list.
- Retain existing preference parsing and validation on the server as the
  authoritative boundary. Client-side visibility and disabled states are user
  guidance, not substitutes for server validation.
- Keep existing playback paths based on each history row's stored filename.
  The fullscreen preference changes presentation only and must not reconstruct
  paths from the current download directory.

## Acceptance criteria

- A fresh page load shows Download History and no Settings dialog exists in the
  page.
- Activating the header Settings control replaces the video list with the
  Settings page, marks the control active, and hides library-specific header
  actions.
- Back to videos and Escape with an empty settings query restore the history
  view and its header actions.
- General, Playback, and Danger Zone appear in that order. Selecting each
  navigation item reveals and scrolls to the corresponding section.
- Searching by a setting label, help-text word, or configured keyword shows
  only matching setting rows. A multi-word query requires all terms, and an
  unmatched query shows the empty-search message.
- Escape in a non-empty settings search clears the search without leaving
  Settings.
- General contains Download directory, Quality, conditional Custom format,
  Max concurrent downloads, and Theme with their prior behavior intact.
- Playback contains Play videos in and Start videos in full screen.
- The fullscreen preference defaults off, survives save and reload, and is
  disabled with an explanatory message when Play videos in is set to a new
  tab.
- With overlay playback and fullscreen enabled, opening a playable history
  item requests fullscreen. A rejected or unavailable fullscreen API still
  leaves the overlay open and the video playable.
- Clear History appears only in Danger Zone, retains its confirmation flow,
  removes only the previously defined History records and files, and preserves
  Current and resumable entries.
- A successful save reports success. A failed save leaves the page open,
  preserves edits, and exposes the error accessibly.
- At 390 px wide, all settings remain reachable, the section navigation is
  horizontally usable, and the document has no unintended horizontal
  overflow.
- Browser regression coverage exercises page switching, section navigation,
  search filtering and empty results, responsive layout, preference save
  states, overlay fullscreen behavior, and Danger Zone placement.
- Backend regression coverage verifies the `start_fullscreen` default,
  allowlisted persistence, and existing Clear History boundaries.

## Non-goals

- Do not create a new Flask route, bookmarkable Settings URL, or browser
  history entry for the Settings view.
- Do not redesign the New download dialog, Current downloads drawer, history
  cards, playback overlay, or footer beyond the visibility changes required
  while Settings is open.
- Do not change download lifecycle states, SSE reconciliation, file-path
  authorization, or Clear History deletion semantics.
- Do not add per-section save buttons, independently persisted drafts, or a
  separate settings API.
- Do not promise fullscreen in a separate browser tab or bypass browser
  fullscreen permission and user-gesture policies.
