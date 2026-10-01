# Track video views and show preview quality

**Source:** User-requested feature  
**Status:** Implemented  
**Last refined:** 2026-10-01  
**Extends:** Feature 0002, Search and filter Download History; Feature 0017,
Make Download History the primary thumbnail library

## Decision summary

Show two compact labels over playable Download History previews:

- a short quality tier in the lower-right corner; and
- `new` in the upper-left corner while the video's persisted view count is
  zero.

Both labels use rectangular, slightly rounded, translucent backgrounds. Normal
quality tiers use the same dark translucency as the favorite star's hover
background. The `4k` quality label and the `new` label use the same translucent
green background.

Persist a global view count for each download. A view is one explicit
activation of the History preview that opens playback. Hover montages, media
range requests, direct media requests, and file downloads do not count. The
Info dialog shows the resulting state on the same line as the downloader:
`Downloaded by: <user> · NEW` for zero views and
`Downloaded by: <user> · Views: <count>` otherwise.

Extend History search with structured filters over the resulting metadata:
minimum quality through `quality:`, favorite state through `star:` or
`starred:`, and view state or minimum view count through `views:`.

## Terms

- A **preview activation** is a click or equivalent keyboard activation of the
  native preview playback button in a Download History card.
- A **view** is one successfully recorded preview activation. Repeated preview
  activations each add one view.
- **New** means the persisted `view_count` is exactly zero. It is not based on
  creation time, browser-local state, the current user, or whether the hover
  montage has played.
- The **stored resolution** is the authoritative value captured from download
  metadata or `ffprobe`, such as `2160p` or `3840x2160`.
- The **quality tier** is a derived presentation value used by the preview
  label. It is not stored separately in SQLite.

## Preview labels

### Placement and content

- Render labels only inside a playable finished entry's preview button.
- Place `new` nine pixels from the upper-left edge.
- Place the derived quality tier nine pixels from the lower-right edge.
- Keep both labels above the static thumbnail and hover-preview video so they
  remain visible while the montage plays.
- Keep labels non-interactive with `pointer-events: none`; they must not
  interfere with preview activation, hover behavior, or the favorite control.
- Omit the quality label when the stored resolution cannot be classified.
- Omit `new` as soon as the persisted count is greater than zero.
- Use lowercase `new` on the thumbnail because it is a compact visual badge.
  Use uppercase `NEW` in Info because it replaces a metadata value.

### Appearance

- Use compact bold text, a rectangular background with a small corner radius,
  and the application's light-on-brand text color.
- Normal quality labels use `--favorite-hover-bg`: alpha `0.52` in light mode
  and `0.62` in dark mode.
- Define the shared green background as `--quality-4k-bg`, using the brand
  green with those same theme-specific alpha values.
- Apply the green background to the `4k` quality tier and the `new` label.
- Do not make any other quality tier green. In particular, `8k`, `2k`,
  `1080`, `720p`, `480p`, `360p`, and lower fallback values retain the normal
  dark translucent background.
- Do not add a full-thumbnail scrim or change thumbnail brightness on hover.

## Quality classification

Derive the quality tier on the backend and include it in history/download JSON
as `quality`. Preserve the original `resolution` field for Info and other
existing consumers.

Accept these stored-resolution forms:

- a vertical height with an optional `p`, such as `720`, `720p`, or `2160p`;
- dimensions separated by `x` or `×`, using the second number as height, such
  as `3840x2160`; and
- the case-insensitive aliases `8k`, `4k`, `uhd`, `2k`, and `qhd`.

Classify numeric heights by the highest matching threshold:

| Minimum height | Preview label |
| ---: | --- |
| 4320 | `8k` |
| 2160 | `4k` |
| 1440 | `2k` |
| 1080 | `1080` |
| 720 | `720p` |
| 480 | `480p` |
| 360 | `360p` |

For a positive height below 360, return the numeric height without adding a
suffix, for example `240`. Return no quality for missing, zero, negative, or
unrecognized values such as `audio only`.

