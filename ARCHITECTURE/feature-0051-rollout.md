# Feature 0051 rollout inventory

This inventory separates the initial tag delivery from the remaining app-wide
migration in [Feature 0051](../FEATURES/feature-0051-immediate-feedback-for-server-backed-interactions.md).
The shared coordinator registers `tag.add`, `tag.remove`, `favorite.set`,
`rename.set`, `preference.set`, `playlist.create`, `playlist.replace`,
`playlist.add`, `playlist.delete`, `download.pause`, `download.unpause`,
`download.stop`, `download.retry`, and `download.resume`.
An existing API call does not gain receipt recovery merely because the new
scripts are loaded. Mutating requests are never retried by `apiFetch`'s GET
contention recovery.

## Initial delivery

Tags use an in-memory projected store and a per-entry FIFO mutation queue.
Confirmed tag snapshots carry decimal-string revisions and canonical identities.
The SQLite receipt transaction binds each attempt to the current authenticated
actor, target, operation, payload, and expected revision. The mutation response
confirms the chip directly; SSE remains a generic invalidation hint.

The client retains failed text separately from editor drafts. Unknown outcomes
pause their entry's tag queue and expose receipt checking and deliberate replay
of the same attempt. No browser write queue survives reload. A receipt lookup
or replay always checks current authorization.

`VDL.tagMutationMetrics()` exposes a bounded, read-only aggregate for local
render processing time, acknowledgement time, outcome counts and reconciliation
read counts. It includes no resource IDs, tag values or request payloads. This
is an in-memory diagnostic and is cleared with the page, not analytics storage.

The checked-in identity helper negotiates tables generated from Python 3.11,
3.12, 3.13 and 3.14. Unsupported identity versions keep the conservative legacy
presentation rather than guessing case-folding or character validation rules.

## Delivered action adapters

[Feature 0052: Favorites](../FEATURES/feature-0052-immediate-feedback-for-favorites.md)
adds the independent favorite domain. Stars project explicit boolean intents
immediately in Library, Info, and Current downloads, with adjacent saving and
recovery text. Each entry/domain has its own FIFO queue; tag edits remain usable
while a favorite save waits. Canonical acknowledgements confirm without SSE or
a collection read. Active favorite interactions retain their card and focus in
filtered views, without changing rotation membership.

The persistent `favorite_revision` is serialized as a decimal string. A database
trigger includes legacy writers and increments only when the value changes.
Favorite mutations share the authorized transaction/receipt executor, expiry,
quotas, actor-scoped lookup, and deliberate frozen-attempt replay used by tags.
Current authorization gates original execution and recovery. Authentication
reset and target unavailability fence pending favorites and old callbacks.
`VDL.favoriteMutationMetrics()` and `VDL.mutationMetrics()` expose bounded
in-memory aggregates without content or resource identifiers.

[Feature 0053: Rename](../FEATURES/feature-0053-immediate-feedback-and-safe-recovery-for-rename.md)
adds the independent rename domain. Editor transitions are local; submitted
names project immediately with pending feedback while the confirmed file path
remains authoritative for playback. Draft generations and view tokens protect
newer typing and reopened Info surfaces. Only canonical acknowledgements change
the confirmed identity, without requiring SSE or a collection refresh.

The persistent `rename_revision` is serialized as a decimal string and includes
legacy identity writers through a database trigger. Physical renames first
persist an actor-bound filesystem journal and pin the intended file with a
durable hardlink anchor. Exclusive destination creation avoids overwriting a
collision. Exclusive source retirement preserves unrelated replacements at the
old name. Restart and authorized recovery resume the recorded operation;
ambiguous identity retains an unresolved operation requiring intervention.
Canonical publication and the terminal receipt share a database transaction.
Rename and removal serialize file ownership without holding the SQLite write
lock across filesystem effects. Recovery uses the same frozen attempt, with
current authorization, shared quotas and expiry, and no automatic replay.
`VDL.renameMutationMetrics()` exposes bounded in-memory aggregate diagnostics.

[Feature 0054: Preferences](../FEATURES/feature-0054-immediate-feedback-for-preference-saves.md)
adds the installation-wide `preferences` domain through `preference.set`.
Settings show saving feedback synchronously, retain editable newer drafts and
local theme preview, and apply sensitive client effects only from confirmed
canonical values. Duplicate Save is guarded; close/reopen, old reads, and late
callbacks cannot replace a newer draft. A compact summary preserves access to
pending and recovery status outside Settings.

