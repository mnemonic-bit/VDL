# Immediate feedback for favorites

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0020, Favorites](feature-0020-favorite-downloads.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Change the star immediately when the user favorites or unfavorites a video.
Show adjacent pending status until a canonical response confirms the explicit
desired boolean. A favorite save must not wait for SSE or a Library refresh.

## User-visible behavior

- Capture the desired boolean from the projected state at activation. Queue
  explicit `true` / `false` intents in FIFO order; never send a deferred toggle.
  Repeated renders do not submit writes, and the initiating button remains
  usable for a subsequent opposite intent within the shared queue limits.
- Show the same projected star in Library, Info, Current downloads, and other
  displays of the entry. Use accessible text such as **Saving favorite**;
  pending feedback must not rely only on star color.
- Preserve card identity, position, focus, and Library rotation membership.
  In a favorites-filtered view, retain the actively edited card until that
  interaction ends, then apply the filter once. Pending favorites never change
  server playback selection or other clients' results.
- On definite rejection, remove only the rejected intent's projection and
  explain the failure beside the star. Preserve subsequent queued intents.
  On conflict or unknown outcome, keep visible recovery status and pause only
  this entry's favorite queue.

## State and server contract

Use an independent `(entry ID, favorite)` conflict domain. Its persistent
revision uses the new-domain decimal-string format from Feature 0051. Tag,
progress, view-count, and visibility changes must not advance it. Every favorite
writer, including legacy callers, advances it only when the value changes.

The adopted mutation sends the explicit boolean, mutation ID, and expected
favorite revision. In one authorized transaction, check the receipt and
revision, set the value, and record a canonical boolean/revision result and
receipt. No-op sets return the current revision. Collection and targeted
editable-state reads supply consistent favorite values and revisions.

Merge acknowledgements atomically with retiring their intent. An older success
receipt cannot overwrite a newer confirmed favorite revision. A matching star
from a refresh is convergence, not proof that this attempt committed.

## Recovery and compatibility

Provide actor-scoped receipt lookup and deliberate replay of the exact frozen
attempt. No automatic replay is enabled by this spec. Conflict retry is an
explicit new attempt after reading current authorized favorite state. Enforce
the parent's replay-window and domain-release rules.

Advertise the adapter only after all writers and read serializers participate.
Without that capability, show pending request feedback using the existing
server contract, without fabricated revisions or receipt recovery. Access loss,
deletion, and authentication reset override every projected star.

## Acceptance criteria

1. A held request shows the requested star and pending status before transport
   completes. Release its response with SSE blocked: confirmation needs no GET.
2. Favorite/unfavorite/favorite queues in order; rejecting the first intent
   cannot undo later intent or another entry's favorite. Tags remain usable.
3. Old GETs, SSE-before-acknowledgement, and older receipts cannot roll back a
   newer confirmed value, duplicate a card, change rotation, or move focus.
4. Concurrent edits conflict on favorite revision; unrelated progress does not.
   Legacy writes and restart persistence preserve the revision contract.
5. Commit with a lost response, simultaneous duplicate replay, fingerprint
   mismatch, and replay after access loss establish no duplicate mutation or
   private-data disclosure. Account switches discard old callbacks.
6. Browser checks cover favorites filtering, reopened Info, keyboard use,
   reduced motion, both themes, and visible failure/recovery actions. Complete
   the rollout's shared implementation verification before marking this done.
