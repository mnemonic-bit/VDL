# Immediate feedback and recovery for uploads

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
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