The persistent decimal-string `preferences_revision` covers legacy, helper,
and direct SQL writers. The final serialized transaction rechecks current
authorization, expected revision, receipt namespace, admission time, and shared
quotas after filesystem preparation, then commits values, rotation state,
runtime-reconciliation marker, and receipt together. Directory creation is an
idempotent prerequisite; a precommit crash may leave an empty directory.
Recovery reapplies current desired runtime configuration without regenerating
the rotation deck/deadline or creating download commands. Existing worker
ownership and debug-reloader timer ownership remain authoritative.

Conflicts require explicit review and a new submission. Unknown outcomes offer
actor-scoped receipt checks and deliberate replay of the same frozen attempt;
matching reads alone never confirm a save. Unsupported servers retain pending
feedback and drafts without inventing revisions or receipt recovery.
Authentication and installation-access fences clear private draft state and
ignore obsolete callbacks. `VDL.preferenceMutationMetrics()` exposes bounded,
content-free in-memory aggregates through the shared diagnostic seam.

[Feature 0055: Playlist editor](../FEATURES/feature-0055-immediate-feedback-for-playlist-editor-saves.md)
adds `playlist.create` and `playlist.replace` in the independent `playlist`
domain. Saving feedback is synchronous; duplicate submissions and unresolved
whole-list replacements are guarded. Editor drafts and view generations remain
separate from the confirmed playlist. Canonical acknowledgements update only
the affected playlist without SSE or a collection refresh. Conflict recovery
retains the draft for comparison and requires an explicit choice of current
state or review and resubmission.

The existing integer playlist revision is preserved. Ordered membership and
submitted fields are bound to actor-scoped receipts committed atomically with
creation or replacement. Replay returns the original result before checking
its now-old expected revision; creation replay cannot create a second playlist.
Current authorization gates execution and recovery, including member-data
redaction after visibility loss. Missing receipts and matching reads do not
confirm a save. Recovery checks and deliberate frozen-attempt replay use the
shared expiry and quota rules, with no persistent browser queue or automatic
write replay. Quick-add and deletion share this revision boundary through
the Feature 0056 adapters below.
`VDL.playlistMutationMetrics()` exposes bounded, content-free aggregate
diagnostics through the shared seam.

[Feature 0056: Playlist add/delete](../FEATURES/feature-0056-immediate-feedback-for-playlist-add-and-delete.md)
extends the same playlist domain with `playlist.add` and `playlist.delete`.
Quick-add shows immediate pending feedback without projecting membership;
canonical acknowledgements update the affected playlist directly, including
confirmed no-op adds. Deletion retains a confirmation surface and the pending
shelf card until a correlated removal acknowledgement installs a deletion
fence. Pending actions survive surface closure through an in-memory recovery
summary. Conflicting local writes are guarded while drafts and unrelated
playlists remain usable.

Membership changes or removal commit atomically with actor-scoped receipts.
Deletion receipts retain only the removed identity, integer terminal revision,
and membership invalidation; current account authorization gates recovery after
the target is gone. Add and editor receipts still require live playlist
ownership and redact newly inaccessible members. Conflicts require explicit
review, and unknown results permit only receipt checks or deliberate replay of
the original frozen attempt. Unsupported actions keep legacy semantics and
truthful pending feedback without replay. Playlist diagnostics include both
actions through the existing bounded aggregate seam.

[Feature 0057: Download commands](../FEATURES/feature-0057-immediate-feedback-and-durable-download-commands.md)
adds the independent `download-command` domain for pause, unpause, stop, retry,
and resume in Current downloads, Library controls, and attempt History. Local
status appears synchronously beside the confirmed worker state. Contradictory
commands serialize per work item; Stop supersedes an unsent pause or visibly
waits for a transmitted pause. An unknown pause keeps Stop queued. Canonical
acknowledgements confirm acceptance without SSE or collection reads, while
worker progress continues to reconcile separately.

Decimal-string command revisions and current attempt identities fence stale
controls and competing tabs. Durable acceptance, its actor-scoped receipt, and
the single new retry/resume attempt commit together before dispatch. Dispatch
claims its effects before cleanup or worker enqueueing. Replays return the same
command/job identity; restart interrupts vanished work without repeating retry
cleanup or launching replacement threads. Terminal control races cannot leave
pause/cancel flags behind. Legacy controls share serialization, current
authorization, generation hints, and revision updates.
Old-worker cleanup preserves a queued successor's accepted flags under the
scheduler lock; legacy Resume clears stale flags during the ownership handoff.

