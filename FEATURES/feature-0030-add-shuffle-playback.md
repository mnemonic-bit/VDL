# Add shuffle playback to the Play All control

**Source:** User-requested feature
**Status:** Implemented
**Last refined:** 2026-10-09
**Extends:** Feature 0022, Move settings to a searchable, sectioned page;
Feature 0025, Track video views and preview quality; Feature 0027, Add endless
library playback with display-mode continuity

## Decision summary

Turn the History header's **Play All** control into a split button. Its main
segment keeps the existing one-click Play All behavior. A separate right-hand
segment displays a downward triangle and opens a menu containing **Play All**
and **Shuffle**. Choosing Play All starts the existing endless session from the
current History selection. Choosing Shuffle starts the same persistent built-in
player but asks the server to choose each item randomly from every eligible
video the signed-in user may access.

Shuffle deliberately ignores the current History search, sort order, page, and
favorite grouping. Its pool is the user's complete live library after
visibility, file-safety, browser-playability, minimum-quality, and
minimum-length checks. The server resolves that pool again for every handoff,
chooses uniformly from the current candidates, and avoids immediately
repeating the current item when another candidate exists. It does not retain a
shuffled queue or a growing list of played IDs.

Add a **Shuffle** group to Settings > Playback with two global preferences:

- **Minimum video quality**, selected from Any, 360p, 480p, 720p, 1080p,
  1440p, 2160p, and 4320p; and
- **Minimum video length (minutes)**, a whole number from 0 through 1440,
  where 0 means any length.

Both thresholds are inclusive and must be satisfied. Their defaults are Any
quality and 0 minutes, so upgrading does not intentionally narrow the library.
Each shuffle session snapshots the saved thresholds when it starts; saving new
preferences affects the next session, not one already playing.

Persist final-media duration so length filtering is deterministic and does not
run `ffprobe` inside an advance request. New downloads, uploads, and watched-
folder imports record resolution and duration when their final file is
published. A single low-priority metadata worker fills missing values for
existing library rows without holding the database lock while `ffprobe` runs.

## User outcome

### Play All

1. The user presses the main **Play All** segment and gets today's endless
   playback behavior immediately.
2. Playback starts at the current History coordinate and follows the current
   search and ordering, wrapping after the last current match.
3. The new triangle does not add an extra step to this common path.

### Choosing a mode

1. The user presses the triangle at the right end of Play All.
2. A menu opens beneath the control with **Play All** and **Shuffle**.
3. Choosing Play All performs exactly the same action as the main segment.
4. Choosing Shuffle opens the built-in player and starts a temporary shuffle
   session.
5. The first item and every later item are selected from the complete eligible
   shuffle pool. The current History filter and page do not restrict it.
6. Playback retains the overlay or fullscreen behavior, retry handling,
   keepalive, cleanup, and explicit Stop action from Feature 0027.

### Configuring the pool

1. In Settings > Playback, the user chooses a minimum quality and minimum
   length for Shuffle.
2. Saving validates and persists both values through the existing Preferences
   API.
3. The next Shuffle session includes only videos at or above both thresholds.
4. Play All and ordinary single-video playback remain unaffected.

## Terms

- The **split button** is the visually unified Play All main action and its
  separate menu-toggle segment.
- A **sequential session** is Feature 0027's current endless playback mode,
  resolved from the History filter, ordering, page size, page, and position.
- A **shuffle session** is an endless session whose next item is selected
  randomly from a live, threshold-qualified library pool.
- The **shuffle pool** is every currently visible, finished, safe, existing
  video file that satisfies the session's snapshotted minimum height and
  duration.
- **Minimum quality** is the inclusive minimum stored video-stream height,
  using the same height parsing and quality tiers as Feature 0025 and the
  `quality:` History filter.
- **Minimum length** is the inclusive minimum final-container duration in
  whole minutes. The stored comparison is performed in seconds.
- **Metadata pending** means a legacy playable row has not yet completed the
  one-time final-media resolution and duration probe introduced by this
  feature.

## Split-button design

### Structure and appearance

Replace the single `#endlessPlaybackButton` with one split-button group:

