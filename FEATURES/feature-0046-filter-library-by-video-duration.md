# Filter the Library by video duration

**Source:** User-requested feature\
**Status:** Implemented\
**Implemented:** 2026-10-28 · Version `0.49.0`\
**Last refined:** 2026-10-28\
**Extends:** [Feature 0002, Search and filter download history](feature-0002-search-and-filter-download-history.md)\
**Interacts with:** [Feature 0027, Endless Library playback](feature-0027-endless-library-playback.md),
[Feature 0030, Shuffle playback](feature-0030-add-shuffle-playback.md), and
[Feature 0031, Personal video playlists](feature-0031-add-personal-video-playlists.md)

## Decision summary

Extend the existing Library search field with a `duration:` qualifier so a
user can find videos longer or shorter than a specified time. For example,
`duration:>10m` shows videos longer than ten minutes. Combine the qualifier
with existing text, user, quality, favorite, view-count, and playlist filters.
Support combined time units such as `duration:>5m3s`, and combine duration
conditions with AND to select only videos inside a given range.

Use the stored full video duration, not file size, download time, playback
position, remaining time, or the length of a preview or Shuffle Clips excerpt.

## Search syntax

The qualifier name and unit suffixes are case-insensitive. A duration token
has the form `duration:<comparison><time>`, without internal whitespace.

| Search | Meaning |
| --- | --- |
| `duration:>10m` | Longer than ten minutes |
| `duration:>5m3s` | Longer than five minutes and three seconds |
| `duration:>=1h2m3s` | At least one hour, two minutes, and three seconds |
| `duration:>=10m` | Ten minutes or longer |
| `duration:<90s` | Shorter than ninety seconds |
| `duration:<=1.5h` | At most ninety minutes |
| `duration:>600` | Longer than 600 seconds |
| `duration:>10:00` | Longer than ten minutes |
| `duration:>=1:30:00` | At least one hour and thirty minutes |
| `duration:>=10m duration:<30m` | At least ten minutes and shorter than thirty minutes |
| `duration:>5m3s duration:<10m` | Longer than 5:03 and shorter than 10:00 |
| `duration:>=5m3s duration:<=10m0s` | From 5:03 through 10:00, including both endpoints |
| `user:alice tutorial duration:>20m` | Alice's matching tutorials longer than twenty minutes |

- Support `>`, `>=`, `<`, and `<=`. An explicit comparison is required;
  `duration:10m` is invalid rather than guessing an operator.
- Accept nonnegative decimal values with one optional suffix: `s` for
  seconds, `m` for minutes, or `h` for hours. A bare number means seconds.
  Examples include `90`, `90s`, `1.5m`, and `0.25h`. Require digits before
  and, when present, after the decimal point.
- Accept combined suffixed components in descending order: hours, minutes,
  then seconds, with each unit used at most once. Units may be omitted:
  `5m3s`, `1h30m`, `1h2m3s`, and `1h3s` are valid. Sum their values in
  seconds; `5m3s`, `303s`, and `5:03` are equivalent. Only the final
  component may have a fractional value, so `5m3.5s` is valid while
  `1.5h30m` is invalid. Suffixed components need not be below 60;
  `1m90s` means 150 seconds. Reject repeated or out-of-order units such as
  `5m3m` or `3s5m`.
- Also accept integer clock notation `M:SS` and `H:MM:SS`. In `M:SS`, the
  minutes may exceed 59. Seconds, and the middle minutes in `H:MM:SS`, must
  contain two digits from `00` through `59`. The leading field contains one
  or more digits. `90:00` and `1:30:00` both mean 5,400 seconds.
- Do not accept signed values, scientific notation, decimal clock fields,
  mixed clock-and-unit notation such as `5:03s`, or whitespace within a
  duration token. Reject values whose conversion or combined sum is
  non-finite.
- Keep the existing overall search-length limit and quote-aware tokenization.
  Existing queries without `duration:` retain their behavior.