Receipt checks and deliberate frozen-attempt replay retain the shared limits,
expiry, current authorization, and serialized expired-absence finality. Active
work protects its acceptance from every adapter's receipt cleanup. Unknown
results and closed surfaces retain an in-memory recovery summary. Unsupported
servers receive pending feedback without replay. Authentication, deletion, and
access fences cover adopted command callbacks and History reads.
`VDL.downloadCommandMetrics()` exposes bounded, content-free aggregate
diagnostics through the shared seam. Upload transfer and playback sequences
retain their specialized contracts.

## Remaining action adapters

The rows below are explicit migration work, not claims that the app-wide
objective is complete. Existing permission checks and specialized sequencing
remain in force. They need their own behavior and regression evidence before
adopting automatic recovery.

Each remaining row now has a proposed feature spec. These links allocate work;
they do not mark any remaining adapter implemented. Features 0058–0067 inherit Feature
0051 and the shared requirements below.

| Controls / production entry points in `static/app.js` | Existing mechanism | Required migration / recovery boundary | Feature spec |
| --- | --- | --- | --- |
| New download: `submitDownload` | `downloadSubmitting`, probe generation and dialog-session guards | Retain existing immediate submission state. Lost acceptance needs a durable job identity before replay. | [0058: New downloads](../FEATURES/feature-0058-durable-acceptance-for-new-downloads.md) |
| Upload: `registerDroppedVideo`, `transferDroppedVideo`, `stopDroppedUpload` | Local transfer row with preallocated server ID, byte progress, registration acknowledgement and cancellation | Preserve transfer and worker semantics. Do not manufacture playable files or equate abort with server cancellation. | [0059: Uploads](../FEATURES/feature-0059-immediate-feedback-and-recovery-for-uploads.md) |
| Entry removal: `deleteDownload` | Server remove request and collection refresh | Retain marked pending row until acknowledgement; prevent duplicate submission and fence authoritative deletion. Filesystem deletion needs operation-specific recovery. | [0060: Entry removal](../FEATURES/feature-0060-immediate-feedback-and-safe-entry-removal.md) |
| Clear attempts/library: `clearHistory`, `clearLibrary` | Preview counts and explicit confirmation, then server request | Pending confirmation surface and duplicate guard; no claim of deletion before acknowledgement. | [0061: Bulk clear](../FEATURES/feature-0061-immediate-feedback-for-bulk-clear-actions.md) |
| Visibility: `changeDownloadVisibility` | Explicit desired visibility; server permission checks | Display pending request beside confirmed security state. A pending grant must never enable authority. | [0062: Visibility](../FEATURES/feature-0062-immediate-feedback-for-visibility-changes.md) |
| Pairing creation/invalidation: `createExtensionPairing`, `invalidateExtensionPairing` | Server response supplies or invalidates credential; current UI status | Pending controls and session-safe callbacks. Never persist recovery payloads containing credentials in browser storage. | [0063: Pairing](../FEATURES/feature-0063-immediate-feedback-for-extension-pairing.md) |
| Connection revocation: `revokeExtensionConnection` | Confirmation, then server response and connection refresh | Pending state beside confirmed connection; no revoked announcement until acknowledgement. | [0064: Connection revocation](../FEATURES/feature-0064-immediate-feedback-for-connection-revocation.md) |
| User creation/update/suspension/removal: `addUser`, `updateUser`, `setUserSuspended`, removal-dialog close handler | Local edit draft, server authorization and delete confirmation | Pending controls, duplicate guards, draft/epoch safety; pending role changes cannot authorize new actions. | [0065: User administration](../FEATURES/feature-0065-immediate-feedback-for-user-administration.md) |
| Duplicate-index refresh button | Disabled initiating button, server acceptance, background status | Keep acceptance separate from indexing completion; no automatic replay of an unknown job request. | [0066: Duplicate-index refresh](../FEATURES/feature-0066-immediate-feedback-for-duplicate-index-refresh.md) |
| Login/logout forms | Normal browser form navigation and server session guards | Logout clears the client authentication epoch and private drafts; old callbacks cannot revive them. | [0067: Authentication lifecycle](../FEATURES/feature-0067-authentication-epoch-and-form-lifecycle.md) |