- the left/main native button retains the play icon, visible **Play All**
  label, tooltip, and direct Play All action;
- the right native button contains a small filled downward triangle from a new
  shared `#i-caret-down` symbol, has the accessible name **Choose playback
  mode**, and owns the menu;
- the two segments share the current pill outline and background, with one
  internal divider and no doubled border; and
- opening the menu may rotate the chevron upward, but the icon must not be the
  only indication of expanded state.

Do not put both actions inside one button and infer whether a pointer landed on
the rightmost pixels. The two segments must be independent controls with their
own focus rings and hit targets. Do not duplicate an SVG path in JavaScript;
reuse symbols from `templates/index.html`; add shared `#i-caret-down` and
`#i-shuffle` symbols there.

On viewports at or below the existing 560 px header breakpoint:

- hide the main segment's text as today, retaining its play icon and accessible
  name;
- keep the toggle as a distinct target at least 38 px high and wide; and
- anchor the menu to the group's right edge without allowing it to leave the
  viewport.

The split button remains hidden with the other History header actions while
Settings is open.

### Menu behavior

The toggle uses `aria-haspopup="menu"`, `aria-expanded`, and `aria-controls`.
The menu contains two native buttons exposed as menu items:

1. **Play All** with the existing play icon; and
2. **Shuffle** with the shared shuffle icon.

Behavior:

- pointer activation or `Enter`/`Space` on the toggle opens or closes the menu;
- `ArrowDown` on a closed toggle opens it and focuses the first enabled item;
- `ArrowUp` opens it and focuses the last enabled item;
- `ArrowDown`, `ArrowUp`, `Home`, and `End` move among enabled items;
- `Escape` closes the menu and returns focus to the toggle;
- choosing an item or clicking outside closes the menu; and
- opening this menu closes account, card-action, tag-suggestion, and other
  transient menus through the existing shared menu cleanup path.

The main segment and the Play All menu item use one handler so their behavior
cannot drift.

### Enabled states

The segments have independent availability:

- enable the main Play All segment when the current History selection has a
  candidate from which the existing sequential session can start;
- enable the toggle when either Play All or Shuffle may be attempted;
- disable the Play All menu item whenever the main segment is disabled; and
- enable Shuffle when the client knows of at least one visible finished video
  with a stored filename, while retaining server authority over file existence,
  safety, metadata, and thresholds.

The client is not expected to reproduce the authoritative shuffle pool. A
server rejection after the file or preferences changed is normal and must
produce an actionable player message rather than silently falling back to Play
All or weakening the thresholds.

## Shuffle preferences

### Settings presentation

Add a **Shuffle** subheading after the existing built-in-player and fullscreen
settings in the Playback section.

**Minimum video quality** is a select with these labels and stored values:

| Label | Stored height |
| --- | ---: |
| Any quality | `0` |
| 360p | `360` |
| 480p | `480` |
| 720p | `720` |
| 1080p | `1080` |
| 1440p | `1440` |
| 2160p (4K) | `2160` |
| 4320p (8K) | `4320` |

**Minimum video length (minutes)** is a number input with `min="0"`,
`max="1440"`, and `step="1"`. Its supporting text explains that 0 includes
videos of any known length and that both Shuffle filters apply together.

Include `shuffle`, `random`, `quality`, `resolution`, `length`, and `duration`
in the settings-search keywords. The controls follow the current responsive
Settings layout and theme variables.

### Persistence and validation

Add these keys to the existing key/value preferences table defaults:

```text
shuffle_min_height = 0
shuffle_min_duration_minutes = 0
```

Preferences remain global, matching the current download, library, and
playback preferences. This feature does not introduce per-account settings.

The Preferences API accepts the fields only under those exact names. It must:

- normalize values to base-10 strings;
- accept `shuffle_min_height` only from
  `0, 360, 480, 720, 1080, 1440, 2160, 4320`;
- accept `shuffle_min_duration_minutes` only as an integer from 0 through
  1440, rejecting booleans, fractions, negative values, and numeric strings
  containing signs or exponent notation; and
- reject the request atomically when either supplied Shuffle value is invalid.

