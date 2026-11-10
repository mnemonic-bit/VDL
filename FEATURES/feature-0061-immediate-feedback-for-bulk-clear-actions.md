# Immediate feedback for bulk clear actions

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in version `0.64.0`\
**Last refined:** 2026-11-10\
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

## Adapter and scope contract

The trusted actions are `history.clear` and `library.clear` in the `bulk-clear`
domain. Their conflict boundaries are the respective installation-wide clear
controls. Both require a currently authenticated administrator. Settings, the
affected History or Library surface, and an in-memory summary share status-only
presentation. Preview and confirmation do not change confirmed collection data.

The negotiated `bulk_clear: 1` capability and registered actions enable scope
and receipt recovery. `GET /api/clear/preview?include_scope=true` and
`GET /api/library/clear/preview?include_scope=true` return preview counts, an
actor/session-bound `scope_id`, and a decimal-string `revision`. Default preview
responses keep their legacy shape. Confirmation freezes
`{client_mutation_id, scope_id, expected_revision}` for the corresponding POST.
Recovery never substitutes another preview, scope, or mutation identity.

History eligibility is the existing installation-wide set of terminal attempts:
statuses other than `starting`, `downloading`, and `paused`. Library eligibility
is the existing `finished`/`error` set, including non-playable error records;
`cancelled` and `interrupted` Current downloads remain outside this scope.
Execution uses the preview's fixed target identities and checks current
eligibility. Library targets additionally retain their captured removal
revision. Later arrivals and changed target generations cannot broaden the
confirmed scope. Preview counts remain informational, not a promise that every
previewed target will still qualify at execution.

Library preview `with_files` counts entries with stored filenames. The final
`files_deleted` count reports actual captured artifacts, including sidecars,
so it need not equal that preview count.

History removal and its terminal receipt commit in one transaction. Library
acceptance durably records the fixed set, with one stable internal removal
attempt per target. Those attempts use Feature 0060's ownership journal, file
identity checks, and exclusive retirement; filesystem work runs outside the
database write lock. Parent authorization also gates child recovery, including
administrator-role and session changes. Attempt snapshots survive Library
removal. Files referenced by entries outside the accepted set remain protected.

Canonical results correlate the action, mutation, scope, and operation and
report total, removed, retained, failed, and pending counts plus confirmed removed
identities. Accepted unfinished work remains distinct from completion. Only
confirmed removals install client deletion fences and update loaded views;
collection reads and SSE hints cannot confirm an unknown request. Child results
and recovery state survive response loss and restart without rerunning a query
for new targets.

Receipt lookup is actor-scoped and currently authorized. Deliberate replay uses
the same frozen request. Shared admission, quotas, retention, and serialized
expired-absence finality apply; active operations retain their recovery records.
Legacy clients retain their response contract through the same safe server
boundary. Unsupported servers receive conservative pending feedback with no
invented revisions, receipt support, or automatic write replay. Browser intents
and recovery payloads remain in memory and are cleared on authentication changes.

When a serialized expired-absence check cannot recover the outcome, the client
reads the current authorized scope before offering explicit resolution. A failed
or obsolete read cannot release the intent. Changing views or accepting a newer
collection snapshot invalidates that check before resolution. Using current
state installs the checked snapshot without announcing deletion or creating a
new destructive request.

Feature 0061 does not complete Features 0062–0067. Playback, leases, progress,
worker scheduling, uploads, and companion transport retain their specialized
ownership contracts.

## Operational limits

A preview contains at most 10,000 targets. An actor may retain at most 16
distinct unaccepted preview scopes; repeated previews of the same current
target set reuse the existing scope. Unaccepted previews expire after the
shared 24-hour replay window. Cancelling confirmation deletes nothing.

Library acceptance checks receipt capacity for the parent and its target
children, including unstarted targets reserved by other accepted clears.
This shared capacity can limit acceptance below the preview's target cap;
the parent itself also consumes a receipt slot.
Children also obey the shared per-minute admission limit. When that limit
delays an accepted target, it remains pending in the original scope and can
continue through explicit recovery. No background polling or automatic POST
replay is introduced. Active operations protect their parent and child
recovery records beyond the normal 48-hour terminal receipt retention.

`VDL.bulkClearMetrics()` returns a frozen, bounded aggregate of presentation
and acknowledgement latency, outcomes, pending work, and reconciliation reads.
It contains no target identities, titles, paths, or payloads and clears with
the page.
