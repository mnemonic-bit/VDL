# Feature 0051 rollout inventory

This inventory separates the initial tag delivery from the remaining app-wide
migration in [Feature 0051](../FEATURES/feature-0051-immediate-feedback-for-server-backed-interactions.md).
The shared coordinator registers `tag.add`, `tag.remove`, `favorite.set`, and
`rename.set`.
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

## Remaining action adapters

The rows below are explicit migration work, not claims that the app-wide
objective is complete. Existing permission checks and specialized sequencing
remain in force. They need their own behavior and regression evidence before
adopting automatic recovery.

Each remaining row now has a proposed feature spec. These links allocate work;
they do not mark any remaining adapter implemented. Features 0054–0067 inherit Feature
0051 and the shared requirements below.

| Controls / production entry points in `static/app.js` | Existing mechanism | Required migration / recovery boundary | Feature spec |
| --- | --- | --- | --- |
| Preferences: `savePreferences` | Captured form submission; effects apply after acknowledgement; local theme preview | Saving presentation, newer draft generations, duplicate guards and canonical acknowledgement. Sensitive effects wait for confirmation. | [0054: Preferences](../FEATURES/feature-0054-immediate-feedback-for-preference-saves.md) |
| Playlist create/replace: `savePlaylistEditor` | Local draft, existing `expected_revision` on replace, server conflict response | Saving state, duplicate guards, retained newer drafts and explicit conflict recovery. Preserve the existing revision type. | [0055: Playlist editor](../FEATURES/feature-0055-immediate-feedback-for-playlist-editor-saves.md) |
| Playlist add/delete: `quickAddToPlaylist`, `deletePlaylist` | Server response, deletion confirmation, playlist refresh | Pending initiating controls and receipt-safe recovery before retries. | [0056: Playlist add/delete](../FEATURES/feature-0056-immediate-feedback-for-playlist-add-and-delete.md) |
| Pause/unpause/stop/retry/resume: download controls and attempt-history actions | Worker status remains server-owned; collection reconciliation | Request feedback is separate from worker transition. Durable job acceptance and crash recovery are required before replay. | [0057: Download commands](../FEATURES/feature-0057-immediate-feedback-and-durable-download-commands.md) |
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
and real browser tag, favorite, and rename interactions. Browser runs use controlled
request gates to exercise pending presentation and canonical confirmation with
SSE unavailable.

```bash
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
node --test tests/*.test.cjs
VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs favorites-feedback.spec.cjs rename-feedback.spec.cjs
VDL_TEST_BROWSER=firefox VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs favorites-feedback.spec.cjs rename-feedback.spec.cjs
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
