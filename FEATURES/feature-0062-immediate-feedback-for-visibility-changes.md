# Immediate feedback for visibility changes

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0023, Authentication and users](feature-0023-require-authentication-and-manage-users.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Make `changeDownloadVisibility` show the requested visibility as pending beside
the last confirmed security state. The UI must never announce a video is private
or public, or enable newly permitted actions, before server acknowledgement.

## User-visible behavior

- Capture an explicit desired visibility. Immediately show, for example,
  **Public · Changing to private…**. Keep the confirmed state readable while
  guarding duplicate submission and contradictory local visibility requests.
- Unrelated metadata remains usable subject to confirmed permissions. Pending
  visibility does not change server playback selection, sharing authority, or
  another user's access. Every actual operation independently authorizes access.
- Confirm the canonical visibility and permissions directly from a valid
  response, even with SSE unavailable. Do not infer security success from a
  local projection, absent collection row, elapsed time, or generic SSE hint.
- On definite rejection, keep current confirmed visibility and explain the
  failure. Unknown results say **Visibility change not confirmed** while
  retaining both requested and last confirmed values, without claiming the
  last confirmed value is necessarily still current on the server.
- If the user loses access, immediately fence and remove private presentation,
  including pending metadata. Do not keep the item visible merely to display a
  visibility error. Other clients converge through authorized reconciliation.

## State and server contract

Declare an entry visibility conflict domain with a persistent revision for new
protocol clients. Keep it independent of favorite, tags, and progress. All
visibility writers advance it on actual change. Supply visibility, revision,
and presentation permissions from a consistent authorized snapshot.

In one serialized transaction, resolve current actor/session/role, authorize
the change, compare the expected revision, update visibility, and record the
canonical result with its receipt. An explicit no-op returns current state.
Do not let an earlier route-level access check authorize a write after revocation.

Publish only generic or currently authorized SSE hints. Follow current access
rules for collection membership and cached storage totals. Do not broadcast
private entry IDs, pending requests, receipts, or private values. An older
acknowledgement cannot overwrite newer security state or remove an access fence.

## Recovery and compatibility

Provide current-authorized receipt lookup and deliberate identical-attempt
replay after the transactional adapter is complete. A receipt must not disclose
data when current access has been revoked. A conflict requires explicit review
of current visibility before a new attempt. No automatic replay is enabled.

Without capability support, provide the same conservative pending presentation
through the existing endpoint with no invented revision or receipt guarantee.
Auth reset clears private pending values and prevents old callbacks from
restoring visibility or privileged controls.

## Acceptance criteria

1. A held change shows requested and confirmed visibility separately; pending
   grants enable no access and pending restrictions never announce privacy.
2. With SSE blocked, canonical acknowledgement confirms the result directly.
   Old GETs, out-of-order receipts, and filtered absence cannot forge security
   state or revive an inaccessible entry.
3. Concurrent visibility writes conflict; progress and tag changes do not.
   All writers and restart persistence preserve the revision contract.
4. Lose a response after commit, replay concurrently, revoke access before
   lookup/replay, and switch accounts. No duplicate write or private disclosure
   occurs, and stale callbacks enable no authority.
5. Test two-user visibility, playback/storage reconciliation, keyboard status,
   both themes, and shared verification including authorization regressions.
