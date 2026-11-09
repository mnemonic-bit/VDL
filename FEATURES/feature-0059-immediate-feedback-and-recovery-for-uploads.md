# Immediate feedback and recovery for uploads

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in version `0.62.0`\
**Last refined:** 2026-11-09\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0021, Local video import](feature-0021-import-and-export-local-videos.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Preserve the existing local upload row, preallocated server identity, byte
progress, registration acknowledgement, and cancellation semantics. Coordinate
registration and lost outcomes without converting upload progress into metadata
intents or claiming that aborting a browser transfer cancelled server work.

## User-visible behavior

- `registerDroppedVideo` immediately presents one transfer row for the file.
  Keep the same identity through registration, `transferDroppedVideo`, server
  processing, and final Library publication; do not add a second row on refresh.
- Distinguish **Registering upload…**, byte transfer progress, server processing,
  and finished media. Reaching 100% transferred does not make a file playable.
  Keep existing byte/progress behavior and do not queue each progress event.
- Prevent duplicate registration or simultaneous transfer for one upload
  identity. Other files may continue under existing concurrency rules.
- `stopDroppedUpload` immediately shows **Stopping upload…**. Aborting the
  browser request stops local transfer only; keep server cancellation pending
  until its response or authorized status establishes the result.
- If stop races final publication, show the authoritative outcome. Do not erase
  an already finished file locally or claim server cleanup from a fetch abort.
- Retain unknown registration, transfer-finalization, and cancellation status
  with explicit checking actions. Closing a surface must not lose ownership of
  an in-flight upload or let an old callback alter another file's row.

## Identity, acceptance, and recovery contract

Use the preallocated server ID as the upload resource identity, with actor-bound
registration and transfer ownership. Persist registration/acceptance and its
History link before server work. Repeating an identical registration returns
the same resource; a different file/payload bound to the same attempt conflicts.

Define authorized upload status covering registered, transferring, processing,
published, cancelled, and failed phases as upload/job state, without extending
the canonical download status vocabulary. Persist the state required to recover
interruption and serialize transfer finalization against cancellation.

Before replay capability, prove that duplicate transfer/finalization cannot
publish twice, create another attempt, replace unrelated files, or continue
after definitive cancellation. Journal temporary-file ownership and publication
as needed; a metadata receipt alone does not cover writing media bytes. Server
restart resolves partial files through explicit recovery/cleanup rules.

This spec does not add resumable byte-range upload or persist browser `File`
objects. Do not automatically resend a body after response loss. Status checking
must establish whether the existing upload was accepted or published; any
supported deliberate replay uses the same immutable operation and ownership.

## Compatibility and lifecycle

Keep existing transfer transport and worker semantics as a specialized sequence.
Adopt coordinator error/epoch handling only at registration, cancellation, and
other discrete request boundaries. Advertise recovery capabilities separately
from raw transfer support; unsupported paths retain truthful pending feedback.

On account change, clear private transfer presentation and prevent further old
callbacks or dispatch. Server authorization still governs already submitted
work. On reload, reconcile accepted server uploads; do not silently persist or
restart local file transfers, and retain ordinary unsaved-work warnings.

## Adapter and wire contract

`upload.register` and `upload.cancel` are discrete, status-only actions in the
independent `upload` domain. Their conflict boundary is one preallocated upload
ID. Current downloads and its closed-drawer summary retain delivery and recovery
status; Library publication follows confirmed server state. Byte progress uses
the existing raw transfer transport rather than one mutation per progress event.

Recovery support is negotiated separately as `upload_recovery: 1`. Supported
registration sends the frozen `id`, `filename`, `filesize`, and
`client_mutation_id` to `POST /api/upload`. Cancellation sends a frozen mutation
ID to `POST /api/upload/<id>/cancel`. Canonical acknowledgements correlate the
mutation, upload resource, decimal-string revision, and single History attempt.
The shared actor-scoped receipt endpoint recovers these discrete requests;
missing receipts alone never confirm or reject them.

Adopted registration requires the explicit preallocated 32-character lowercase
hexadecimal ID. Legacy registration may still request a generated server ID.
Cancellation acceptance and completed cleanup remain distinct: the accepted
response can still report processing with `cancel_requested: true`. Only a
terminal canonical phase establishes cancellation, publication, or failure.

`GET /api/upload/<id>/status` supplies an authorized `upload` snapshot with
`id`, `phase`, decimal-string `revision`, `attempt_id`, `download_status`,
`downloaded_bytes`, and `total_bytes`. Upload phases are `registered`,
`transferring`, `processing`, `published`, `cancelled`, and `failed`; they do
not extend the canonical download status vocabulary. Status establishes the
resource's current processing or terminal state without inventing a receipt for
an unknown registration or cancellation request.

Published responses also supply the canonical public `download` snapshot so
the validated Library entry can appear without a collection read. Collection
entries expose `can_manage_upload` as a derived permission rather than an account
ID. Normal temporary-file ownership is internal; `recovery_required` describes
terminal cleanup that actually needs intervention. On reload, authorized active
uploads regain status and cancellation controls without a File or a new PUT.

The original actor owns registration, transfer, and recovery. Public Library
visibility does not grant another account upload ownership. Every execution
and recovery checks current session and ownership; a preallocated ID grants no
authority. Receipts share the existing admission, quota, retention, and expiry
rules. No capability enables automatic mutation replay or automatic byte-body
replay. Lost transfer responses offer status checking rather than a second PUT.

The durable upload operation records temporary-file and publication ownership.
Publication and cancellation serialize with file operations; exclusive
publication preserves unrelated destinations. Restart resolves interrupted
operations from their recorded ownership without creating another attempt or
resending bytes. Ambiguous file identity remains visible for intervention rather
than authorizing deletion of an unrelated replacement.

## Acceptance criteria

1. Gate registration, byte transfer, processing, and publication independently.
   One stable row reports the correct phase and cannot play partial media.
2. Cover Stop before registration returns, during transfer, during processing,
   and concurrent with publication. Abort alone never announces cancellation.
3. Drop each acknowledgement, duplicate registration/finalization, and restart
   at publication boundaries: one upload/attempt and at most one final file
   result, with no unrelated file overwritten or abandoned partials hidden.
4. Multiple files keep independent progress and errors. Old GETs, SSE, closed
   dialogs, and auth changes cannot duplicate or revive an upload row.
5. Test unavailable files, validation/permission failures, accessible byte and
   pending status, keyboard Stop, both themes, and existing upload/History
   regressions. Complete shared verification before advertising recovery.

## Verification

The [rollout inventory](../ARCHITECTURE/feature-0051-rollout.md) records the
version `0.62.0` completion evidence and verification commands. Production-route
coverage lives in `tests/test_upload_recovery.py`, `tests/test_upload_security.py`,
and the existing upload/command suites. Production store/coordinator checks live
in `tests/uploads-client.test.cjs`; browser integration checks live in
`tests/browser/uploads-feedback.spec.cjs` and `tests/browser/upload-drop.spec.cjs`.