The client populates the controls from `GET /api/preferences`, includes both
values in the existing Save request, and changes its local defaults only after
the save succeeds. Unknown or missing values from an older server render as
the two zero defaults without overwriting the server until the user saves.

## Final-media metadata

### Schema evolution

Append these columns to `init_db()`'s downloads migration list; do not modify
the initial `CREATE TABLE downloads` statement:

```text
duration_seconds REAL
media_metadata_probed INTEGER NOT NULL DEFAULT 0
```

`duration_seconds` stores a finite positive duration for the final container.
`media_metadata_probed` records that the final path has received the combined
resolution/duration probe, even when ffprobe could not return one of those
values. This prevents an unsupported or audio-only file from being retried on
every process start.

Refactor final-media inspection to obtain video-stream height and container or
video-stream duration from one bounded `ffprobe` JSON invocation where
practical. A successful video result updates `resolution`,
`duration_seconds`, and `media_metadata_probed=1` together. A completed probe
with unavailable duration keeps `duration_seconds` null but still marks the
row probed. A timeout, malformed response, or missing file must not convert a
finished download to an error.

Populate the metadata for:

- successful yt-dlp downloads after merge/remux and final rename;
- completed browser uploads before publishing their finished state; and
- watched-folder files during the existing validation pass.

An audio-only result has no video height and is not part of the Shuffle pool.
Play All and direct playback keep their existing behavior.

### Existing-library backfill

After application startup, run at most one daemon metadata worker for legacy
finished rows with `media_metadata_probed=0`:

- inspect one file at a time so upgrade work cannot saturate the host;
- select only rows with a stored filename, then recheck status, filename, file
  existence, and the download-path allowlist before and after probing;
- never hold `_db_lock` while starting or waiting for ffprobe;
- update a row only if it still names the path that was probed;
- mark a stable attempted row as probed even when metadata is unavailable;
- stop cleanly with the process; and
- publish a coalesced normal change event after useful metadata updates rather
  than creating a polling channel.

Shuffle may start from already qualified rows while this backfill is running.
Pending rows are not eligible when their unknown value is needed to prove a
configured threshold. If no known candidate qualifies but pending visible
video rows remain, session creation returns a distinct
`shuffle_metadata_pending` conflict instead of claiming that the pool is
empty. The player explains that older videos are still being prepared and
offers **Retry** and **Close**. Retry creates a fresh session request; it must
not weaken either threshold.

## Shuffle-pool semantics

Resolve the pool in this order:

1. apply the signed-in user's current visibility boundary;
2. require `status == finished`;
3. require a stored filename naming an existing regular file beneath an
   allowed library path;
4. require a parseable positive video-stream height, which excludes audio-only
   and unverified files;
5. require height greater than or equal to the session minimum when that
   minimum is nonzero; and
6. require a finite positive `duration_seconds` greater than or equal to the
   session minimum when that minimum is nonzero.

Any quality means any verified positive video height, not an audio-only or
unverified file. Any length does not require a known duration after the row has
been verified as a video. At nonzero length, unknown or unavailable duration
cannot satisfy the threshold.

Shuffle ignores:

- the History search string and all `user:`, `quality:`, `star:`, and `views:`
  terms in it;
- the current History page and page size;
- newest/favorites-first ordering;
- favorite and view-count values; and
- which card, if any, was last focused.

It does not ignore authorization or path safety. For a normal user, “all
videos” means public entries plus that user's private entries. For an
administrator it means every otherwise eligible entry, matching the existing
library visibility policy.

The pool is live. A newly completed video may participate in the next choice;
deletion, missing files, visibility changes, or metadata changes remove an
item from later choices without stopping the video already open.

## Random-choice contract

At shuffle creation, choose the first item uniformly from the complete current
pool. At each advance:

1. resolve the current live pool again;
2. if it contains more than one item, remove the current download ID from the
   request-local candidates;
3. choose one candidate with an unbiased bounded integer helper such as
   `secrets.randbelow(len(candidates))`; and
4. cache the compact response under the normal session sequence before
   returning it.