## Shared requirements for the remaining specs

The linked specs define proposed behavior and completion criteria, not observed
implementation. Feature 0051 remains the source for shared lifecycle, wire,
security, quota, and replay-window requirements; the
[architecture](immediate-feedback-for-server-backed-interactions.md) owns module
responsibilities. Each adapter must declare its action names, affected views,
conflict boundary, permissions, acknowledgement decoder, and recovery policy
before implementation. The shared contract applies to every linked spec:

- Render local feedback before awaiting transport or reconciliation, within
  the next available frame; use the parent's 50 ms budget in an idle browser.
  Confirm supported results from canonical responses with SSE disconnected.
  Background SSE/reconnect/focus reads remain reconciliation, without polling.
- Keep confirmed state, pending intent, and drafts separate. Preserve stable
  identities, newer draft generations, view tokens, focus, and collection order.
  Reject stale revisions and obsolete membership generations. Never roll back
  an entire object or collection to undo one failed request.
- Use the existing store/coordinator seam and trusted descriptors for discrete
  adopted actions. Keep the frontend raw JavaScript with no build step. New
  domains use decimal-string revisions; existing playlist revisions keep their
  existing type. Do not invent revisions for unsupported contracts.
- Treat lost responses, malformed success, and generic server errors as
  potentially unknown. After five seconds replace spinner-only waiting with
  explanatory text. Definite rejection, conflict, unknown outcome, accepted
  work, and completed work remain distinct. Provide recovery status when the
  originating surface closes; dismissing it cannot cancel transmitted work.
- Preserve the parent's bounded queue and receipt limits. Receipt lookup is
  actor-scoped and current-authorized. Replay, where supported, is deliberate
  and uses the same frozen attempt; none of these specs enables automatic
  mutation replay. Missing receipts and matching reads alone do not prove an
  attempt's outcome. Follow the parent's domain-release/finality rules.
- Add no persistent browser write queue. Clear private state on auth epoch
  changes; known deletion/access loss fences older callbacks. Recheck current
  authorization at execution and recovery. Pending security changes never
  confer authority. Retain existing request-security and output-escaping rules.
- Use existing icons, theme tokens, reduced-motion support, keyboard and touch
  controls, and readable status/error text. Announce meaningful changes once;
  do not rely on color, hover, or animation alone. Keep unrelated work usable.
- Record bounded aggregate local-feedback and acknowledgement timings, outcome
  counts, and reconciliation reads through the shared diagnostic seam. Include
  no user content, credentials, raw paths, or private resource identifiers.

Pending presentation may be delivered before a recovery protocol, as each spec
permits. That is partial delivery, not completion of a spec that requires
durable recovery. Advertise an action capability only after every writer,
serializer, authorization path, receipt/journal, and recovery route meets it.
Do not apply GET contention recovery to mutations. Database receipts do not
establish atomicity for filesystem effects or worker dispatch.

Implementation verification for **each** spec requires deterministic tests of
the production module interface and actual server routes where changed, plus
controlled browser request gates rather than sleeps. Cover held responses,
SSE-free confirmation, stale reads and callbacks, duplicate submission, definite
rejection, conflict where applicable, unknown outcome, access loss, and account
switching. For receipt/job/journal adoption also inject response loss after
commit, simultaneous replay, fingerprint mismatch, expiry, and restart at each
side-effect boundary. Run `./tests/run-all.sh --unit` and record at least **90%
`vdl.py` line coverage**, using Python 3.12 when close to the threshold, relevant
production-module Node tests, and Chromium/Firefox browser regressions. A passing
suite without its coverage result is insufficient. These are future
implementation gates, not claims that the proposed adapters have passed them.

## Delivery dependencies

Numbering follows the inventory, not required implementation order. Extend
authentication fencing (0067) alongside every adapter, including specialized
callbacks. Favorites (0052) exercise an independent scalar domain; preference
and playlist saves (0054–0056) then exercise drafts and existing conflicts.
Playlist editor and quick-add/delete share one revision boundary and must be
compatible even when delivered separately.

Download commands and new submissions (0057–0058) need a consistent durable
acceptance/worker-ownership seam. Uploads (0059) retain their transfer sequence.
Rename and entry removal (0053, 0060) require filesystem recovery before replay;
bulk Library clear (0061) builds on safe per-target removal and a fixed accepted
scope. Security changes (0062–0065) require conservative presentation and
current authorization throughout. Duplicate indexing (0066) retains its job
mechanism without enabling replay. No later spec is implicitly completed by
shipping a dependency.

