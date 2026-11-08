# Feature 0051 rollout inventory

This inventory separates the initial tag delivery from the remaining app-wide
migration in [Feature 0051](../FEATURES/feature-0051-immediate-feedback-for-server-backed-interactions.md).
The shared coordinator currently registers only `tag.add` and `tag.remove`.
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

## Remaining action adapters

The rows below are explicit migration work, not claims that the app-wide
objective is complete. Existing permission checks and specialized sequencing
remain in force. They need their own behavior and regression evidence before
adopting automatic recovery.

| Controls / production entry points in `static/app.js` | Existing mechanism | Required migration / recovery boundary |
| --- | --- | --- |
| Favorite: `toggleFavorite` | Explicit desired boolean; later collection reconciliation | Independent favorite revision, pending star projection, FIFO intents, canonical acknowledgement and receipts. Preserve card order. |
| Rename: `renameStart`, `renameCommit`, `renameCancel` | Separate draft and disabled submit controls; server owns final path | Local editor transitions and requested display name. Durable filesystem journal and crash recovery must precede replay. |
| Preferences: `savePreferences` | Captured form submission; effects apply after acknowledgement; local theme preview | Saving presentation, newer draft generations, duplicate guards and canonical acknowledgement. Sensitive effects wait for confirmation. |
| Playlist create/replace: `savePlaylistEditor` | Local draft, existing `expected_revision` on replace, server conflict response | Saving state, duplicate guards, retained newer drafts and explicit conflict recovery. Preserve the existing revision type. |
| Playlist add/delete: `quickAddToPlaylist`, `deletePlaylist` | Server response, deletion confirmation, playlist refresh | Pending initiating controls and receipt-safe recovery before retries. |
| Pause/unpause/stop/retry/resume: download controls and attempt-history actions | Worker status remains server-owned; collection reconciliation | Request feedback is separate from worker transition. Durable job acceptance and crash recovery are required before replay. |
| New download: `submitDownload` | `downloadSubmitting`, probe generation and dialog-session guards | Retain existing immediate submission state. Lost acceptance needs a durable job identity before replay. |
| Upload: `registerDroppedVideo`, `transferDroppedVideo`, `stopDroppedUpload` | Local transfer row with preallocated server ID, byte progress, registration acknowledgement and cancellation | Preserve transfer and worker semantics. Do not manufacture playable files or equate abort with server cancellation. |
| Entry removal: `deleteDownload` | Server remove request and collection refresh | Retain marked pending row until acknowledgement; prevent duplicate submission and fence authoritative deletion. Filesystem deletion needs operation-specific recovery. |
| Clear attempts/library: `clearHistory`, `clearLibrary` | Preview counts and explicit confirmation, then server request | Pending confirmation surface and duplicate guard; no claim of deletion before acknowledgement. |
| Visibility: `changeDownloadVisibility` | Explicit desired visibility; server permission checks | Display pending request beside confirmed security state. A pending grant must never enable authority. |
| Pairing creation/invalidation: `createExtensionPairing`, `invalidateExtensionPairing` | Server response supplies or invalidates credential; current UI status | Pending controls and session-safe callbacks. Never persist recovery payloads containing credentials in browser storage. |
| Connection revocation: `revokeExtensionConnection` | Confirmation, then server response and connection refresh | Pending state beside confirmed connection; no revoked announcement until acknowledgement. |
| User creation/update/suspension/removal: `addUser`, `updateUser`, `setUserSuspended`, removal-dialog close handler | Local edit draft, server authorization and delete confirmation | Pending controls, duplicate guards, draft/epoch safety; pending role changes cannot authorize new actions. |
| Duplicate-index refresh button | Disabled initiating button, server acceptance, background status | Keep acceptance separate from indexing completion; no automatic replay of an unknown job request. |
| Login/logout forms | Normal browser form navigation and server session guards | Logout clears the client authentication epoch and private drafts; old callbacks cannot revive them. |

## Specialized sequences retained

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
and real browser tag interactions. Browser runs use controlled request gates to
exercise pending chips and canonical confirmation with SSE unavailable.

```bash
VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit
node --test tests/*.test.cjs
VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs
VDL_TEST_BROWSER=firefox VDL_PYTHON=/path/to/python3.12 python3 tests/browser/run.py tags.spec.cjs immediate-feedback.spec.cjs
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