## Matching and boundaries

- Compare against the stored finite, positive `duration_seconds` value in
  seconds. Apply comparisons to the unrounded value, not the duration label
  displayed on a card. A 600-second video does not match `duration:>10m`,
  while a 600.1-second video does, even if both display as ten minutes.
- Exclude videos with missing, null, zero, negative, or non-finite durations
  whenever a duration qualifier is present. Do not treat unknown duration as
  zero. Without a duration qualifier, preserve their existing eligibility.
- Every duration condition must match: repeated `duration:` tokens use
  **AND** so users can specify a range. This is specific to duration
  comparisons; preserve the existing OR behavior within other qualifier
  groups and among ordinary text terms.
- For example, `duration:>5m3s duration:<10m` requires the same video to
  satisfy both bounds: its duration must be strictly greater than 303 and
  strictly less than 600 seconds. Reversing the tokens has no effect.
  Use `>=` or `<=` to include the corresponding endpoint.
- The duration conditions also combine with all other filter groups using
  **AND**. An ordinary title or tag match cannot bypass them.
- Valid but contradictory comparisons, such as
  `duration:>30m duration:<10m`, produce no matches and are not syntax errors.
- Clearing search removes the duration restriction and follows the normal
  search reset behavior for pagination and endless scrolling.

## User feedback and invalid input

Provide a short discoverable search hint with `duration:>5m3s` and the range
example `duration:>5m3s duration:<10m`. Keep the existing search field and
keyboard behavior.

When a recognized `duration:` token is incomplete or malformed, show a concise
message near the search field, such as “Use duration:>10m or
duration:>=1:30:00.” Associate it accessibly with the field. Preserve the
entered query so it can be corrected, show no matching results, and disable
Play All for the invalid selection. Do not silently ignore the token, fall
back to ordinary text matching, or leave stale results appearing to match it.

Examples of invalid tokens include `duration:`, `duration:>`,
`duration:10m`, `duration:>-1m`, `duration:>1:60`, and `duration:>NaN`.
Normal incomplete input while typing must not produce repeated error toasts
or move keyboard focus. Correcting or clearing the token clears the message.

## Library, playlists, and playback

- Apply the filter to individual Library video cards before pagination or
  endless-scroll slicing, so matches are not limited to the visible batch.
- Preserve playlist search semantics: a playlist matches when at least one
  visible member video satisfies the complete video filter. Compare the
  duration of that member, not the playlist's combined duration. The same
  member must satisfy all comparisons and other qualifier groups.
- Respect `playlist:yes` / `playlists:yes` and their `no` counterparts.
  Filtering playlist cards does not edit membership or filter the contents
  when the user plays a playlist.
- Play All from the filtered Library must use the same duration selection
  on the server as in the browser, including later continuous-playback
  handoffs under the existing session contract. Never include a video merely
  because the browser and server interpret the time value differently.
- Preserve authorization, playability checks, ordering, and existing
  playback-session snapshot and reconciliation rules.
- Shuffle and Shuffle Clips continue to ignore Library search and use their
  own Settings filters. Their minimum-duration setting remains independent;
  entering a search must not change that preference or their pool.
- This feature does not add duration filtering to Current Downloads or the
  separate download-attempt History search.

## Implementation boundaries

Use the existing `duration_seconds` metadata and filter strings; no new
database column, endpoint, or stored preference is required. Do not launch
ffprobe, open media files, or request playback data while evaluating search.
Existing metadata backfill remains responsible for discovering durations.
When an ordinary Library refresh supplies updated metadata, reapply search.

Keep the browser matcher in `static/app.js` and the server's Library selection
matcher in `vdl.py` equivalent. Include playlist member matching and the
filtered Play All paths. Validate recognized duration tokens in server APIs
that consume the Library filter; malformed filters return a clear HTTP 400
and do not create a playback session. Do not change the separate attempt
History parser's contract to add this feature.