## Specialized sequences retained

These six rows are retained mechanisms, not additional human-edit adapters.
Their preservation is required regression coverage for the specs above,
particularly authentication lifecycle (0067), upload/download work (0057–0059),
playlist edits (0055–0056), and companion security controls (0063–0064). Do not
mark the wider rollout complete without that evidence.

| Mutation | Existing domain-specific mechanism | Reason to retain it |
| --- | --- | --- |
| Asset demand: `flushAssetDemand` | Batched per-tab revision, latest demand and in-flight guard | High-frequency visibility changes must not become human-edit intents or per-frame requests. |
| Preview leases | Server lease identity and hover lifecycle | A lease is resource management, not an optimistic metadata edit. |
| Playback create/prepare/commit/selection/keepalive/release | Server session, preparation token, load generation and media handoff | Preserve server selection authority, rotation membership and media continuity; request acceptance does not mean playback started. |
| Playlist progress: `savePlaylistProgress` | Monotonic write sequence, position batching and unload keepalive | Preserve ordered progress writes without a spinner or one request per playback tick. |
| View counting: `playVideo` / `markPlaybackStarted` | Playback-generation/start guards and server count | Count only actual playback; the tag queue must not replay a count. |
| Companion extension requests | Separate extension transport and authenticated connection lifecycle | The extension is a separate client. The page coordinator does not imply receipt support for extension commands. |

## Verification commands

Run the Python coverage gate with Python 3.12, the production-module Node tests,
and real browser tag, favorite, rename, and preference interactions. Browser runs use controlled
request gates to exercise pending presentation and canonical confirmation with
SSE unavailable.

```bash
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
node --test tests/*.test.cjs
VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs favorites-feedback.spec.cjs rename-feedback.spec.cjs preferences-feedback.spec.cjs preferences.spec.cjs
VDL_TEST_BROWSER=firefox VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs favorites-feedback.spec.cjs rename-feedback.spec.cjs preferences-feedback.spec.cjs preferences.spec.cjs
```

Verified on 2026-11-08 for version `0.54.0`:

- Python 3.12 unit gate: 539 tests, 9 skipped; `vdl.py` line coverage **92.7%**
  (5905/6373 executable lines; enforced minimum 90%).
- Node: 58 tests passed, including deterministic mutation ordering, receipt
  recovery, stale authentication responses and actual server identity parity.
- Chromium: 73 browser checks passed across tags, immediate feedback, live
  updates, refresh contention, history actions, playlists and authentication.
- Firefox with Python 3.14: all 20 tag and immediate-feedback browser checks
  passed. The unknown-save scenario also passed five consecutive repetitions.
- Python 3.14: 14 transactional tag protocol tests and the identity parity checks
  passed, exercising the interpreter family used by the container.

The controlled browser checks cover the initial tag delivery. They do not
establish completion of the remaining action adapters listed above.

Feature 0052 verified on 2026-11-08 for version `0.55.0`:

- Python 3.12 unit gate: 558 tests, 9 skipped; `vdl.py` line coverage **92.7%**
  (5941/6410 executable lines; enforced minimum 90%). The 19 favorite protocol
  tests cover legacy writers, migration/restart persistence, independent
  revisions, concurrent replay, fingerprint mismatch, authorization changes,
  receipt insertion rollback, post-commit response loss, quotas, and expiry.
- Node: **68 tests passed**, including favorite FIFO isolation, atomic
  acknowledgement merging, stale attempts after receipt recovery, retried
  rejection ordering, malformed acknowledgements, and domain-release safety.
- Chromium and Firefox with Python 3.12: **15 favorite browser checks passed
  in each browser**. Controlled gates establish feedback below 50 ms,
  confirmation without SSE or collection GETs, retained card/control identity,
  visible and announced failures, deliberate replay, queued-intent discard,
  filtered-card retention, rotation renewal deferral, and authentication fences.
- Chromium regression coverage: **88 existing scenarios passed** across tags,
  immediate feedback, history actions, rotation, live updates, refresh
  contention, database contention, playlists, and authentication. The 46 checks
  in the affected history/rotation/refresh suites were rerun after scoping
  preview-star selectors to distinguish the added Info controls.

Favorites inherit authentication fencing for their adopted callbacks. This
does not complete Feature 0067 or any other remaining adapter.

