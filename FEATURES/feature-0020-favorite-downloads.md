# Favorite Download History entries

**Source:** User-requested feature  
**Status:** Implemented  
**Last refined:** 2026-09-30

## Decision summary

Allow users to mark Download History entries as favorites with a star button
over the preview. Favorite state persists in SQLite and is restored across
application and browser restarts.

Favorite-first ordering is applied when a page is freshly loaded or reloaded,
and whenever the History search is executed by typing, deleting, clearing, or
escaping from the search field. Clicking a star updates the state without
moving the card immediately. Between explicit ordering events, visual
stability takes priority so live reconciliation cannot make a title jump or a
card disappear from its current page beneath the pointer.

The preview image remains equally visible at rest and on hover. Its play
button has a permanently translucent circular background. The star has no
background at rest and receives a slightly more translucent version of that
circle only while the pointer is over the star itself.

## User experience

### Favorite control

- Show an icon-only star button in the upper-right corner of every Download
  History preview, including finished and failed entries.
- An unstarred entry uses a medium-grey star outline with no fill.
- A starred entry uses the favorite accent for both outline and fill.
- Expose `Add to favorites` for an unstarred entry and `Remove from favorites`
  for a starred entry as both the accessible name and hover title.
- Reflect the persisted state with `aria-pressed="false"` or
  `aria-pressed="true"`.
- Disable the control while its update request is in flight so repeated clicks
  cannot race each other.
- Reconcile the card with server state after both successful and rejected
  requests. A rejected request must not leave an optimistic state visible.

### Ordering rules

The ordering contract deliberately separates state changes from ordering
events:

| Event | Ordering behavior |
|---|---|
| Fresh page load or full reload | Favorites first, then non-favorites |
| Search text entered or changed | Favorites first among the matching results |
| Search text deleted, cleared, or cleared with Escape | Favorites first in the restored results |
| Star added or removed | Persist and redraw the state without moving the card |
| SSE or ordinary history reconciliation | Preserve the established order of known cards |
| Newly completed download | Insert before known cards without reordering those known cards |

- Within each favorite or non-favorite group, retain newest-first creation
  order.
- Apply favorite ordering before pagination so the first page contains the
  highest-priority matching entries after an ordering event.
- A star click must not move a card to another page, replace the title under
  the pointer, or make the card disappear from the current result set.
- A subsequent page reload or search execution may move the card because that
  is an explicit ordering event.
- Removing a star follows the same stability rule: the card stays in place
  immediately, then returns to its chronological position on reload or the
  next search execution.
- Keep the API response newest-first and independent of presentation state.
  The browser owns favorite grouping because it also owns the temporary stable
  visual order between ordering events.

### Preview and button appearance

- Never darken, filter, or place a scrim over the complete preview image when
  the pointer enters the preview.
- Keep the full-size play overlay transparent at rest, hover, and keyboard
  focus.
- Give only the circular play icon background the shared preview scrim. This
  translucent circle remains visible regardless of pointer position.
- Give the star button a transparent background at rest.
- Show a dark translucent circle only while the pointer is over the star
  button, not merely somewhere over the preview.
- Make the star hover circle slightly more translucent than the play circle.
  The implemented values are six percentage points lighter in both themes:
  `0.52` versus `0.58` in light mode and `0.62` versus `0.68` in dark mode.
- Keep keyboard focus visible without darkening the preview: use the theme link
  colour as an outline around the focused play or star control.
- Define theme-specific background and favorite colours as CSS custom
  properties rather than hard-coding them inside component rules.

## Persistence and API contract

### Database

- Add `favorite` through the `init_db()` migration list, not the initial
  `CREATE TABLE` statement.
- Store the value as an integer constrained by application behavior to `0` or
  `1`, with `NOT NULL DEFAULT 0`.
- Existing Download History entries migrate as unstarred. No favorite state is
  inferred from title, tags, filename, or prior ordering.
- Serialize the stored integer as a JSON boolean in download responses.

### Mutation endpoint

`POST /api/favorite/<download_id>` accepts:

```json
{
  "favorite": true
}
```

- Require `favorite` to be a JSON boolean. Reject strings, numbers, null, and
  omitted values with HTTP 400.
- Return HTTP 404 when the download ID does not exist.
- Treat setting the existing state as an idempotent success.
- Return the download ID, resulting boolean state, and whether persistence
  changed:

```json
{
  "id": "download-id",
  "favorite": true,
  "changed": true
}
```

- Publish an SSE change event only when the persisted value actually changes.
- Continue to protect this mutation with the application's same-origin request
  policy.

## Implementation decisions

- Define the star once as the shared `#i-star` symbol in
  `templates/index.html` and reference it from card markup. Do not duplicate
  SVG path data in JavaScript.
- Render the star inside the preview wrapper but outside the playback button so
  starring never starts playback.
- Keep the API's chronological ordering as the stable source order.
- On an ordering event, use a stable client-side favorite comparison so source
  chronology remains unchanged within equal favorite states.
- Remember the ordered download IDs in the browser. Reconciliation places
  unseen completed downloads first and then restores known entries in their
  remembered order.
- Carry an explicitly requested favorite sort through deferred and
  animation-frame-coalesced refreshes so a temporarily open menu or held row
  action cannot swallow the ordering event.
- Do not add polling. Star mutations and other state changes continue to use
  the existing SSE reconciliation pipeline.

## Accessibility requirements

- Use a native `button` for the star control.
- Keep its accessible name, title, `aria-pressed` state, and visual fill in
  agreement after every reconciliation.
- Mark the nested star SVG as decorative.
- Preserve a visible `:focus-visible` outline for both star and play controls.
- Do not use the dark hover circle as the only keyboard focus indicator.
- Maintain sufficient contrast for the unstarred medium-grey outline over both
  real thumbnails and the unavailable-preview fallback.

## Acceptance criteria

- Starring an older card fills its star but does not change the visible card
  order immediately.
- Reloading after that action places the starred older card before a newer
  unstarred card.
- Removing the star leaves the card in place immediately; reloading restores
  newest-first chronological order when neither card is starred.
- Typing a matching search term puts matching favorites first. Removing or
  clearing that term reapplies favorite-first order to the restored list.
- Favorite and non-favorite groups each remain newest-first after an ordering
  event.
- SSE reconciliation after a star mutation does not undo the stable visible
  order or move the acted-on card to another page.
- Favorite state survives database reopening and application restart.
- Invalid favorite payloads receive HTTP 400 and unknown IDs receive HTTP 404.
- The idle star is a medium-grey outline on a transparent background; a
  selected star is filled with the favorite accent.
- The star's dark translucent circle appears only on star hover and is slightly
  more translucent than the permanent play circle.
- Moving the pointer anywhere else over the preview never changes the
  brightness of the complete thumbnail.
- Keyboard focus remains visible without applying a full-preview scrim.
- Browser regression coverage exercises star appearance, click stability,
  add-and-reload ordering, remove-and-reload ordering, and search-triggered
  ordering.
- Backend regression coverage exercises migration defaults, boolean
  serialization, persistence, chronological API order, idempotence, payload
  validation, and unknown download IDs.

## Non-goals

- Favorites do not create a separate tab, playlist, or permanent search mode.
- Favorites do not affect Current-download ordering.
- Favorites do not change download priority, concurrency, playback, file
  naming, cleanup, or tag behavior.
- The server does not expose a separate favorite-sorted history endpoint.
