# Add a stable, timed rotation for Library and Play All

**Source:** User-requested feature\
**Status:** Implemented in 0.52.0\
**Last refined:** 2026-11-06\
**Extends:** [Feature 0027, Endless Library playback](feature-0027-endless-library-playback.md)\
**Interacts with:** [Feature 0030, Shuffle playback](feature-0030-add-shuffle-playback.md),
[Feature 0031, Personal video playlists](feature-0031-add-personal-video-playlists.md),
[Feature 0035, Remember the last Play All mode](feature-0035-remember-play-all-mode.md), and
[Feature 0046, Duration filtering](feature-0046-filter-library-by-video-duration.md)

## Decision summary

Add an optional **Library rotation** mode. Build one randomly ordered list of
all eligible Library videos, persist that order, and use it for both the
main-screen video grid and sequential **Play All**. Keep the list unchanged
for a configurable number of hours, then replace it with a freshly shuffled
list built from the current Library. Default to **off**, with **24 hours** as
the saved duration.

For example, enabling the mode at 09:00 with a 24-hour duration creates an
order such as `C, A, D, B`. Reloading, changing devices, searching, or starting
Play All again uses that order until 09:00 the following day. At expiry,
publish a newly shuffled order using the videos then available.

This is a shuffled deck: every member has exactly one position in a rotation.
The existing **Shuffle** and **Shuffle Clips** actions continue choosing
videos independently under their existing rules. They do not consume or
modify the rotation.

## Settings and scope

Add these controls to the existing searchable Settings page, in **Playback**:

| Setting | Default | Contract |
| --- | --- | --- |
| Library rotation | Off | Checkbox enabling the timed order for Library and Play All. |
| Keep rotation for (hours) | 24 | Whole number from 1 through 8760, inclusive. Disabled in the form while rotation is off, but its saved value is retained. |

Supporting copy: **Show videos and play them in the same shuffled order for
this many hours. Newly added videos join the next rotation.** Include
`rotation`, `daily`, `shuffle`, `library`, `order`, and `hours` in Settings
search keywords. Explain that the setting applies to Library and Play All;
the existing Shuffle controls retain their own behavior.

Use the existing application-wide preferences and their existing edit
permissions. There is one rotation per installation, shared across browsers
and accounts. Each account sees only its authorized subset, in the common
relative order. This feature does not introduce personal rotation settings.

Persist `library_rotation_enabled` and `library_rotation_hours` through
`/api/preferences`. Follow existing string storage conventions: `true` or
`false`, and canonical decimal hours. Accept JSON booleans or the exact
strings `true` and `false` for enabled; accept integer hours or ASCII digit
strings within the bounds. Reject nulls, booleans as hours, fractional values,
signs, non-finite values, and out-of-range hours with HTTP 400. Validate the
complete update before changing any preference or rotation state.

Saving takes effect as follows:

- Enabling creates a fresh rotation immediately and starts its duration.
- Changing hours while enabled creates a fresh rotation immediately using
  the new duration. Saving unchanged values does not reshuffle or reset time.
- Disabling immediately restores the existing Library ordering behavior.
  Retain the duration preference; enabling again starts a fresh rotation.
- Changing hours while disabled saves the value without building a rotation.
- Failed validation, cancellation, or a failed save leaves the previous
  preferences and rotation intact. Do not show an enabled state as saved
  before the server confirms success.

## Membership and ordering

At generation time, collect each distinct finished, playable entry admitted
by the existing Library eligibility rules, across the installation. Include
downloads, uploads, and ingested files on the same terms. Use stored file
paths and existing path-safety checks. Do not require new duration or quality
metadata, apply Shuffle thresholds, or probe media to build an order.

Generate an unbiased permutation of the complete candidate list, for example
with Fisher–Yates and an unbiased bounded random choice. Do not shuffle each
page separately or use a random comparator. Persist the resulting download
IDs and positions; never derive the order from browser state or mutable
titles, favorites, tags, view counts, or filenames.

