# Immediate feedback and safe entry removal

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in version `0.63.0`\
**Last refined:** 2026-11-09\
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

## Adapter and recovery contract

The registered action is `entry.remove` in the independent `entry-removal`
domain. Current downloads, Library cards, Info, and the compact recovery summary
share its status-only intent. Pending removal retains the confirmed entry and
playback identity. It blocks duplicate removal and conflicting writes to that
entry while other entries remain usable.

The negotiated `entry_removal: 1` capability and `entry.remove` action advertise
the protocol. `POST /api/remove/<id>` accepts `client_mutation_id`, a decimal-string
`expected_revision` from `removal_revision`, and an explicit `scope`.
`entry-and-files` retains the existing removal control's cleanup semantics;
`entry` removes the record while retaining media bytes. Recovery binds the scope
to the original frozen request and cannot upgrade it to a destructive scope.
Legacy requests retain their existing scope and response fields.

A committed acknowledgement includes the correlated target, `removed: true`,
the exact scope, terminal decimal-string `removal_revision`, and a `mutation`
with the same ID, `entry-removal` domain, `entry.remove` action, committed
outcome, and terminal revision. Only a validated acknowledgement or authorized
receipt retires the intent and installs the deletion fence. Neither a matching
read nor absence from a collection establishes the request's outcome.

The existing authenticated visibility rules apply to removal. Current actor,
session, target authorization, resource generation, and worker eligibility are
checked at the serialized execution boundary. Recovery remains actor-scoped
after the row is gone, exposing only the removed identity and outcome rather
than former titles, tags, or paths. The shared receipt namespace, quotas,
admission window, retention, and serialized expired-absence finality apply.

File removal uses the `removal_operations` journal before filesystem effects.
It records the captured artifact identities and operation-owned paths. Pinned
hardlinks and exclusive source retirement let recovery check the file actually
claimed before deleting it, preserving unrelated replacements. The journal
shares the file-operation, asset-publication, and worker-ownership boundaries.
Database publication removes playlist membership and the entry, retains
attempt History snapshots, and records the terminal receipt together. Owned
cleanup must complete before recovery reports success. Ambiguous identity or
partial cleanup retains an explicit unresolved outcome and intervention state.

Unknown outcomes offer authorized receipt checking and deliberate replay of
the same frozen attempt. No mutation is replayed automatically. Unsupported
servers receive truthful pending feedback through the legacy endpoint without
invented revisions or receipt recovery. Authentication reset clears private
presentation and obsolete callbacks; deletion fences prevent older reads and
metadata acknowledgements from recreating the removed entry.

## Verification

The [rollout inventory](../ARCHITECTURE/feature-0051-rollout.md) records version
`0.63.0` verification commands and completion evidence. Protocol and filesystem
recovery checks live in `tests/test_entry_removal.py`; independent request and
authorization checks live in `tests/test_entry_removal_security.py`. Production
coordinator tests use `tests/removal-client.test.cjs`, and controlled real-UI
checks use `tests/browser/entry-removal-feedback.spec.cjs`.