The no-immediate-repeat rule applies only when another eligible item exists.
A one-item pool repeats that item indefinitely. Choices are otherwise
independent, so an item may reappear after an intervening video and some items
may be selected more often than others. **Shuffle is not a shuffled deck and
does not promise one play per item before repetition.** This preserves Feature
0027's constant-size session state while fulfilling the request that each next
video be selected randomly.

The candidate list is request-local and may be proportional to the current
pool. Do not store it, a random seed, a played-ID set, or a future queue in the
session. Tests mock the bounded-choice helper; production code must not make a
seeded pseudo-random sequence part of the API contract.

## Playback-session API extension

### Create

Extend the existing endpoint without changing sequential callers:

```http
POST /api/playback-sessions
Content-Type: application/json
```

Sequential requests may omit `mode` or send `"mode": "sequential"`; their
current payload and behavior remain unchanged.

A Shuffle request is:

```json
{
  "mode": "shuffle"
}
```

The server reads and validates the persisted Shuffle preferences, converts the
minimum minutes to seconds, resolves the live pool, and selects the initial
item. Do not accept client-supplied thresholds: the saved server preferences
are authoritative and the session snapshots them once.

A shuffle session stores only:

- the existing opaque session ID, owner, sequence, retry response, current ID,
  and timestamps;
- `mode: "shuffle"`;
- the snapshotted minimum height; and
- the snapshotted minimum duration in seconds.

It does not store filter, ordering, page coordinates, or a pool. Shared session
helpers must branch explicitly by mode rather than fabricating a random
ordering identifier.

The successful response adds `mode` while retaining the existing compact item:

```json
{
  "session_id": "opaque-token",
  "mode": "shuffle",
  "sequence": 0,
  "page": null,
  "position": null,
  "item": {
    "id": "download-id",
    "title": "Example",
    "extension": "mp4"
  }
}
```

Sequential responses may also include `mode: "sequential"`; page and position
retain their current integer meaning.

Creation errors are JSON and distinguish:

- `400` for an unknown mode or invalid persisted preference;
- `409` with code `shuffle_metadata_pending` when no proven candidate exists
  yet but relevant legacy metadata is still being prepared; and
- `409` with code `no_shuffle_candidates` when the resolved pool is empty.

The empty-pool response describes the active thresholds so the UI can direct
the user to Playback settings. It must not reveal invisible row counts or
filenames.

### Advance, retry, keepalive, and release

Keep Feature 0027's advance payload, one-request-at-a-time rule, monotonic
sequence, expected-current-ID guard, one-response idempotency cache,
keepalive, expiry, per-user session cap, logout cleanup, and idempotent release.

For a shuffle session, a new sequence performs one fresh random choice. A
retry of the already completed sequence returns the cached item and must never
draw again. If the pool becomes empty, delete the session and return HTTP 204.
If metadata is temporarily pending and there is no proven candidate, keep the
session at its current sequence and return the actionable metadata-pending
conflict so Retry can repeat that same advance safely.

## Client playback behavior

Refactor the current start path to accept an explicit `sequential` or `shuffle`
mode while preserving one shared player controller.

Shuffle starts without a known item. Its click handler must synchronously:

1. close the split-button menu;
2. open the existing built-in player;
3. establish launch provenance;
4. request fullscreen immediately when that preference is enabled; and
5. show **Starting shuffle…** while the create request resolves.

This ordering preserves transient user activation for fullscreen. On success,
load the returned item into the same connected `#playerVideo`, call `load()`,
observe `play()`, and start the existing lease renewal. Every later `ended`
event uses the existing advance and handoff path; only server selection differs.

The client tracks the returned session mode so status text can say **Loading a
random video** for Shuffle and **Loading next video** for Play All. Closing,
stopping, autoplay denial, media failure, watchdog skips, fullscreen continuity,
late-response suppression, and maximum consecutive automatic failures remain
identical to Feature 0027.

Shuffle always uses the built-in player. If the saved ordinary player mode is
new-tab, preserve Feature 0027's explicit explanation/activation behavior; do
not open a new tab for each randomly selected item.

## View-count behavior