Feature 0053 verified on 2026-11-08 for version `0.56.0`:

- Python 3.12 unit gate: **586 tests, 9 skipped**; `vdl.py` line coverage
  **92.7%** (6361/6865 executable lines; enforced minimum 90%). The 28 rename
  protocol tests cover restart at every journal/filesystem boundary, live
  source/destination replacement, no-clobber retirement, alias ownership,
  removal/retry races, current authorization, admission namespace/clock/quota
  rechecks, expiry, response loss, and completed-journal identity supersession.
- Node: **86 tests passed**, including 18 rename production-interface checks
  for immediate projection, canonical identity, independent domains, stale
  reads/receipts, frozen replay, unknown finality, and authentication/deletion
  fences. Null-file rejection and receipt-denial cases remain distinguishable
  from malformed success and missing receipts.
- Chromium and Firefox with Python 3.12: **19 rename browser checks passed in
  each browser**. Controlled gates verify feedback below 50 ms, confirmation
  without SSE or collection reads, collision and conflict recovery, newer
  drafts, mouse/keyboard controls, both themes, reduced motion, close/reopen,
  lost-response replay, access loss, and account switching. Playback retains
  its video node, source, and fullscreen state while the title follows pending
  and canonical names. Legacy fallback never claims receipt support or treats
  matching reads as proof of an unknown attempt.
- Chromium regressions: **172 distinct scenarios passed** across the rename,
  history actions, worker recovery, tag/favorite, immediate feedback, rotation,
  live update/contention, playlist, playback, upload, attempt-history,
  authentication, and extension settings suites. The final affected-suite run
  passed **50 checks**: 19 rename, 25 history actions, and 6 worker recovery.

Rename's filesystem recovery requires hardlinks, durable directory sync, and
exclusive source retirement. Unsupported or ambiguous filesystem state retains
an explicit intervention requirement. Completed cleanup journals cannot replace
newer canonical file identities. Rename delivery does not complete Features
0054–0067; authentication fencing and removal/retry serialization here cover
the rename integration boundary only.

Feature 0054 verified on 2026-11-08 for version `0.57.0`:

- Python 3.12 unit gate: **613 tests, 9 skipped**; `vdl.py` line coverage
  **92.8%** (6494/6999 executable lines; enforced minimum 90%). The 27
  preference protocol tests cover canonical normalization, migrations and all
  writers, atomic snapshots, concurrent replay and conflicts, actor-scoped
  receipts, fingerprint mismatch, shared quotas and expiry, preflight admission
  races, rollback, directory preparation, durable rotation deadlines, controller
  failures, worker ownership, restart, and debug-reloader timer ownership.
- Node: **102 tests passed**, including 16 preference production-interface
  checks for status-only pending presentation, immutable attempts, canonical
  acknowledgements, stale reads/receipts, explicit conflict review, unknown
  finality, independent domains, authentication/access fences, and diagnostics.
- Chromium and Firefox with Python 3.12: **21 distinct preference browser
  checks passed in each browser**. Controlled gates establish feedback below
  50 ms, confirmation without SSE or collection GETs, retained newer drafts
  and focus, theme preview, duplicate guards, close/reopen, canonical
  normalization, explicit conflict review, deliberate frozen replay, malformed
  success, unknown outcomes, legacy fallback, old denied loads, access loss,
  real account switching, and existing playback paths after directory changes.
  Keyboard, both themes, reduced motion, narrow action layouts, and a polite
  closed-Settings recovery announcement without repeated DOM churn are covered.
- Chromium: **248 distinct scenarios passed**: the 247-scenario regression
  run plus the closed-Settings announcement follow-up. Coverage includes
  preferences/settings, tags/favorites/rename, immediate feedback, history
  actions and pagination, rotation, playback and edge skipping, live updates
  and contention, playlists, uploads, authentication, extension settings, and
  worker recovery. Firefox's 21 distinct preference checks include the final
  stale-denial and announcement follow-ups.

Preference delivery does not complete Features 0055–0067. Authentication fencing
here covers the preference integration boundary; specialized playback,
progress, lease, upload, worker, and companion sequences retain their existing
ownership and recovery contracts.

Playlist editor verification commands for Feature 0055:

```bash
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
VDL_PYTHON=/path/to/python3.12 node --test tests/*.test.cjs
VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py playlists-feedback.spec.cjs playlists.spec.cjs
VDL_TEST_BROWSER=firefox VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py playlists-feedback.spec.cjs playlists.spec.cjs
```

