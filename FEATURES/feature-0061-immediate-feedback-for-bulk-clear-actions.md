# Immediate feedback for bulk clear actions

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0036, Attempt History](feature-0036-add-download-attempt-history.md)\
**Related:** [Feature 0060, Safe entry removal](feature-0060-immediate-feedback-and-safe-entry-removal.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Give `clearHistory` and `clearLibrary` immediate pending feedback on their
existing preview-and-confirmation surfaces. Keep their scopes unmistakable:
Clear History removes terminal attempt records; Clear Library removes the
eligible Library records/files described by its confirmation. Never announce
bulk deletion before the server establishes its result.

## User-visible behavior

- Preserve preview counts, authorization, explicit confirmation, and the
  distinction between attempts and media. A preview is informational and does
  not itself perform or confirm deletion.
- After confirmation, immediately show **Clearing history…** or
  **Clearing library…**, disable duplicate confirmation, and retain the surface
  or a persistent summary if it closes. Keep existing rows visible with a
  scope-level pending indication rather than pretending the collection is empty.
- Other navigation remains usable. Closing a dialog or switching views does
  not cancel server work. A late callback cannot reopen a newer dialog.
- Confirmed results report actual removed counts and any retained/failed items.
  History clear leaves active attempts and Library files intact. Library clear
  preserves historical attempt snapshots and follows established playback rules.
- Definite failure retains current data and a recoverable explanation. Unknown
  results show **Clear request not confirmed** without treating an empty or
  changed read as proof of this request's outcome.

## Scope and execution contract

Define and document the existing preview-to-execution eligibility rules. Bind
the confirmed operation to a server-side scope identity and fixed accepted
target set or equivalent snapshot boundary. Newly arriving eligible records
after acceptance must not be swept into recovery of that operation. Recheck
current permissions and eligibility at execution; a changed preview must never
silently broaden the confirmed destructive scope.

For transactional attempt deletion, record actual counts and receipt atomically
with deletion. For a Library clear involving files, create a durable accepted
operation with per-target recovery/results using Feature 0060's safe removal
boundary. Repeated execution can report/resume that accepted set only; it cannot
run a fresh query and delete newly added videos. Retain enough recovery state
for partial failures and restart without exposing private target details.

Do not hold database write locks while deleting files or waiting for work. If
execution is asynchronous, acknowledgement means **accepted** and returns an
operation ID; progress and completion are separately server-owned. Fence
confirmed removals and invalidate older scoped reads as results are published.

## Recovery and compatibility

Pending presentation and duplicate guards may ship before recovery. Existing
unsupported endpoints must never inherit automatic mutation retries. Offer
receipt/job lookup and deliberate same-attempt replay only after scope binding
and operation-specific recovery are proven. An unknown bulk clear is never
retried with a fresh ID merely because its confirmation surface closed.

## Acceptance criteria

1. Preview and cancellation delete nothing. A held confirmed request shows
   pending immediately and suppresses repeated clear from the same page.
2. With SSE unavailable, acknowledgement reports actual results or acceptance,
   without claiming asynchronous file cleanup has finished.
3. Clear History retains active attempts and all media. Clear Library retains
   attempt snapshots and accurately reports missing or failed file removals.
4. New attempts/videos arriving after acceptance survive same-attempt recovery.
   Changed permissions and eligibility cannot broaden the accepted scope.
5. Drop responses, replay concurrently, restart mid-batch, and fail individual
   removals: no newly created target is deleted and partial failure stays visible.
6. Old reads cannot revive confirmed deletions. Cover closed dialogs, logout,
   keyboard confirmation/status, both themes, and shared verification.
