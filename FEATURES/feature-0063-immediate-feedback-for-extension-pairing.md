# Immediate feedback for extension pairing

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in version 0.66.0\
**Last refined:** 2026-11-14\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0026, Firefox companion](feature-0026-download-authenticated-pages-with-firefox.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Give `createExtensionPairing` and `invalidateExtensionPairing` immediate pending
feedback, while treating pairing credentials as server-issued secrets. Never
invent a credential, announce invalidation early, or persist credential recovery
payloads in browser storage.

## User-visible behavior

- Creation immediately shows **Creating pairing…** and suppresses duplicate
  creation. Until a valid response arrives, no code, copy action, or claim that
  a pairing is available appears.
- A successful creation response displays the server-issued credential only in
  the current authorized pairing session. Closing/reopening the surface creates
  a new view token; a late response cannot expose a code in that new surface or
  reopen it. Reconcile non-secret status without restoring the discarded secret.
- Invalidation shows **Invalidating pairing…** beside confirmed status. Prevent
  duplicate invalidation and conflicting create/invalidate submissions. Do not
  announce the credential is invalid until acknowledgement establishes that.
  Conservatively disable copying while invalidation is pending without implying
  the server has already revoked it.
- A definite failure shows an actionable explanation. Unknown creation says
  **Pairing request not confirmed** without automatically issuing another code.
  Unknown invalidation keeps explicit uncertainty; hiding a displayed code is
  not proof it became unusable on the server.

## State and server contract

Serialize page pairing operations in their existing actor-scoped pairing
boundary. Keep the server's expiry, one-time use, replacement, and permission
rules. Authorization is required for creation, invalidation, and any recovery
read. Pairing request acceptance does not mean an extension connected.

Before enabling replay, record actor-bound attempt fingerprints and non-secret
outcomes atomically with credential creation/invalidation. Bind operations to
the specific pairing generation so replay of an old invalidation cannot revoke
a newly created pairing. Repeated creation must not mint an additional secret.

Do not retain plaintext credentials merely to replay a response. Recovery
receipts and diagnostics return only authorized non-secret outcome/status. If
creation committed but its secret response was lost, explain that the code
cannot be recovered; offer explicit invalidation of that generation followed
by a separate deliberate creation. Never label an unavailable secret a failed
creation or automatically rotate credentials on reconnect.

## Recovery and lifecycle

Without capability support, retain the existing endpoint and truthful pending
status with no replay. When recovery exists, offer bounded non-secret receipt
checks and only tested same-attempt recovery. Missing receipts stay ambiguous;
do not issue a new creation ID as transport recovery.

Keep credential presentation only in memory for its authorized view lifecycle.
Exclude secrets from localStorage, IndexedDB, URLs, logs, metrics, generic
coordinator snapshots, and SSE. Authentication reset clears secrets before late
callbacks run. The extension's own transport is a separate client and does not
inherit the page's receipt or retry guarantees.

## Acceptance criteria

1. Hold creation/invalidation requests: pending feedback is immediate, duplicate
   actions are blocked, and no secret or revoked claim is fabricated.
2. With SSE blocked, a canonical response updates status; a secret appears only
   in the still-current originating session. Close/reopen and account changes
   prevent old callbacks from revealing credentials or stealing focus.
3. Lose a creation response after commit: recovery mints no second credential,
   exposes no stored plaintext, and supports explicit invalidate-then-create.
4. Race invalidation with replacement, expiry, consumption, and access loss.
   An old attempt cannot invalidate a new pairing or leak private status.
5. Inspect responses, storage, logs, and SSE for secret leakage; test keyboard
   status, copy controls, both themes, companion regressions, and shared gates.

## Implementation contract

The `pairing.create` and `pairing.invalidate` actions share the actor-scoped
`extension-pairing` conflict domain. The page uses the shared state store and
mutation coordinator for non-secret status. Credential presentation belongs to
the originating view token and authentication epoch, outside coordinator
snapshots. Closing the dialog discards its credential and advances the view
token. Pending and uncertain request status remains available across navigation.

The authenticated `extension_pairing: 1` capability enables the protocol.
`POST /api/extension/pairing-codes` accepts `client_mutation_id` and
`expected_revision`. `DELETE /api/extension/pairing-codes/current` additionally
binds `generation`. `GET /api/extension/pairing-codes/current` returns only the
current generation, status, expiry, and decimal-string revision. Existing
clients retain the legacy endpoints.

The server commits the credential verifier, generation, revision, and non-secret
receipt in one serialized database transaction. Creation, replacement,
invalidation, expiry, consumption, and restart share the same revision boundary.
Startup clears unused verifiers and reports interruption, preserving the
existing rule that unused pairing codes do not survive restart. Original
execution, replay, status reads, and receipt recovery recheck current session
authorization. Generation-bound invalidation cannot revoke a replacement.

Only the first successful creation response supplies the credential. Receipt
lookup and identical-attempt replay return non-secret outcomes and current
status. A committed creation whose credential response was lost requires an
explicit invalidation followed by a separate creation. Recovery never mints a
second credential or automatically replays a write. Plaintext credentials do
not enter SQLite, generic client snapshots, browser storage, diagnostics, or SSE.

`VDL.extensionPairingMetrics()` and the aggregate `VDL.mutationMetrics()` expose
bounded, content-free timing, outcome, pending, and reconciliation counters.
The pairing coordinator shares the page's 128-intent admission limit with other
mutations. Local credential expiry performs one bounded authorized status read
before releasing an available-generation fence; no status polling is added.

## Verification

Verified on 2026-11-14 for version `0.66.0`:

- Python 3.12.14: `./tests/run-all.sh --unit` **passed**, 900 tests with
  9 skipped; `vdl.py` line coverage **92.7%** (7954/8582; minimum 90%).
- `node --test tests/*.test.cjs` **passed**, 306 tests, including 27 pairing
  module checks.
- Chromium and Firefox: **passed**, 53 distinct scenarios per browser,
  including 25 pairing cases and 28 companion settings, tag, and live-update
  regressions. Idle light/dark feedback measured 8–17.3 ms against the 50 ms
  requirement. Unchanged renders produced no repeated live-region text updates.

The [rollout verification record](../ARCHITECTURE/feature-0051-rollout.md#pairing-verification)
contains commands and the covered recovery, authorization, and lifecycle cases.
