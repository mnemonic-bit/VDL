# Immediate feedback for duplicate-index refresh

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0034, Duplicate detection](feature-0034-find-duplicate-media-and-uniquely-name-imports.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Retain the duplicate-index refresh button's immediate disabled/sending state and
make request acceptance distinct from background indexing completion. An
unknown refresh request is never automatically replayed. Existing indexing
ownership, background status, and result publication remain authoritative.

## User-visible behavior

- Immediately show **Requesting index refresh…** and prevent duplicate clicks.
  Retain the last confirmed duplicate results; pending request presentation
  must not erase them or imply that a scan has started or completed.
- A valid acceptance response ends sending state and displays the actual
  server status, such as **Indexing…**, or that a refresh is already running.
  Existing job progress and completion reconcile through SSE and normal reads.
- Keep background status when leaving/reopening History's Duplicates tab. An
  old callback cannot reopen it, reset a newer status, or steal focus.
- A definite rejection reports the request error. Unknown acceptance says
  **Refresh request not confirmed** and offers a bounded authorized status
  check. Do not turn a transport timeout into an indexing failure or silently
  request another full scan.
- A confirmed accepted job whose scan later fails is a job failure, not a
  rejected request. Preserve established last-good-result and error behavior.

## State and server contract

Keep indexing as a specialized background job, outside metadata FIFO queues.
Its server-side ownership rule must prevent competing refresh requests from
creating duplicate concurrent scans, including requests from different tabs.
Do not route individual file hashing/progress through the mutation coordinator.

Return canonical acceptance or existing-running status through the current
endpoint. The job status remains server-owned. Page-level sending state needs
only a discrete request lifecycle and auth/view tokens; it must not fabricate
metadata revisions or claim a receipt-capable job identity that does not exist.

This spec does not enable mutation replay. If later work adds it, a separate
durable acceptance record must correlate the exact request to one job and
define recovery before/after worker dispatch and process restart. An in-memory
single-flight guard or a status read showing some scan is running does not prove
which unknown request was accepted.

## Recovery and compatibility

Use one bounded authorized status check on lost acknowledgement or reconnect;
additional checks are user initiated. No polling or automatic replay is added.
If existing status cannot establish an unknown request's finality, retain the
uncertainty rather than manufacturing a rejection or dispatching a replacement.
An explicit later refresh must remain a deliberate new operation subject to
the server's admission/ownership rules.

Do not expose unauthorized paths, hashes, duplicate membership, or indexing
details in pending status, errors, diagnostics, or SSE. Clear private results
and ignore old callbacks on authentication reset.

## Acceptance criteria

1. A held request immediately disables its initiating control and shows sending
   while last confirmed results remain visible. Repeated clicks send once.
2. With SSE blocked, acknowledgement shows acceptance separately from completion;
   later status/refresh restores accurate running, failed, or completed state.
3. Drop acceptance, inject malformed success, and reconnect repeatedly: no
   automatic POST replay, polling loop, or duplicate scan occurs.
4. Competing tabs, restart during a scan, old status responses, and tab reopen
   preserve existing ownership and truthful background status.
5. Cover permission loss, logout, accessible announcements, both themes, and
   duplicate-index regressions, then complete shared implementation verification.