Each candidate occurs once. Consecutive rotations may happen to have the
same permutation, especially for small libraries; randomness does not promise
a different first video or prevent repeats across a rotation boundary.

During an unexpired rotation:

- Refreshes, restarts, sign-ins, searches, favorite changes, metadata updates,
  page changes, and Play All launches do not regenerate or reorder it.
- A newly completed, uploaded, or ingested entry joins at the next rotation.
  It is available through existing direct-access and playlist paths where
  applicable, but is absent from this mode's video grid and Play All until
  then. Disabling rotation restores the ordinary Library immediately.
- Deletion, missing files, unsafe paths, and visibility loss remove an item
  from the current user's results and future playback choices immediately.
  Remaining members retain their relative positions; do not reshuffle or
  fill gaps with new videos.
- Visibility gains may expose an existing rotation member at its saved
  position. They do not insert an ID absent from that generation. Renaming
  an eligible member retains its position because identity is its ID.

The durable list may contain private entries internally. Every response and
playback choice must apply current authorization before exposing anything.
Never return hidden IDs, global membership counts, filenames, or positions
whose gaps disclose invisible membership. Shared videos retain the same
relative order between accounts, although their visible lists can differ.

An empty rotation is valid and retains its normal deadline. Do not repeatedly
regenerate it on reads. Newly available entries join at expiry or after an
explicit off/on change. Show **No videos in the current rotation. New videos
join the next rotation.** when the authorized unfiltered rotation is empty;
ordinary search misses retain the existing no-matches state. A one-item
rotation displays that item and allows Play All to repeat it.

## Lifetime, persistence, and renewal

Persist a generation's opaque ID, creation time, expiry time, and ordered
membership in the existing SQLite database. Use UTC timestamps and elapsed
hours: 24 hours means 86,400 seconds from generation, independent of midnight,
timezone, or daylight-saving changes. The server clock is authoritative.

At `now >= expires_at`, atomically replace the current generation with a
fresh permutation of the currently eligible Library. Its lifetime starts
when it is published. If the application was offline for several intervals,
create one fresh rotation on recovery; do not generate missed rotations.
Restarting before expiry retains the exact order and original deadline.

Use one server-side deadline wake-up while enabled so connected screens can
rotate without user interaction. Also check expiry when serving a rotation
or resolving a playback choice, covering delayed wake-ups and restart. Never
serve an expired order as the current successful result merely because the
timer has not run. Concurrent timers, reads, saves, and session advances must
publish at most one replacement for the same state. A stale renewal cannot
overwrite a newer preference save or revive a disabled rotation.

Publish a coalesced SSE change hint after a committed renewal or setting
change. Reconcile on that hint and on the existing reconnect/focus paths;
do not add browser polling. If renewal fails, retain the last committed state
for recovery, show an actionable refresh failure, and permit retry without
resetting the deadline or presenting the expired generation as fresh.

## Main-screen Library behavior

When enabled, the video grid takes its base order and membership from the
current rotation. Apply current authorization, eligibility, and Library
search filters before pagination or endless-scroll slicing. Clearing search
restores the same rotation order. Favorites-first sorting and insertion of
new arrivals at the top must not override it.

Display a compact **Library rotation · renews [local date/time]** status near
the Library controls. Hide it when disabled. Make the time accessible without
relying on a tooltip or color, and avoid a constantly announcing countdown.
Use only the account's visible result counts.

On a new generation, reset video pagination or endless-scroll batching to
the first batch and reconcile the grid once. Preserve the search query.
During the same generation, normal metadata refreshes preserve the existing
page, scroll position, and healthy card/preview nodes. Defer disruptive grid
reordering until an active inline edit or menu interaction finishes, using
the existing reconciliation guards; this does not extend the server deadline.

Personal playlist cards, shelf ordering, membership, bookmarks, and playlist
playback remain governed by their existing contracts. Playlist search may
still match their authorized members even when those videos are awaiting the
next rotation. The rotation supplies individual video cards and Library
Play All, not the playlist shelf or separate download-attempt History.