The first video chosen by an explicit Shuffle action counts as the user's
explicit preview activation and records one view after that item is accepted
for loading. Automatically selected later items do not increment view count,
matching Feature 0027. A failed create, metadata-pending response, empty pool,
skipped media item, or idempotent retry does not record a view.

## Failure and empty states

- If no video satisfies the saved thresholds, keep the player open with:
  **No videos match your Shuffle preferences. Change the minimum quality or
  length in Playback settings.** Offer **Open Playback settings** and **Close**.
- If legacy metadata is pending, say that older videos are still being prepared
  and offer **Retry** and **Close**.
- If one candidate exists, start it and allow it to repeat; do not reject a
  one-item pool.
- If the pool becomes empty during a session, stop advancement and report that
  no eligible videos remain.
- If preferences stored by a corrupt or newer server are invalid, fail closed
  with a server error and do not silently replace them for the active request.
- Network, media, autoplay, fullscreen, and expired-session failures retain the
  recovery controls from Feature 0027.

Opening Playback settings from the empty state closes and releases the current
player/session before navigating. It must not leave a hidden lease alive.

## Accessibility and responsive behavior

- Both split-button segments and both menu items are native buttons with
  visible focus in light and dark themes.
- The toggle's accessible name describes its action; the decorative chevron is
  hidden from assistive technology.
- Expanded state, menu ownership, keyboard navigation, Escape restoration, and
  disabled items are exposed programmatically.
- Announce **Starting shuffle**, the selected title, metadata preparation,
  empty-pool messages, and automatic handoffs through the existing polite live
  region.
- Do not move focus on a successful random handoff.
- When Retry or a settings change is required, focus the first actionable
  control in the transition panel.
- The menu and two touch targets remain usable at 390 px without obscuring the
  account or Current controls.
- Reduced-motion mode removes optional chevron/menu animation but not state
  changes.

## Security and privacy

- Re-evaluate current user visibility, path allowlisting, file existence, and
  regular-file status on every random choice and media request.
- Never return filenames, absolute paths, invisible counts, preference-owner
  details, or the candidate pool to the browser.
- A session ID grants navigation state only; `/api/file/<download_id>` remains
  the authoritative media-access boundary.
- Keep session IDs unguessable and foreign sessions indistinguishable from
  unknown sessions.
- Validate session mode and preference values against fixed allowlists and
  bounds; do not use them to construct SQL fragments.
- Run ffprobe only for stored, allowlisted final paths. Do not follow a newly
  substituted unsafe path between selection and probe update.
- Random selection does not need cryptographic secrecy, but it must be unbiased
  and must not expose or persist a predictable user-visible seed.

## Implementation map

| Area | Required change |
| --- | --- |
| `templates/index.html` | Split-button/menu markup, shared shuffle icon, Playback preference controls, transition action for opening settings |
| `static/styles.css` | Unified split-button geometry, anchored menu, focus/expanded/disabled states, responsive 390 px behavior |
| `static/app.js` | Menu keyboard behavior, shared Play All handler, Shuffle start mode, preference load/save, mode-aware status and recovery |
| `vdl.py` | Duration migrations, metadata probe/backfill, validated preferences, shuffle-pool resolver, mode-aware session create/advance |
| `tests/test_migrations.py` | Existing-database upgrade and default preservation |
| `tests/test_preferences.py` | defaults, accepted thresholds, bounds, malformed values, atomic rejection, persistence |
| `tests/test_playback_sessions.py` | pool semantics, authorization, thresholds, mocked random choice, no immediate repeat, one-item repeat, live mutation, idempotency |
| `tests/browser/preferences.spec.cjs` | Playback controls, search keywords, save/error behavior, responsive layout |
| `tests/browser/playback.spec.cjs` | split-button pointer/keyboard behavior, mode choice, random handoff, status, empty/pending recovery, fullscreen continuity |

## Verification

### Backend automation

- Upgrade a legacy database and prove the new columns and preference defaults
  are added without modifying or dropping existing rows.
- Validate every quality option plus minimum lengths 0, 1, and 1440; reject
  values outside the contract and prove a mixed invalid update is atomic.
- Verify final duration persistence for yt-dlp, upload, and watched-folder
  completion paths, including unavailable metadata.
