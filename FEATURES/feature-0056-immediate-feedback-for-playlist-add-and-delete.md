# Immediate feedback for playlist add and delete

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in version `0.59.0`; verification recorded in the rollout inventory\
**Last refined:** 2026-11-09\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0031, Playlists](feature-0031-add-personal-video-playlists.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Give `quickAddToPlaylist` and `deletePlaylist` immediate request feedback at
their initiating controls. Keep playlist membership and deletion confirmed by
the server, preserve existing delete confirmation, and add receipt-safe recovery
before allowing any retry of an uncertain request.

## User-visible behavior

- Quick-add shows **Adding to playlist…** beside the selected destination and
  entry. Prevent duplicate submission of that add; unrelated playlists remain
  usable. A pending label does not claim confirmed membership or alter playback.
- On canonical acknowledgement, update that playlist's confirmed membership and
  the initiating control without waiting for a shelf refresh. A no-op already
  present result is a confirmed result, not a second membership or error.
- Delete retains its existing confirmation. After confirmation, show
  **Deleting playlist…** on the confirmation surface and mark the shelf item
  pending. Keep its identity and position until acknowledgement; prevent a
  second delete and contradictory local writes while it is unresolved.
- Definite rejection restores ordinary controls from current confirmed state.
  Unknown results retain a compact **Add/Delete not confirmed** status and
  recovery actions even if the original menu or dialog closes.
- Deleting a playlist does not claim deletion of its videos or media files.
  Preserve existing playback-session behavior when a playlist disappears.

## State and server contract

### Adopted action boundary

- **Actions:** `playlist.add` and `playlist.delete`, sharing domain `playlist`
  with editor creation/replacement. The existing integer revision is retained.
  One unresolved transmitted action blocks contradictory writes to its playlist;
  unrelated playlists and unsubmitted editor drafts remain usable.
- **Affected views:** the quick-add destination and entry, deletion confirmation
  surface, affected shelf card, and an in-memory recovery summary that remains
  available when the initiating surface closes. Pending state is status only:
  it grants no membership, playback selection, or deletion authority.
- **Add wire:** `POST /api/playlists/<id>/items` accepts `download_id`, integer
  `expected_revision`, and `client_mutation_id`. A canonical playlist response
  includes `changed` and the correlated `playlist` mutation result. An already
  present member returns `changed: false` and the unchanged revision; an append
  advances the revision once and preserves existing order.
- **Delete wire:** `DELETE /api/playlists/<id>` accepts integer
  `expected_revision` and `client_mutation_id`. A committed response contains
  the removed `id`, `removed: true`, `membership_invalidated: true`, and the
  integer terminal revision (`expected_revision + 1`), correlated through
  `mutation`. It contains no former playlist name or member data. Conflicts and
  validation rejections return the current authorized canonical playlist and
  their correlated outcome. Empty-body legacy deletion retains its existing
  204 response.
- **Permissions and recovery:** the serialized transaction checks the current
  actor/session, ownership, and added-entry visibility/playability. Receipts
  share the actor-scoped namespace, quotas, expiry, and deliberate frozen-attempt
  replay contract. Deletion recovery requires a currently authorized account;
  old add/replacement receipts still require live playlist ownership and redact
  member details that are no longer visible.

Coordinate quick-add, editor replacement, and deletion in the same playlist
conflict boundary as [Feature 0055](feature-0055-immediate-feedback-for-playlist-editor-saves.md).
Preserve the existing playlist revision type. Freeze the desired add and
expected revision when dispatched; do not automatically reapply it after a
conflict with a newer ordered list.

Authorize actor, playlist edit/delete permission, and added-entry access inside
the mutation transaction. Persist receipts with the membership update or
playlist removal. Quick-add returns canonical playlist state/revision. Delete
returns a correlated removed identity and membership invalidation; retain
enough actor-bound deletion outcome to recover after the target no longer
exists, without exposing its former private content or bypassing current
authorization. Account loss invalidates recovery access.

Deletion invalidates older shelf and member reads and installs a removal fence.
An older add or replacement acknowledgement cannot recreate the deleted
playlist. Collection absence caused by filtering is not a deletion receipt.

## Recovery and compatibility

Offer bounded receipt checks and deliberate replay of the same immutable
attempt only after the transactional contract is supported. Never issue a fresh
delete because a response was lost. A revision conflict requires current-state
review and a new explicit attempt. Unknown outcomes pause affected writes.

Without capability support, retain current endpoint semantics, pending controls,
and no replay. Closing a dialog, aborting a fetch, or dismissing an error is not
server cancellation. No pending playlist work persists across page reloads.

## Acceptance criteria

1. Held add/delete requests show immediate status and reject duplicate clicks;
   unrelated playlists and editor drafts remain usable.
2. With SSE blocked, add confirmation updates membership directly and delete
   confirmation removes the shelf item once. Old reads cannot revive it.
3. Add versus replacement, add versus deletion, and concurrent remote writes
   preserve ordered membership and explicit revision conflicts.
4. Lost responses, duplicate replay, absent receipts, and expired attempts do
   not create repeated adds, fresh destructive commands, or private-data leaks.
5. Test confirmation cancellation, menu/dialog close and reopen, access loss,
   logout, active playlist playback, keyboard status, and both themes. Complete
   shared verification alongside playlist editor and playback regressions.