## Play All behavior

Keep the **Play All** label and sequential playback mode. While rotation is
enabled, its sequential source is the current authorized, playable,
search-filtered rotation. Start from the first playable card on the current
page or loaded view, preserving the existing launch convention, then follow
the full matching rotation beyond that page and wrap at its end. Starting
continuous playback from a particular card starts at that member.

Track progress by rotation identity and the last committed member position,
not solely by a coordinate in a shrinking filtered result. If a member is
removed, skip its saved position rather than skipping the following video.
Every matching eligible member is visited once before wrap when membership
and filters remain unchanged. Repeated Play All launches during the same
generation do not draw a new order.

Active sequential sessions adopt a renewed rotation at their next handoff.
Allow the current video to finish. In the new matching order, advance to the
successor of the current ID, wrapping if needed; if the current ID is absent,
start with the first eligible match. If none remain, stop with the existing
empty-selection feedback. Do not interrupt the current media or recreate the
player/fullscreen presentation because the deadline passed.

Changing enabled state or hours also affects active sequential sessions at
their next handoff. On disabling, find the current video's successor in the
session's ordinary canonical ordering, or start at its first match if the
current video is absent. Existing ordinary behavior resumes thereafter.
Keep the session's original search selection; settings changes do not replace
it with a different tab's search.

Preparation/preloading is provisional. At commit, verify the effective
ordering, generation, and eligibility again; discard a prepared target made
stale by renewal or a mode change. Preserve monotonic sequences, retry
idempotency, lease limits, media-access checks, view counting, failure bounds,
crossfade behavior, and display continuity. A retry of an already committed
sequence must not advance again just because a rotation renewed.

Explicit Shuffle, Shuffle Clips, direct single-video playback, and personal
playlist playback keep their current selection rules. The remembered Play
All/Shuffle/Shuffle Clips launch choice also remains unchanged; enabling
rotation does not silently switch the main button's remembered action.

## Implementation boundaries and API contract

- Add durable rotation state through additive, idempotent schema setup and
  preference defaults. Do not modify the initial downloads table definition.
  Durable state survives container replacement with the existing data volume.
- Keep one canonical server resolver for rotation lifecycle, ordered
  membership, and authorized selection. Library and sequential playback must
  use it, with matching browser/server search semantics.
- Preserve `/api/library`'s existing array response for existing callers.
  Add an opt-in `GET /api/library?include_order=true` response containing
  `{items, order}`. `items` contains only the caller's authorized entries in
  effective order; `order` contains `kind` (`rotation` or `library`), opaque
  `generation_id`, `created_at`, and `expires_at`, with generation fields null
  when disabled. Do not transmit the internal deck or random seed separately.
- While enabled, both forms of the Library response use rotation membership
  and order. The browser must retain response metadata with its collection
  snapshot and reject older in-flight responses after a renewal/save.
- Sequential create requests identify the displayed generation and starting
  download ID. The server controls whether rotation is active; a client
  cannot bypass it by supplying `newest` or `favorites_first`. A stale
  generation returns a specific HTTP 409 conflict so the client refreshes and
  offers a retry without playing an unintended first item. Rotation launches
  must await accepted server selection before loading or counting a view.
  Request fullscreen synchronously from the user's launch action as today.
- Session responses identify the effective ordering and generation. Ordinary
  clients remain compatible while rotation is disabled. Unknown generation
  tokens never select historical or foreign state.
- Persist one shared deck with O(N) membership storage, not a copy for every
  browser or playback session. Sessions retain only navigation metadata and
  the existing bounded retry/preparation state. Retire superseded decks once
  no operation needs them; do not accumulate one deck per interval forever.
- Do not hold the global database write lock while checking files, waiting
  for deadlines, or performing media work. Publish complete state atomically;
  a failed transaction cannot expose mixed old/new membership.