This is deliberately a display classifier. It does not change format
selection, download behavior, the stored resolution, thumbnail generation, or
playback.

## View-count persistence

- Add `view_count` through the `init_db()` downloads migration list. Do not
  modify the initial downloads `CREATE TABLE` declaration.
- Store it as `INTEGER NOT NULL DEFAULT 0`.
- Existing rows migrate with zero views because no reliable historical
  playback data exists.
- Increment with one atomic SQL update while holding the existing database
  write lock so concurrent activations cannot lose counts.
- Return `view_count` as a JSON number from both individual download reads and
  `/api/history`.
- Treat the count as shared application state for the video. It is not a
  per-user watched flag and is not reset when an account is renamed, removed,
  or signed out.
- Preserve the count across application restarts, container replacement,
  page reloads, filename changes, visibility changes, favorite changes, and
  tag changes.
- Removing a download removes its counter with the download row. Resuming an
  interrupted or cancelled row does not reset it.

## View-recording API

`POST /api/view/<download_id>` records one view and returns:

```json
{
  "id": "download-id",
  "view_count": 1
}
```

The endpoint must:

- require an authenticated user;
- remain protected by the application's same-origin mutation policy;
- resolve the row through the normal visibility boundary so private videos are
  hidden from unauthorized users;
- accept only a finished entry with a stored filename whose file exists;
- apply the same trusted-download-directory guard used by playback;
- return HTTP 404 for an unknown, invisible, unfinished, or missing-file row;
- return HTTP 403 when the stored path escapes the trusted directory allowlist;
- atomically increment the count once per successful request; and
- publish an SSE `change` event with reason `view` after the transaction
  commits so every connected client reconciles the `new` badge and Info text.

Do not increment inside `GET /api/file/<download_id>`. Browsers may make
multiple full or ranged requests for one playback, and that endpoint also
serves explicit file downloads. Counting media GETs would therefore inflate
views and violate the user-action boundary.

## Client playback behavior

- Call the view endpoint only from the delegated preview playback action.
- Stop any active hover montage, initiate view recording, and open playback as
  part of the same activation.
- Do not await the view request before opening the overlay player or new tab.
  Accounting latency or failure must not delay or block playback.
- Do not call the view endpoint when a user hovers a card, plays the generated
  montage, clicks the favorite star, opens Info, selects Download from the
  three-dot menu, or directly requests a media URL.
- Allow normal SSE reconciliation to remove `new` and update Info after a
  successful increment. Do not introduce polling.

## Info dialog

Keep downloader identity and view state on one metadata line:

- zero views: `Downloaded by: admin · NEW`;
- one view: `Downloaded by: admin · Views: 1`;
- multiple views: `Downloaded by: admin · Views: 12`.

Use the existing `Unknown user` fallback when no downloader name is available.
The same line then reads, for example,
`Downloaded by: Unknown user · Views: 2`.

`NEW` replaces the complete `Views: 0` phrase; do not render both. The Info
dialog reads the server-provided `view_count`, so it remains consistent across
browsers and users.

## History search filters

Filtering remains client-side and applies only to Download History. Current
downloads remain visible regardless of the History search input. The existing
history response already contains the stored resolution, derived quality,
favorite state, and view count, so these filters do not add an API endpoint or
send the search query to the server.

Support these case-insensitive qualifiers:

| Qualifier | Meaning |
| --- | --- |
| `quality:4k` | Stored quality is 4K or better |
| `quality:720` or `quality:720p` | Stored quality is 720p or better |
| `star:yes` or `starred:yes` | Entry is a favorite |
| `star:no` or `starred:no` | Entry is not a favorite |
| `views:new` | Persisted `view_count` is exactly zero |
| `views:10` | Persisted `view_count` is at least ten |

