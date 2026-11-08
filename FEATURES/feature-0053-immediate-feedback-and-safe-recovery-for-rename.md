# Immediate feedback and safe recovery for rename

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Open, close, and edit the rename field locally. On submission, show the
requested display name with **Renaming…**, while the last confirmed file
identity remains authoritative. Enable receipt-based replay only after a
durable filesystem journal and restart recovery can establish the result.

## User-visible behavior

- `renameStart`, `renameCommit`, and `renameCancel` retain separate editor
  drafts and view tokens. Starting or cancelling editing requires no read.
  Cancelling after submission closes the editor; it does not cancel the rename.
- Show the requested name wherever this entry is displayed, clearly marked
  pending. Preserve the current card position, playback, fullscreen, and file
  identity. A requested name must never become a speculative playback path.
- Prevent duplicate submission of the captured rename. Keep subsequent typing
  as a newer draft; do not dispatch another rename until the current attempt
  settles. A callback may clear or focus only its original draft generation.
- Canonical acknowledgement supplies the actual display name and final file
  identity. A definite failure preserves the requested text with an error and
  lets the user correct it without overwriting newer typing.
- Unknown outcomes display **Rename not confirmed** and recovery actions.
  Closing/reopening Info retains that state without reopening or focusing it
  from an old callback.

## State and server contract

Declare an entry rename conflict domain and persistent revision, independent
of tags and download progress. Keep the existing basename validation: reject
`/`, `\`, NUL, `.`, and `..`; preserve the original extension and existing
collision and permission rules. The server chooses and validates final paths
from the stored file identity, never a changed download-directory preference.

Before enabling replay, persist an actor-bound operation identity, fingerprint,
source identity, intended destination, and recovery phase before filesystem
effects. Define and test recovery for interruption before the move, after the
move but before the database update, and after database commit but before the
response. Recovery must distinguish the intended file from an unrelated file
subsequently placed at either path. Never overwrite a collision or infer success
only from a filename existing.

Serialize conflicting operations on the same file, including removal. Do not
hold the SQLite write lock across filesystem work. Journal transitions and
canonical publication must make the operation recoverable without claiming an
atomic transaction across SQLite and the filesystem. Ambiguous filesystem
state remains an explicit recoverable failure requiring intervention.

## Recovery and compatibility

Until the journal is implemented and tested, deliver pending presentation
through the existing endpoint with no replay capability. A targeted authorized
read may show current state, but cannot prove a lost attempt completed or make
an in-flight rename safe to repeat.

The complete adapter returns a final canonical result or a durable accepted
operation ID with server-owned recovery status. Receipt lookup and deliberate
same-attempt replay resume or report that operation rather than moving a file
again. Recheck current authorization; expose no raw recovery paths to the UI.
Deletion, access loss, and auth epochs fence stale acknowledgements.

## Acceptance criteria

1. Editor transitions are local; a held submit immediately shows the requested
   name and pending status without disrupting playback or another draft.
2. With SSE blocked, canonical acknowledgement confirms the actual name/path
   identity; older reads and receipts cannot restore an earlier rename.
3. Validation, collisions, permission errors, repeated submit, and a newer
   draft preserve text, focus, the original extension, and safe file access.
4. Inject a restart at every journal boundary. Repeated recovery produces one
   intended rename or an explicit unresolved state, never a second move,
   overwritten unrelated file, orphaned database path, or false success.
5. Race rename with deletion and another rename, including aliases where
   supported. Current authorization and operation ownership remain decisive.
6. Test response loss after completion, receipt replay, close/reopen, logout,
   keyboard operation, and both themes. Complete shared verification; do not
   advertise safe replay before the filesystem recovery evidence exists.