Feature 0055 verified on 2026-11-08 for version `0.58.0`:

- Python 3.12 unit gate: **635 tests, 9 skipped**; `vdl.py` line coverage
  **92.7%** (6607/7131 executable lines; enforced minimum 90%). The 22 new
  playlist protocol tests cover canonical ordered snapshots, integer revisions,
  concurrent replay and competing replacements, fingerprints, actor-scoped
  recovery, rollback, restart, legacy writers, shared quotas and expiry,
  authorization races, member/progress redaction, and unchanged playback and
  rotation ownership. Run the gate separately from browser work: its existing
  1,500-video queue test exceeded its instrumentation deadline under concurrent
  browser load, then passed in the isolated full gate without changing code,
  assertions, or deadlines.
- Node: **118 tests passed**, including 16 playlist production-interface checks
  for synchronous status, immutable ordered attempts, explicit conflict review,
  canonical acknowledgement validation, independent domains, stale snapshots,
  frozen replay, missing-receipt finality, privacy redaction, and auth/deletion
  fences. A retained newer draft keeps its acknowledged base revision even when
  a later quick-add has already advanced the confirmed store.
- Chromium and Firefox with Python 3.12: **29 distinct playlist feedback
  scenarios and 3 existing playlist scenarios passed in each browser** across
  the full runs and focused follow-ups. Controlled gates establish feedback
  below 50 ms, confirmation without SSE or collection reads, stable creation
  identity, duplicate guards, newer ordered drafts and focus, closed/reopened
  editor safety, explicit conflict choices, deliberate replay, malformed or
  unknown outcomes, legacy fallback, access loss, real account switching,
  keyboard errors, both themes, reduced motion, and narrow layouts. A creation
  discovered by reconciliation and then deleted cannot revive its editor,
  shelf card, or recovery presentation when its old acknowledgement arrives.
- Chromium: **381 distinct scenarios passed** across the broad regression run
  and focused follow-ups, covering all adopted mutation adapters, playlists,
  history, playback and controls, rotation, assets, live updates/contention,
  uploads, authentication, Settings, extension settings, and worker recovery.
  Two existing playback tests were corrected to wait for card insertion
  animation and expect the confirmed filename; those checks and a transient
  Settings scroll failure passed their focused rerun.

Playlist editor delivery does not complete Features 0056–0067. Quick-add,
deletion, progress writes, leases, playback sessions, downloads, uploads, and
companion requests retain their existing ownership and recovery contracts.
Feature 0032's import and collaborative-sharing controls remain proposed;
verification here covers personal playlists and videos visible across users.

Playlist add/delete verification commands for Feature 0056:

```bash
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
VDL_PYTHON=/path/to/python3.12 node --test tests/*.test.cjs
VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py playlists-actions-feedback.spec.cjs playlists-feedback.spec.cjs playlists.spec.cjs
VDL_TEST_BROWSER=firefox VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py playlists-actions-feedback.spec.cjs playlists-feedback.spec.cjs playlists.spec.cjs
```

Feature 0056 verified on 2026-11-09 for version `0.59.0`:

- Python 3.12 unit gate: **653 tests, 9 skipped**; `vdl.py` line coverage
  **92.7%** (6649/7169 executable lines; enforced minimum 90%). The 18 new
  protocol tests cover canonical and no-op adds, integer revision conflicts,
  simultaneous replay, immutable fingerprints, shared namespace/quotas/expiry,
  receipt rollback, post-commit response loss, restart, serialized expired
  recovery behind an admitted write, and current authorization. Deletion
  recovery remains actor-scoped after removal and is invalidated by session,
  suspension, account removal, or foreign ownership changes. No former name
  or member data is returned by a deletion receipt.
- Node: **135 tests passed**, including 17 new playlist production-interface
  checks for status-only add/delete intents, shared conflict guards, strict
  canonical acknowledgement decoding, frozen replay, missing-receipt finality,
  independent playlists, deletion/authentication fences, and content-free
  diagnostics. Independently sequenced newer progress survives an older add
  acknowledgement; removed or redacted members cannot regain progress.