Quality thresholds accept the same numeric, optional-`p`, dimension, and
named-alias forms as quality classification. Compare their normalized vertical
heights so higher tiers satisfy lower thresholds. For example, `quality:4k`
also returns 8K entries, while `quality:720p` returns 720p, 1080p, 2K, 4K,
and 8K entries.

Within one qualifier type, multiple values are alternatives. Different
qualifier types constrain each other, and at least one existing title or tag
term must also match. Thus `quality:4k star:yes views:10 mountain` returns
starred videos whose quality is at least 4K, whose count is at least ten, and
whose title or tag matches `mountain`. Unrecognized or empty values for a
recognized qualifier match no entries rather than falling back to title or tag
search.

Each filter execution retains the existing favorite-first ordering and applies
before History pagination. Clearing the input restores the unfiltered History
list and its normal ordering behavior.

## Accessibility requirements

- Keep the preview a native button with the existing `Play` accessible name
  and visible keyboard focus treatment.
- Treat the overlay labels as supplemental visual metadata, not additional
  controls.
- Ensure the Info dialog exposes the equivalent view state as text so it is
  available independently of the thumbnail labels.
- Preserve sufficient text/background contrast for normal and green labels in
  both themes.
- Do not encode the `4k` or new state by color alone; both labels include
  explicit text.

## Security and privacy

- Apply authentication, visibility, same-origin mutation protection, stored
  path validation, and the trusted-directory allowlist before incrementing.
- Do not expose a private video's existence or current view count through the
  mutation endpoint.
- Do not infer viewer identities or store a playback log. Only the aggregate
  per-video count is retained.
- Do not accept a client-supplied count or increment amount.

## Acceptance criteria

- A finished `3840x2160` or `2160p` video shows `4k` at the lower right with a
  translucent green background.
- A finished `2560x1440` video shows `2k`; `720p`, `480p`, and `360p` retain
  their `p` suffixes and use the normal dark translucent background.
- An unviewed playable video shows `new` at the upper left using the same green
  background and opacity as `4k`.
- Before playback, Info shows `Downloaded by: <user> · NEW`.
- Activating the preview opens playback immediately, increments the persisted
  count to one, removes the `new` badge after reconciliation, and changes Info
  to `Downloaded by: <user> · Views: 1`.
- Activating the preview again changes the count to two.
- Hovering long enough to play a montage does not change the count.
- Requesting `/api/file/<id>`, including multiple byte ranges, does not change
  the count.
- Downloading the file through the three-dot menu does not change the count.
- The count survives database reopening and container restart.
- Legacy databases gain `view_count` with a zero default without losing or
  rewriting existing rows.
- Unauthorized users receive 404 for a private video's view endpoint, and a
  cross-origin POST cannot increment a visible video's count.
- Backend tests cover migration, compact tier classification, API increments,
  unplayable rows, media GET non-counting, visibility, and
  same-origin protection.
- Browser tests cover both label colors, `new` removal, and the zero/nonzero
  Info presentations.
- `quality:4k` returns 4K and 8K entries but excludes 2K and lower entries.
- `quality:720` and `quality:720p` return identical results and include every
  classified entry at 720p or higher.
- `star:yes`, `starred:yes`, `star:no`, and `starred:no` filter on persisted
  favorite state.
- `views:new` returns only zero-view entries, while `views:10` returns entries
  with ten or more persisted views.
- Quality, favorite, view, user, title, and tag criteria can be combined
  without hiding Current downloads.

## Non-goals

- This feature does not track watch duration, completion percentage, seeks,
  pauses, unique viewers, per-user watched state, or last-viewed time.
- It does not deduplicate repeated activations by user, browser, session,
  device, or time window.
- It does not count autoplay, hover montages, direct media URLs, API media
  requests, or file downloads.
- It does not add sorting by view count or a dedicated server-side search API.
- It does not display the view count directly on the thumbnail.
- It does not provide an endpoint to decrement or reset views.
- It does not change the exact resolution shown in the existing Info media
  details.