The duration filter should compare already-loaded numeric metadata and add no
per-video database reads, network requests, or media probes. Keep the vanilla
frontend and existing event-driven refresh model.

## Acceptance criteria and verification

1. With fixtures of 599.9, 600, and 600.1 seconds, `duration:>10m` selects
   only 600.1; `duration:>=10m` selects 600 and 600.1. Test `<` and `<=` at
   the same boundary without rounding to card labels.
2. Seconds, minutes, hours, combined units, decimal units, bare seconds, and
   both clock formats produce equivalent selections for equivalent times.
   In particular, `duration:>5m3s`, `duration:>303s`, and `duration:>5:03`
   select the same videos. Include `1h2m3s`, `5m3.5s`, uppercase units and
   qualifier names, zero thresholds, malformed or repeated/out-of-order units,
   fractional non-final components, and values with non-finite conversions
   or sums.
3. A two-sided range intersects both constraints. Contradictory valid ranges
   show the normal empty state. Existing text and qualifier combinations
   retain their matching rules and cannot bypass the duration restriction.
   With fixtures of 303, 303.1, 599.9, and 600 seconds,
   `duration:>5m3s duration:<10m` selects only 303.1 and 599.9;
   `duration:>=5m3s duration:<=10m0s` selects all four. Both token orders
   produce identical results in the browser and server selection.
4. Missing and invalid stored durations fail duration filters without
   disappearing from otherwise eligible unfiltered results. Metadata arriving
   on refresh updates the selection without probing during search.
5. Matching works beyond the first page or endless-scroll batch. Playlist
   cards match only through an individually qualifying visible member, and
   playlist playback and membership remain unchanged.
6. Play All's server selection and subsequent handoffs agree with browser
   results. Direct malformed-filter requests return HTTP 400. Normal users
   cannot discover private videos through matching or playback selection.
7. Browser tests cover typing, correction, accessible invalid-input feedback,
   clearing, combined filters, pagination, and Play All availability.
   Shuffle and Shuffle Clips retain their independent Settings behavior.

Use shared table-driven cases to check Python and browser matching against
the same expected selections. Before marking implementation complete, run
`./tests/run-all.sh --unit` and verify the required 90% `vdl.py` line coverage,
then run the relevant browser search, playlist, and playback regressions.
Implementation uses the MINOR version bump `0.49.0` under the repository's
versioning convention.

## Implementation outcome

Implemented equivalent browser and server duration comparisons, including
combined units, clock notation, strict and inclusive bounds, and AND ranges.
The browser parses each query's duration conditions once, filters the full
Library before pagination, and reuses the matcher for playlist members.
Sequential Play All validates malformed filters before creating a session
and applies the same comparisons during later handoffs. Existing metadata
supplies durations without additional probes or per-video reads.

Search provides an accessible syntax hint and inline invalid-input feedback.
Changing a query immediately reapplies it to retained Library data and closes
open row menus so keyboard searches cannot leave stale cards or enabled
Play All controls. Duration qualifier recognition is independent of browser
locale. Shuffle, Shuffle Clips, and download-attempt History retain their
separate filtering behavior.

Shared fixtures cover 49 syntax and matching cases in Python and the browser.
Additional API and browser regressions cover authorization, later playback
handoffs, metadata updates, pagination, playlist membership, correction and
clearing, keyboard-opened menus, and Turkish-locale uppercase qualifiers.

Validation passed the unit gate with **374 tests**, five skipped, and
**91.6%** `vdl.py` line coverage (5,052/5,516 executable lines; required
minimum 90%). The full Chromium browser suite passed **272 tests**, and the
final focused duration suite passed all **nine tests**, including both
cross-review regressions. The Turkish casing regression uses native Turkish
string folding explicitly because Chromium's context-locale override does
not change the default locale of String casing in this test environment.
