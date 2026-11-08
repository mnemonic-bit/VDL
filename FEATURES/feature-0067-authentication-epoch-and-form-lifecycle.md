# Authentication epoch and form lifecycle

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented for the remaining action adapters\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0023, Authentication and users](feature-0023-require-authentication-and-manage-users.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Keep login and logout as normal browser form navigation with existing server
session guards. Extend authentication-epoch fencing across every remaining
adapter and specialized callback. Signing out or switching accounts must clear
private drafts and prevent old responses from restoring them or sending work.

## Form behavior

- Preserve existing form destinations, methods, validation, redirects, session
  rotation, and request-security checks. Do not migrate credentials into JSON
  mutation receipts or a client-side authentication write queue.
- On an admitted form submission, immediately show **Signing in…** or
  **Signing out…** and prevent duplicate submit without disabling required form
  data before the browser constructs the request. Keyboard submission and
  normal navigation must still work when enhancement scripts are unavailable.
- On logout submission, advance the client auth epoch before clearing private
  snapshots, editor drafts, pairing secrets, queued unsent intents, and recovery
  presentation. Old callbacks cannot render, restore focus, retry, dispatch a
  successor, or retain a secret. Cancel local waits where useful, while making
  no claim that submitted server work was cancelled.
- Client clearing is not proof of server logout. Only the server can invalidate
  the session. If navigation fails or returns an error, show a neutral session
  verification path; do not restore old private state from a backup or announce
  that the session ended merely because the form was submitted.
- A failed login displays the existing server error and permits resubmission.
  Never restore passwords from client mutation state or an earlier account.

## Authentication lifecycle contract

Every async operation captures the active auth epoch: mutation responses,
receipt reads, collection/SSE reconciliation, settings/user/connection reads,
upload callbacks, probe callbacks, and specialized playback/asset callbacks
where they can affect private UI or dispatch new requests. Reject results from
earlier epochs before any state merge, DOM update, or follow-on work.

Apply the same reset on session expiry, authoritative authentication denial,
and detected account change. Distinguish target-level access denial from loss
of the whole session; fence only the target when the session remains valid.
Bootstrap an authenticated page from new authorized state and capabilities,
never from another account's pending projections. No mutation queue survives
reload. Preserve legitimate server work independently of client presentation.

For other open tabs, use existing authentication reconciliation and ordinary
focus/reconnect paths to discover session changes. A response or page identity
must not be merged into an older account's store. This spec does not promise
instant erasure in sleeping/offline tabs or add polling or a new cross-tab
credential transport. The server authorizes every request regardless of epoch.

## Specialized sequence preservation

Retain asset-demand batching and per-tab revision, preview lease ownership,
playback sessions and preparation tokens, load generations and media handoff,
playlist progress sequences/unload keepalive, and actual-playback view-count
guards. Auth reset must stop unauthorized follow-on work without replaying
counts or progress, spinning on each tick, or granting stale media authority.
Use existing release/cleanup semantics; local abort is not confirmed release.

Companion extension requests remain a separate authenticated client. The page
epoch does not revoke an extension credential or make extension commands
receipt-capable; explicit connection revocation has its own feature spec.

## Acceptance criteria

1. Login/logout work by keyboard and normal form navigation with scripts both
   enabled and unavailable. Pending feedback prevents duplicate enhanced submits
   without losing form fields or weakening server/session protections.
2. Hold each class of response, sign out or change account, then release it.
   No old private data, draft, pairing secret, focus change, receipt replay, or
   queued successor appears in the new epoch.
3. Simulate failed logout navigation, session expiry, suspension, and target-only
   denial. Session uncertainty stays truthful, and target denial does not
   unnecessarily erase an otherwise valid authenticated editor elsewhere.
4. Reopen/focus another tab after a server session change: authorized bootstrap
   prevents mixed-account state without polling or persistent write queues.
5. Exercise asset demand, leases, playback handoff, progress keepalive, view
   counting, and extension isolation during reset. Their existing ordering,
   batching, count-on-play, and transport guarantees remain intact.
6. Verify no credentials in browser recovery storage, logs, metrics, or SSE;
   test accessible form status, both themes, and all shared implementation gates.
