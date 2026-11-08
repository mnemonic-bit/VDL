# Immediate feedback and safe entry removal

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0036, Attempt History](feature-0036-add-download-attempt-history.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Make `deleteDownload` retain a marked **Removing…** row or card until the
server confirms removal. Guard duplicate requests and fence older reads after
confirmed deletion. File deletion requires its own durable recovery contract;
a SQLite receipt cannot establish whether a filesystem effect completed.

## User-visible behavior

- Preserve existing permission checks and any confirmation required by the
  current action, including its distinction between record and file removal.
  Capture that exact removal scope before sending it.
- Mark the initiating row pending immediately, retaining identity, location,
  and an accessible explanation. Disable duplicate removal and contradictory
  writes to the target while pending. Other entries remain usable.
- Do not hide the target or announce deletion before acknowledgement. Keep
  existing playback behavior until authoritative removal; afterward remove
  invalid playback targets according to the player lifecycle.
- On definite rejection, restore controls from current confirmed state, not an
  old whole-entry backup. Unknown results keep **Removal not confirmed** and
  recovery actions; dismissing the message is not cancellation.
- Confirmed media removal preserves attempt History snapshots with truthful
  media-removed information. It does not erase historical attempts or imply a
  bulk clear operation.

## State and server contract

Bind the actor, entry identity, removal scope, current resource/file generation,
and mutation ID to the removal operation. Recheck authorization and eligibility
at execution. Serialize removal against rename, transfer finalization, and
conflicting worker operations; never delete a replacement file using stale path
information. Use stored validated file identity, not current preferences.

For database-only removal, commit a correlated deletion outcome and receipt
with the change. For file removal, durably record operation ownership and
recovery phases before effects. Define restart behavior before/after unlink
and before/after database publication; handle missing files as the existing
domain contract allows without mistaking an unrelated file for the target.
Report partial failure truthfully rather than announcing complete removal.

Return only the authorized outcome needed to remove the presentation. Recovery
must remain possible when the record is gone through actor-bound operation
authorization without revealing deleted private metadata. No resource ID is
reused, and no receipt contains unrestricted filesystem paths for the client.

On confirmation, atomically retire pending state and install a removal fence.
Invalidate older relevant collection membership reads. Delayed acknowledgements
for other metadata edits cannot recreate the entry. Absence from a filter,
page, or rotation alone never proves deletion.

## Recovery and compatibility

Pending presentation can ship with the existing endpoint. Do not enable replay
until the selected removal scope has transactional or journaled recovery.
Then offer authorized receipt/status checking and deliberate same-attempt
replay; never a fresh destructive request to replace an unknown one. A lost
response or cancelled fetch does not establish whether files were removed.

## Acceptance criteria

1. A held removal retains a marked row, prevents duplicate requests, and keeps
   unrelated work usable. Cancellation before submit sends nothing.
2. With SSE blocked, confirmation removes it once. Inject older collections and
   metadata acknowledgements: neither restores the entry or ordinary controls.
3. Reject or lose a response without restoring stale fields or announcing a
   deletion that is not established. Preserve attempt History correctly.
4. Crash at every filesystem/database boundary and recover without deleting a
   replacement file, repeating unsafe effects, or concealing partial failure.
5. Race rename, worker completion, access revocation, another client's removal,
   and logout. Verify playback, keyboard status, both themes, and shared gates.
