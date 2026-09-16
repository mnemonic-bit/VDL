# Add tags to download entries

**Source section:** Further things to add to the download helper
**Status:** Implemented
**Last refined:** 2026-09-16

## Decision summary

Let users attach reusable, user-defined tags to any download entry. Present
tags with the familiar token/chip-style editor used for tagging content: users
can add tags, see the tags already attached, and remove them. The accumulated
tag set also provides a filter for narrowing the visible download entries.

Use **download entry** for a persisted download record regardless of whether it
currently appears under Current or Download History.

## Confirmed requirements

- A download entry can have zero or more tags.
- A tag can be reused across multiple download entries.
- Tags can be assigned to download entries throughout their lifecycle, not
  only after a download has finished.
- Attached tags are displayed on the download entry.
- Users can filter download entries by tag.
- The tag filter includes a drop-down match-mode control:
  - **ALL** shows only download entries carrying every selected tag.
  - **ANY** shows download entries carrying at least one selected tag.
- **ALL** is the initial match mode.
- Current and Download History share one filter state. Selected tags and the
  match mode remain active when the user switches between the two tabs, and
  the same criteria are applied to whichever tab is visible.
- The shared filter uses a searchable multi-select picker. Opening it shows an
  alphabetical list of all tags currently in use, and typing narrows the list.
- Selected filter tags appear as individually removable chips. A **Clear**
  action removes the entire active tag filter.
- The `ALL`/`ANY` match-mode drop-down sits beside the tag picker.
- Adding and removing tags uses an inline tag editor rather than a separate
  settings page.
- The editor accepts free-form tags and suggests tags already attached to
  other download entries.
- Enter or comma commits the text currently being typed as a tag. Spaces are
  ordinary tag characters, so tags can contain multiple words.
- While editing, attached tags and the text cursor share one token-input field,
  with the cursor immediately after the last tag. Typing filters matching
  existing tags in a suggestion list below the field.
- Backspace edits the draft normally while it contains text. With an empty
  draft, Backspace immediately removes the preceding tag.
- Leaving the token-input field returns the entry to a display row of tag
  chips.
- The display row has no separate Edit button. Hovering the row reveals a
  subtle bounding box, and clicking anywhere in it enters edit mode. An
  untagged row still provides a visible **Add tag** affordance.
- While the token input is in edit mode, every tag chip shows a low-contrast
  `×` control. Hovering or focusing a chip makes only that chip's `×` more
  prominent and changes its colour to indicate removal. Clicking it removes
  that tag. Removal controls are not shown in display mode.
- Escape discards any uncommitted draft text and returns the tag row to display
  mode. Tags already added or removed during that editing session remain
  committed.
- Tag identity is case-insensitive. If `Music Videos` is created first, later
  input such as `music videos` reuses the same tag.
- Tags are always displayed using the spelling and capitalisation from their
  first creation. If a tag becomes unused and is later recreated, that later
  creation establishes a new display spelling.
- Tags do not have an independent management screen or lifecycle. When a tag
  is removed from its last download entry, it disappears from autocomplete
  suggestions and the available filter list.

## Relationship to Feature 0002

Tag filtering belongs to this feature. Feature 0002 remains responsible for
free-text and metadata filters such as title, website, and quality. The two
features should eventually share a coherent filter area, but Feature 0001 must
be independently useful before Feature 0002 is implemented.

## Implementation decisions

- Tag names are limited to 64 characters. Leading and trailing whitespace is
  removed, repeated whitespace is collapsed to one space, and commas and
  control characters are rejected.
- The inline editor appears directly below the entry title. Enter and comma
  commit, an empty Backspace removes the preceding chip, and Escape discards
  only the current draft.
- The shared filter sits directly below the tabs and is hidden while
  Preferences is open.
