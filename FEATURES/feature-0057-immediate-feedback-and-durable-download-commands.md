# Immediate feedback and durable download commands

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in version `0.60.0`\
**Last refined:** 2026-11-09\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0036, Attempt History](feature-0036-add-download-attempt-history.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Show **Pausing…**, **Resuming…**, **Stopping…**, or **Starting…** immediately
for pause, unpause, stop, retry, and resume actions in Current downloads and
attempt History. Separate request delivery, durable command acceptance, and
the actual worker transition. Add durable recovery before enabling replay.

## User-visible behavior

- Attach pending status to the initiating action and linked work identity in
  every relevant view. Keep the last confirmed worker status visible. An
  accepted pause request does not itself make a row `paused`.
- Guard repeated activation of the same command and serialize contradictory
  local commands for that work. Stop may be admitted when valid during a
  pending pause; it supersedes an unsent pause, otherwise visibly queues until
  dispatch is safe. An unknown pause cannot be silently marked resolved to
  dispatch Stop. Once accepted, cancellation retains cancel-beats-pause behavior;
  do not re-arm pause during cancellation.
- Unpause clears the flag for a live paused worker. Resume starts new work for
  cancelled/interrupted items; Retry starts a new execution. These are distinct
  actions, even when labels use similar wording.
- A command's valid acceptance ends its sending indicator. Show any continuing
  transition as worker progress, not an indefinitely unresolved HTTP request.
  Definitive refusal explains current eligibility; unknown acceptance says
  **Request not confirmed** without inventing a terminal worker status.
- History controls must target the current eligible attempt. An old attempt
  cannot start a second worker when a newer attempt already owns that item.

## Durable acceptance and worker contract

Declare a command serialization boundary per download with its current attempt
or worker generation. At transaction time, recheck authorization, current work
ownership, eligibility, and duplicate acceptance. Bind action, target generation,
payload, and mutation ID to a durable command record and receipt.

Retry/resume acceptance creates exactly one linked new attempt and durable job
identity. Pause/unpause/stop acceptance records the desired command against an
existing execution. Execution and restart recovery must reconcile these records
with worker ownership rather than launching a second worker or applying an old
command to a later attempt. Keep acceptance records while still needed by work.

Persist acceptance before dispatching worker effects. Recover crashes before
dispatch, after dispatch, and before acknowledgement. Existing startup handling
may mark vanished workers `interrupted`; recovery must report that truthful
outcome rather than promise that a thread survived or blindly restart it.
Do not hold a database lock while waiting on a worker or network I/O.

Use only existing download statuses. Publish worker transitions through normal
SSE reconciliation. Canonical command responses return correlated acceptance
and durable identity; they must not fabricate worker completion. File handling,
format fallback, bandwidth, scheduling, and pause-loop rules remain unchanged.

## Recovery and compatibility

Provide authorized receipt/job checks. A deliberate identical-attempt replay
returns or resumes the existing command acceptance; it does not start another
attempt. No automatic replay is enabled. Unknown commands cannot be replaced
with fresh IDs to bypass uncertainty or worker eligibility.

Pending feedback may ship first using existing commands, but capability
advertisement and replay wait for the durable acceptance and restart tests.
Matching worker status alone cannot correlate a particular lost command.

## Acceptance criteria

1. Hold each command request: its control shows immediate feedback while the
   confirmed status remains truthful in Current and History.
2. With SSE blocked, acknowledgement confirms acceptance only. Reconciliation
   later shows the worker transition without duplicate attempts or workers.
3. Exercise pause then stop, unpause, repeated Retry/Resume, an old History row,
   competing tabs, and stale callbacks targeting a newer worker generation.
4. Crash at every acceptance/dispatch/response boundary and recover once.
   Lost responses and concurrent replay return one job/attempt identity.
5. Cover worker failure after acceptance, unavailable media, access loss,
   logout, keyboard status, and both themes. Preserve cancellation, progress,
   scheduling, and History regressions and complete shared verification.

## Implementation contract

The registered actions are `download.pause`, `download.unpause`,
`download.stop`, `download.retry`, and `download.resume`, in the independent
`download-command` domain. They retain the existing POST routes. Requests bind
`client_mutation_id`, decimal-string `expected_revision`, and
`expected_attempt_id` to the work item. Current and History controls capture
the attempt they actually display; a newer attempt cannot inherit an old
control's authority.

The existing authenticated visibility permission remains authoritative for
these controls. Admission and dispatch recheck the current account, session,
target visibility, worker ownership, and action eligibility. Receipt lookup
and replay recheck current authorization; a stored identity grants no access.

Canonical responses carry `command_revision`, `current_attempt_id`, and the
correlated mutation with outcome `accepted`. The `command` identifies its
action, source attempt, accepted attempt, durable command identity, linked job,
and current execution status. This response confirms acceptance only; it does
not replace confirmed worker status, progress, playable identity, or collection
membership. Authorized receipt checks report the recorded acceptance together
with the command's current execution outcome.

Acceptance and its receipt commit before dispatch. Retry and resume allocate
one new attempt in that transaction. Dispatch is serialized with other command
writers and fenced by the accepted attempt. A restart marks vanished work and
unfinished dispatch interrupted; it does not launch a replacement thread or
repeat retry cleanup. Replaying the frozen request returns the same acceptance.
The command record remains available while its execution still needs it.
Legacy Resume can retain its queued handoff while the old worker unwinds;
scheduler-serialized cleanup preserves the successor's accepted pause/stop
intent instead of clearing flags belonging to the newer attempt.

The browser uses the shared store and coordinator for command status without
projecting worker completion. Stop can queue behind a transmitted pause, but
an unknown pause keeps that queue blocked until safe recovery or explicit
resolution meets the shared finality requirements. Unsupported servers receive
truthful pending feedback without receipt or replay guarantees. All pending
and recovery presentation is in memory and fenced by authentication and access.
