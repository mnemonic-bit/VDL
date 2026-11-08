# Immediate feedback for preference saves

**Source:** Remaining Feature 0051 rollout item\
**Status:** Proposed; not implemented\
**Last refined:** 2026-11-08\
**Extends:** [Feature 0051](feature-0051-immediate-feedback-for-server-backed-interactions.md), [Feature 0022, Settings](feature-0022-move-settings-to-a-searchable-page.md)\
**Rollout:** [Shared requirements and inventory](../ARCHITECTURE/feature-0051-rollout.md#shared-requirements-for-the-remaining-specs)

## Decision summary

Show **Saving settings…** as soon as `savePreferences` admits a submission.
Keep controls editable and preserve newer draft values while the captured
submission is pending. Apply confirmed server settings from the response
without waiting for SSE or declaring unsaved newer drafts saved.

## User-visible behavior

- Capture submitted values and their draft generation. Prevent repeated Save
  from sending that same submission twice. Other controls and navigation stay
  usable; a newer draft may be saved after the current request is resolved.
- Distinguish confirmed values, the submitted generation, and newer unsaved
  values. A successful older save marks only its generation saved and must
  leave a visible unsaved indication for subsequent edits.
- Local theme preview remains immediate. Changing it does not imply persisted
  settings; after rejection retain the draft and identify what remains unsaved.
- Client presentation and application of server-wide, scheduling, filesystem,
  permission, and playback-setting changes wait for acknowledgement; the
  server's effects retain their existing domain rules. Changing a directory
  draft must not rewrite stored playback paths. Rotation and playback handoff
  behavior remain governed by their original features.
- Definite validation rejection identifies affected fields without clearing the
  form. Conflict or unknown outcome retains the submitted values for recovery.
  Reopening Settings must not let an old callback overwrite the new editor.

## State and server contract

Treat each existing atomic preference save scope as a conflict domain; preserve
user-specific versus installation-wide authorization. Introduce a persistent
revision for an adopted scope and return its canonical editable values and
revision together. Unrelated users' settings must not share a client queue.

Check expected revision, current permissions, validation, preference update,
and receipt in one serialized transaction. All preference writers must advance
the relevant revision. Return the canonical saved representation, including
normalization, rather than echoing the form or fetching all collections.
Conflicts offer current values plus explicit review and resubmission; do not
silently replay a stale whole-form snapshot over someone else's settings.

Audit each existing preference's side effects before enabling receipt recovery.
If a save starts external work, durable acceptance and operation-specific
recovery must prevent receipt replay from starting it again. Database receipts
alone cover only transactional effects. Do not advertise a stronger capability
for a mixed save until every included effect meets its recovery contract.

## Recovery and compatibility

Show **Save not confirmed** for lost responses or malformed acknowledgements.
Pause further saves in the affected scope and offer authorized receipt checking;
deliberate replay uses the same immutable payload and ID only when supported.
A failed refresh after confirmation does not turn saved settings into a failed
save. No automatic replay or browser-persisted settings write queue is added.

Without protocol support, retain pending feedback and newer drafts through the
existing save contract. Use neither synthetic revisions nor automatic retry.
Auth reset clears private drafts and pending state before late callbacks run.

## Acceptance criteria

1. Hold a save, edit several controls, and release it with SSE blocked. Saving
   appears immediately; canonical saved values update while newer edits remain
   unsaved, editable, and focused correctly.
2. Duplicate Save, close/reopen, old loads, and concurrent remote saves cannot
   discard drafts or silently overwrite newer confirmed preferences.
3. Validation and permission failures retain recoverable values. An unknown
   result cannot apply sensitive effects or announce success from a timeout.
4. Lost-response recovery and concurrent duplicate replay commit once, and
   each audited preference effect runs under its established recovery rules.
5. Cover theme preview, rotation deadlines, changed download directories,
   account changes, and stale callbacks. Test keyboard status, both themes,
   and narrow Settings layouts, then complete shared verification.
