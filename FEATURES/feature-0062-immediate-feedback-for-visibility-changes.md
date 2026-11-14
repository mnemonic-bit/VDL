# Immediate feedback for visibility changes

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in 0.65.0\
**Last refined:** 2026-11-14\
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

## Implementation

`visibility.set` uses the shared client store and mutation coordinator. The
visibility selector retains the confirmed value while adjacent text shows the
requested value. Unknown outcomes retain both values and explain that current
server visibility may differ. A summary preserves recovery controls when Info
is closed. Conflicts require explicit review before another submission.

The server migrates `visibility_revision` and advances the revision through a
database trigger on every actual visibility change. The serialized metadata
transaction resolves the current actor, checks ownership or administration,
compares the expected revision, and commits the change and actor-scoped receipt
together. Legacy writes share the authorization boundary. Visibility hints
contain no entry identity. Other entry hints recheck current access at SSE
delivery, including hints queued before an entry becomes private.

Acknowledgements contain `visibility`, decimal-string `visibility_revision`,
`can_manage_visibility`, `can_delete`, and `permissions`. Receipt lookup and
identical-attempt replay reauthorize access and return a current security
snapshot. Their `mutation.revision` retains the original outcome revision;
`visibility_revision` may be newer. The client checks both revisions and keeps
newer confirmed state. Collection and storage reads resolve current
authorization within their read snapshots.

Recovery never automatically replays a write. A missing receipt does not
confirm an outcome. Explicit resolution requires a newer revision that prevents
the original conditional write, or a serialized expired-absence result followed
by a valid authorized state check. Unsupported servers receive pending
presentation without assumed revision or receipt support. Authentication reset
and access fences clear pending private values and reject obsolete callbacks.

## Verification

Verified on 2026-11-14 for version `0.65.0`:

- `./tests/run-all.sh --unit` with Python 3.12.14: **passed**, 885 tests,
  9 skipped; `vdl.py` line coverage **92.5%** (7831/8462), above the enforced
  90% minimum. Test databases used `TMPDIR=/dev/shm`.
- `node --test tests/*.test.cjs`: **passed**, 279 tests, including 32 visibility
  checks. Tests exercise the production store, coordinator, and availability
  adapter, including targeted reads arriving before collection snapshots.
- Chromium: **passed**, 216 distinct scenarios across the broad runs and
  focused follow-ups. Firefox: **passed**, 161 distinct scenarios across the
  broad run and focused follow-up. All 22 visibility scenarios passed in both
  browsers. The final tag, visibility, and live-update group passed all
  45 checks in each browser after the availability-read correction.

Controlled requests cover immediate feedback below 50 ms, confirmed versus
requested visibility, canonical acknowledgement without SSE or collection
reads, stale responses, lost acknowledgements, identical-attempt replay,
conflict review, definite rejection and quotas, access loss, account switching,
two-user playback and cached storage, legacy servers, keyboard controls, both
themes, reduced motion, narrow layouts, and deduplicated announcements.
Transactional tests cover concurrent writes and replay, receipt rollback,
fingerprints, retention and expiry, restart persistence, current authorization,
and all visibility writers. Actual SSE tests verify delivery-time privacy for
queued hints and private worker/view events, role changes, and session revocation.
