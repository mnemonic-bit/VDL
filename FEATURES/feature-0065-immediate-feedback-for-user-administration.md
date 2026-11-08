# Immediate feedback for user administration

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0023, Authentication and users](feature-0023-require-authentication-and-manage-users.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Give `addUser`, `updateUser`, `setUserSuspended`, and the user-removal dialog's
confirmed submission immediate pending feedback. Preserve local drafts and
confirmation, while leaving roles, suspension, and deletion server-authoritative.
Pending account changes cannot authorize any additional action.

## User-visible behavior

- Show **Creating user…**, **Saving user…**, **Suspending…**, **Restoring…**, or
  **Removing user…** at the initiating controls. Prevent duplicate submission of
  the captured operation; unrelated users and newer edit drafts remain usable.
- Display requested role/suspension beside confirmed state. Do not mark an
  account suspended, active, removed, or newly privileged before confirmation.
  Keep a pending removal row or confirmation surface until its result is known.
- User creation may have a clearly pending placeholder, but it cannot be used
  as a confirmed account or supply login authority. Map it once to the canonical
  server identity on success.
- Keep submitted draft generations separate from later edits. A response may
  clear, close, or focus only its originating editor. Definite validation failure
  retains recoverable non-secret fields and reports field errors.
- Unknown results retain **Change not confirmed** and block contradictory
  writes for that account. Do not repeat account creation, password changes, or
  removal with a new request ID to compensate for a lost response.

## State, authorization, and server contract

Declare a per-user administration conflict domain; creation uses a local
operation identity until a server ID exists. Add a persistent revision for
adopted editable user state. Preserve existing self-edit, self-removal,
last-administrator, username uniqueness, ownership cleanup, and session rules.

Check current actor authority and target state inside each write transaction.
Update the account, revision, necessary session invalidation, and receipt
atomically. Return only canonical authorized non-secret user fields and the
correlated outcome. All administrative writers must participate in the same
revision and invariant checks; a client queue cannot enforce global invariants.

For passwords or other secrets, bind replay identity through a server-protected
fingerprint without retaining plaintext or exposing secret-derived material in
responses/logs. The client must not put passwords in generic projected state,
metrics, persistent recovery storage, or failed-draft summaries. Recovery reads
return only non-secret outcome. After definite failure or auth reset, discard
secret request material; correction requires deliberate re-entry as appropriate.

Account removal must preserve the existing cleanup policy. Database cleanup
and receipt publication are transactional where possible. If it includes
filesystem or other external effects, operation-specific durable recovery is a
prerequisite for replay. Minimal deletion outcomes may remain for the authorized
administrator without retaining the removed user's private content.

## Recovery and lifecycle

Provide current-authorized receipt lookup and deliberate identical-attempt
replay only for audited operations. Conflicts require explicit review and a
new attempt. Unsupported operations retain pending presentation without replay.
An account creation replay returns the same account, not another username/ID.

If an acknowledgement or authoritative denial invalidates the current session,
advance the auth epoch and clear private snapshots/drafts before further
callbacks. A pending promotion never enables admin controls, and a late prior
response cannot restore authority after demotion, suspension, or logout.

## Acceptance criteria

1. Gate create, update, suspend/restore, and remove. Feedback appears immediately;
   repeated clicks are guarded and confirmed role/state remains distinguishable.
2. With SSE blocked, canonical success updates only the target and submitted
   generation. Newer drafts, different selections, and reopened dialogs survive.
3. Concurrent admins cannot lose updates or violate self/last-admin safeguards.
   Race permission loss and target removal with execution and recovery.
4. Lost-response creation/password/update/removal recovery repeats no effect,
   leaks no secrets, and creates no duplicate account. Test removal crash phases
   when external cleanup applies; do not enable replay without that evidence.
5. Demotion, suspension, account switch, and logout fence old callbacks and
   private drafts. Verify secret handling, keyboard errors, both themes, and
   shared verification including authorization and account-cleanup regressions.