- Chromium and Firefox with Python 3.12: **66 distinct playlist scenarios
  passed in each browser**, across full runs and focused follow-ups: 34 new
  add/delete checks, 29 editor feedback checks, and 3 existing playlist checks.
  Controlled request gates establish feedback below 50 ms, canonical
  confirmation without SSE or collection reads, duplicate guards, retained
  shelf identity/order, confirmation cancellation and close/reopen recovery,
  explicit conflict review, deliberate identical-attempt replay, malformed
  success and unknown outcomes, legacy fallback, access loss, real account
  switching, keyboard controls, both themes, reduced motion, and narrow layouts.
  A reopened chooser identifies the original submitted video while its new
  selection remains separate. Closing deletion confirmation with Escape
  preserves active playback. A held committed add response cannot rewind newer
  canonical playback progress.
- Chromium: **355 distinct relevant scenarios passed** across the 354-check
  regression run and the new progress follow-up. Coverage includes all adopted
  mutation adapters, playlists, history, playback and keyboard controls,
  rotation, assets, live updates and contention, uploads, authentication,
  preferences, attempt history, and extension settings. Browser helpers wait
  for actual card animations and Library readiness before opening controls;
  they introduce no arbitrary sleeps or relaxed deadlines.

Playlist add/delete delivery does not complete Features 0057–0067.
Authentication fencing here covers the adopted playlist callbacks. Progress,
leases, playback sessions, workers, uploads, and companion requests retain
their specialized ownership and recovery contracts.

Download command verification commands for Feature 0057:

```bash
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
VDL_PYTHON=/path/to/python3.12 node --test tests/*.test.cjs
VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py download-commands-feedback.spec.cjs history-actions.spec.cjs attempt-history.spec.cjs worker-recovery.spec.cjs live-updates.spec.cjs rename-feedback.spec.cjs duplicates.spec.cjs action-errors.spec.cjs
VDL_TEST_BROWSER=firefox VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py download-commands-feedback.spec.cjs history-actions.spec.cjs attempt-history.spec.cjs worker-recovery.spec.cjs live-updates.spec.cjs rename-feedback.spec.cjs duplicates.spec.cjs action-errors.spec.cjs
```

Feature 0057 verified on 2026-11-09 for version `0.60.0`:

- Python 3.12 unit gate: **683 tests, 9 skipped**; `vdl.py` line coverage
  **92.6%** (6865/7410 executable lines; enforced minimum 90%). The 30 new
  command tests cover correlated acceptance, independent revisions, every
  serializer, concurrent replay, competing and stale attempts, receipt rollback,
  authorization changes, shared quotas and retention, expired recovery behind
  admitted work, unavailable media, and restart before dispatch, during cleanup,
  after enqueueing, and before acknowledgement. Actual worker threads verify
  that legacy Resume preserves a successor's accepted pause while the old
  worker unwinds, and that Stop cancels that queued successor safely.
- Node: **156 tests passed**, including 21 new production-interface checks for
  status-only intents, strict acceptance decoding, immutable replay, independent
  metadata, unsent-pause supersession, queued Stop, unknown finality, stale
  generations, null generations after History cleanup, authentication fences,
  and accepted receipts whose dispatch is still in progress. A mixed-domain
  regression proves a metadata-only rename acknowledgement still installs its
  canonical filename while explicit older worker snapshots remain fenced.
- Chromium and Firefox: **25 new command scenarios passed in each browser**.
  Controlled request gates verify feedback below 50 ms, explicit confirmed
  worker status, SSE-free acceptance without collection reads, duplicate
  guards, queued and unknown pause/Stop sequences, deliberate identical-attempt
  replay, lost responses, malformed success, refusal, access loss, real account
  switching, closed-surface recovery, stale actual controls and callbacks,
  keyboard use, both themes, reduced motion, and one announcement per change.
- Chromium: **605 distinct scenarios passed** across the broad regression run
  and focused follow-ups. Firefox: **100 distinct scenarios passed** across
  the affected suites and earlier focused regressions. Coverage includes
  existing mutation adapters, History, duplicate views, playback and fullscreen,
  rotation, assets, live updates and contention, uploads, authentication,
  preferences, and extension settings. The final backend handoff fix also passed
  all **31 command/worker browser checks in each browser**. Existing fixtures
  now use canonical metadata and real command acceptances; helpers wait for
  actual insertion animations without arbitrary sleeps or relaxed assertions.

Download command delivery does not complete Features 0058–0067. New-download
acceptance, upload transfers, playback sessions, leases, progress writes, and
companion requests retain their specialized ownership and recovery contracts.
Authentication fencing here covers the adopted commands and History callbacks.
