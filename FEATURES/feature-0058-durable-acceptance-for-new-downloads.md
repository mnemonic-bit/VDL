# Durable acceptance for new downloads

**Source:** Feature 0051 rollout item\
**Status:** Implemented in version `0.61.0`\
**Last refined:** 2026-11-09\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0037, Probe readiness](feature-0037-show-download-probe-readiness.md)\
**Related:** [Feature 0057, Durable download commands](feature-0057-immediate-feedback-and-durable-download-commands.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Preserve `submitDownload`'s immediate submitting presentation and strengthen its
acceptance contract. A response lost after the server accepts a URL download
must be recoverable through one durable job identity, without creating a second
download or attempt. Do not predict media availability or completion.

## User-visible behavior

- Retain `downloadSubmitting`, probe-generation, and dialog-session guards.
  On admission, capture URL and selected options and immediately show
  **Starting download…**. Suppress duplicate submission of that captured request.
- A local pending row, if shown before acceptance, has a stable presentation
  identity and clearly says it is a request. It has no playback, final path,
  fabricated percentage, or worker controls requiring a server identity.
- Canonical acceptance maps that identity once to the server's download,
  attempt, and job identities. Confirm acceptance with SSE unavailable; worker
  status, probing, transfer, and final publication remain server-owned.
- Keep a newer URL/options draft independent of the submitted request. An old
  probe or submit callback cannot clear it, close a reopened dialog, or steal
  focus. Definite pre-acceptance validation failure preserves recoverable input.
- Unknown acceptance retains **Download request not confirmed** with recovery
  actions. Do not label a missing response a failed download or invite a blind
  new submission of the same request. Separate intentional later downloads of
  the same URL from recovery of one accepted request.

## State and server contract

Use a submission identity per user operation, not URL equality. Two deliberate
submissions of the same URL may be distinct jobs; identical replay of one
mutation ID must return the same accepted job.

In one current-authorized transaction, validate the selected options, admit a
durable job, create/link its download and single History attempt, and record
the acceptance receipt. Bind the exact submitted URL/options to its fingerprint.
Do not store cookies or credentials in receipt presentation or diagnostic logs.

Dispatch work only after durable acceptance. Recover interruption before
dispatch, during dispatch, and after worker start without two worker owners.
If startup recovery determines accepted work was interrupted, expose that
outcome and ordinary Resume/Retry rules rather than automatically creating a
replacement attempt. Never hold a database lock across extraction or download.

Return a correlated `accepted` outcome with durable identities, not a claim
that probing or downloading finished. Current download/History reads and
authorized job recovery converge on those same identities. Keep existing
scheduling, probe readiness, format fallback, and download status semantics.

The page action is `download.submit` in the `download-submission` domain.
Its conflict boundary is one local submission operation, independent of URL
equality or a future download's command revision. Download dialog and summary
presentation use the shared coordinator; URL/options drafts retain their own
generations. Current authentication authorizes creation; current target
visibility additionally gates accepted-job recovery. Canonical acceptance
requires matching mutation correlation, a decimal-string submission revision,
and consistent download, job, and attempt identities. The
[architecture](../ARCHITECTURE/immediate-feedback-for-server-backed-interactions.md#new-download-acceptance)
records the wire decoder, dispatch boundary, and recovery responsibilities.

## Recovery and compatibility

Receipt/job lookup checks current authorization. Deliberate same-attempt replay
recovers the accepted operation; it never allocates new work. Receipt retention
must outlive any accepted job that still depends on it. Follow the parent's
expiry and serialized finality rules before resolving unknown acceptance.

Until this durable contract is ready, retain immediate submission state and
existing behavior with no replay capability. No mutation uses GET contention
retries, and no submitted URL/options queue survives page reload or account
change. This spec covers the page; companion transport remains separate.

## Acceptance criteria

1. Held submission shows immediate starting state and blocks duplicate clicks;
   probe races, changed options, and reopened dialogs preserve newer drafts.
2. SSE-free acceptance maps one pending identity to one real job, download, and
   History attempt. No placeholder becomes playable before actual publication.
3. Lose the response after acceptance and replay concurrently: only one job
   and attempt exist. Intentional fresh submissions can still create new work.
4. Crash before/after dispatch and worker ownership registration: recovery
   produces one owner or a truthful interrupted outcome, never duplicate work.
5. Test malformed acknowledgements, invalid options, authorization loss,
   expiry, logout, accessible pending/error states, and both themes. Complete
   shared verification and probe, scheduling, and History regressions.