Primary touchpoints are `vdl.py` for schema/preferences, lifecycle, Library
selection, SSE, and session handoffs; `static/app.js` for order-aware
collection reconciliation, playback launch, and Settings; and
`templates/index.html` / `static/styles.css` for controls and status. Keep the
vanilla frontend and existing custom-property themes.

## Acceptance criteria and verification

1. An existing installation upgrades with rotation off and 24 hours saved.
   Disabled mode preserves existing Library and Play All behavior. Settings
   load/save, search, keyboard access, both themes, and narrow layouts work.
2. Enabling with a known fixture creates a permutation containing every
   eligible ID exactly once. Browser reloads, multiple tabs/accounts, and a
   process restart before expiry preserve order and deadline. Tests use
   injected random choices rather than probabilistic expectations.
3. With a controllable clock, reads immediately before expiry retain the old
   generation; reads exactly at expiry and afterward use one new generation.
   Cover a non-24-hour duration, daylight-saving changes, sleeping browsers,
   and several intervals of server downtime without real-time waits.
4. Concurrent expiry reads, wake-ups, and preference saves publish one
   coherent result. Failure injection leaves no partial deck or partial
   preference update. Rejected hours include 0, 8761, fractions, nulls,
   booleans, and non-finite values. Same-value saves do not reset expiry.
5. Newly available videos wait until renewal; deletions and inaccessible or
   unsafe files disappear immediately without reordering survivors. Renames,
   favorite changes, view counts, and metadata updates retain positions.
   Cover empty and one-item rotations and later visibility gains.
6. Search and duration filters select a subsequence before paging. Play All
   traverses that same full subsequence beyond the visible page and wraps.
   Removing the current or next item does not skip its surviving successor.
7. Renewal updates an open Library through SSE with no polling. Reconnect
   recovers a dropped event. The new generation resets video batching once,
   retains search, and does not overwrite active edits or accept stale fetches.
8. Renewal, duration changes, and disabling during playback leave the current
   video and fullscreen intact. The next handoff follows the specified new
   order. Test both current-ID-present and current-ID-absent cases, stale
   prepared media, empty selections, and committed-sequence retries.
9. A stale launch generation refreshes with an actionable retry and neither
   loads nor counts a view for the unaccepted item. Existing fullscreen
   activation and player error recovery still work.
10. Two ordinary accounts and an administrator see only their permitted
    members, with shared relative ordering. Library responses, SSE hints,
    playback, empty states, and counters disclose no hidden membership.
11. Shuffle, Shuffle Clips, their filters, remembered launch choice, personal
    playlists, direct playback, and download-attempt History retain their
    existing behavior. Superseded rotation storage remains bounded across
    repeated renewals and restart.

Use backend lifecycle/API/session tests and focused browser Settings,
pagination, live-refresh, search, and playback regressions. Before marking
implementation complete, run `./tests/run-all.sh --unit` and verify at least
**90% `vdl.py` line coverage**, using Python 3.12 when close to the threshold,
then run the relevant browser and persistence checks.

## Non-goals and version impact

No calendar-midnight scheduling, per-account schedules, weighted ranking,
manual ordering, manual reshuffle button, rotation archive, playback resume
bookmark, automatic playback launch, or changes to Shuffle/Shuffle Clips
selection are included.

Implemented in `0.52.0` with one MINOR bump and PATCH reset under `AGENTS.md`.

## Implementation verification

The SQLite generation and shared deck survive a fresh process, and one
serving-process timer renews the order. Library responses and sequential
sessions use the same resolver; the separate authorized `/api/library-catalog`
keeps playlist editing and member search independent of rotation membership.

`./tests/run-all.sh --unit` passed on Python 3.12: 494 tests, 9 skipped, and
92.4% `vdl.py` line coverage. Lifecycle, authorization, session, persistence,
daylight-saving, concurrency, failure recovery, and query-budget checks pass.
All 12 rotation browser checks pass, alongside the existing crossfade,
upload, live-refresh, Settings, pagination, duration, and playback regressions.