- Prove the metadata worker never holds `_db_lock` during ffprobe, rechecks a
  changed filename, does not follow an unsafe replacement, and attempts one row
  at a time.
- Build mixed pools covering public/private ownership, admins, missing and
  unsafe paths, audio-only rows, exact threshold boundaries, pending metadata,
  and unavailable duration.
- Mock the bounded-choice helper to prove first selection, no immediate repeat,
  one-candidate repetition, live additions/removals, and all candidate indices.
- Repeat an advance sequence and prove it returns the cached item without a
  second random draw.
- Preserve all existing sequential playback-session tests unchanged or with
  only the additive `mode` response field.

### Browser automation

- Main-segment activation starts Play All without opening the menu.
- Toggle activation opens a two-item menu; Play All matches the main segment;
  Shuffle sends `mode: shuffle` and ignores the active History search.
- Pointer, Enter, Space, arrows, Home, End, Escape, outside click, focus return,
  expanded state, and disabled-item behavior match the contract.
- The split button and menu fit at 390 px in light, dark, and reduced-motion
  modes.
- Shuffle's first random item starts in the same connected player node and a
  later `ended` event changes only its source.
- Fullscreen is requested synchronously from the Shuffle click and retained
  through random handoff under the same supported-browser expectations as
  Feature 0027.
- Preference values load, save, survive reload, participate in Settings search,
  and remain editable after a rejected save.
- Empty-pool and metadata-pending states announce the right reason and expose
  only their specified recovery actions.

### Completion gate

Run:

```bash
./tests/run-all.sh --unit
./tests/run-all.sh --all
```

Do not declare the feature complete unless the unit command reports at least
90% `vdl.py` line coverage and the full suite passes.

## Acceptance criteria

- The History header shows a unified Play All split button with a distinct
  right-hand triangle.
- Clicking the main segment retains today's Play All behavior without an extra
  menu step.
- Clicking the right segment opens an accessible menu containing Play All and
  Shuffle.
- Menu Play All and the main segment execute one shared sequential action.
- Shuffle starts an endless built-in-player session whose first and later
  items are selected randomly from the complete authorized library, independent
  of History search, ordering, and pagination.
- When multiple items qualify, Shuffle never immediately repeats the current
  item; one qualifying item may repeat.
- Random retry is idempotent and does not draw a different item for the same
  sequence.
- Shuffle sessions remain constant-size and do not retain a queue or played-ID
  history.
- Playback settings persist an inclusive minimum quality and minimum length,
  defaulting to no threshold, and reject malformed values atomically.
- Both thresholds apply to the first and every later random choice, while Play
  All and direct playback remain unchanged.
- Final durations are recorded for new media and existing rows are backfilled
  serially without blocking the database lock.
- Audio-only, unsafe, missing, unauthorized, below-quality, and below-length
  entries never enter the Shuffle pool.
- Metadata-pending and genuinely empty pools are distinguished and explained
  without weakening filters or leaking invisible library information.
- Existing fullscreen/display continuity, autoplay recovery, media-failure
  bounds, lease cleanup, and view-count behavior remain intact.
- Split-button and settings interactions are keyboard accessible and usable at
  390 px in both themes.
- The required unit coverage and full test gates pass.

## Non-goals

- Saving, naming, sharing, exporting, or manually ordering playlists.
- Guaranteeing that every item plays once before any item repeats.
- Weighting choices by favorites, age, view count, tags, user, quality, or
  duration.
- Adding maximum quality or maximum length filters.
- Applying Shuffle preferences to Play All, direct card playback, downloads,
  hover previews, or History search.
- Adding Shuffle to each card's three-dot menu in this feature.
- Persisting active playback sessions or their random history across process
  restarts.
- Prebuffering the random next item, gapless playback, crossfades, or media
  transcoding.
- Changing the existing definition of a view for automatically advanced items.
- Introducing per-user preferences, a frontend framework, module loader,
  bundler, or polling.

## Version impact

Implementation is an application feature. Increment root `VERSION` by MINOR
and reset PATCH once when implementing it. This specification-only refinement
does not change `VERSION`.
