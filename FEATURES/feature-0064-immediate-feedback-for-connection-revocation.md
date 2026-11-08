# Immediate feedback for connection revocation

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0026, Firefox companion](feature-0026-download-authenticated-pages-with-firefox.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

After the existing confirmation, `revokeExtensionConnection` immediately shows
**Revoking connection…** beside the last confirmed connection state. Do not
remove the connection or announce revocation until the server confirms it.

## User-visible behavior

- Preserve confirmation and show the connection being targeted. Cancelling
  before submission sends nothing. Pending submission disables duplicate
  revocation for that connection, while unrelated connections stay usable.
- Retain the connection row and its identity while pending. If its dialog
  closes, keep a compact status in the connection list; a late callback cannot
  reopen the dialog or act on a new selection.
- On valid acknowledgement, update or remove the row according to existing
  revoked-connection presentation. Confirmation must not require SSE or a full
  Settings refresh. Explain that this revokes this connection under existing
  semantics; it is not proof that every already accepted job was cancelled.
- Definite rejection retains current confirmed connection status and error.
  Unknown outcome says **Revocation not confirmed** and offers status checking.
  Neither a timeout nor a disappeared row alone proves this attempt committed.

## State and server contract

Use a per-connection mutation boundary with stable server identity and its
current generation/version. Resolve current actor/session and revocation
permission inside the transaction. A pending request grants no security state.

Commit revocation and an actor-bound receipt atomically before acknowledging
success. Return a correlated, non-secret canonical revocation result. Enforce
the actual credential rejection on the server; changing the row is not the
security mechanism. Do not store or expose connection bearer credentials in
client mutation records, recovery responses, logs, or SSE.

Repeated identical revocation returns the same outcome without revoking any
new connection, pairing, or replacement credential. Receipt lookup must remain
authorized after the connection record is removed using a minimal operation
identity, without exposing former private connection details. Revalidate
current permissions rather than relying on the initiating confirmation.

Fence a confirmed removed/revoked connection against older connection-list
responses and acknowledgements. A newly established connection has its own
identity and must not inherit the old connection's pending revocation.

## Recovery and compatibility

Enable bounded receipt checking and deliberate same-attempt replay only after
the transactional contract is implemented and tested. Do not automatically
repeat an unknown revocation or create a fresh command on reconnect. Until
then, keep existing response/refresh semantics with truthful pending controls.

Auth epoch reset clears private connection and pending state before callbacks
can apply. Page-level recovery does not change extension request transport,
accepted download work, or its independent authentication lifecycle.

## Acceptance criteria

1. A held confirmed revocation shows immediate status, retains the row, and
   rejects duplicate clicks without blocking other connections.
2. SSE-free acknowledgement updates the correct connection once. Older list
   responses, closed dialogs, and changed selection cannot restore or misapply it.
3. Lose the response after commit, replay simultaneously, and replace the
   connection: only the intended identity is revoked, with no secret disclosure.
4. Verify the revoked credential actually fails server authentication; already
   accepted work follows its existing lifecycle. Test revocation permission loss,
   account switch, expiry, keyboard feedback, both themes, and shared gates.
