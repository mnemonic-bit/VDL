# Immediate feedback for preference saves

**Source:** Remaining Feature 0051 rollout item\
**Status:** Implemented in version `0.57.0`; verification recorded in the rollout inventory\
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

### Adopted action boundary

- **Action:** `preference.set`; target `installation`; domain `preferences`.
  The existing form is one installation-wide atomic scope, available to
  authenticated users under the existing permission rules. There is no
  user-specific preference scope in the current application.
- **Affected views:** Settings controls and status, the compact recovery
  summary outside Settings, and confirmed playback, pagination, theme, and
  Library-order consumers. Pending values do not change these consumers,
  except for the existing local theme preview.
- **Wire:** `POST /api/preferences` accepts `values`, `client_mutation_id`,
  and decimal-string `expected_revision`. Canonical results bind target,
  mutation ID, domain, outcome, all editable `values`, and
  `preferences_revision`. The flattened legacy read/write contract remains
  available; unsupported clients receive no invented revision or replay.
- **Conflict:** the complete captured form shares one revision. Review the
  current canonical settings before explicitly submitting the retained draft
  as a new attempt; never automatically resubmit the stale captured form.
- **Recovery:** actor-scoped `GET /api/mutations/<id>` and deliberate replay
  of the frozen request. Missing receipts and matching settings alone cannot
  establish success. Shared expiry, quotas, authorization, and finality rules
  apply. Authentication changes clear drafts and fence all prior callbacks.

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

### Preference effect audit

| Effect | Persistence and recovery boundary |
| --- | --- |
| Editable preference values | Values, the persistent revision, the terminal receipt, and a runtime-reconciliation marker commit together. Legacy and direct SQL writers advance the revision through database triggers. |
| Download directory | Directory creation with `exist_ok=True` is an idempotent prerequisite. A crash before commit can leave an empty directory; it creates no media or job. A committed replay returns its receipt without creating the directory again. Existing playback continues to use each entry's stored filename. |
| Library rotation | Members, generation, and deadline commit with the settings and receipt. Runtime recovery schedules the stored deadline; it does not reshuffle the accepted deck or restart its lifetime. The debug reloader parent retains its existing timer-ownership restriction. |
| Bandwidth and concurrency | Runtime controllers apply the latest persisted desired configuration after commit. The persistent pending marker survives controller failure; authorized recovery retries pending configuration, and startup restores process-local configuration. Worker dispatch retains existing ownership guards and only wakes already-enqueued work. Settings saves do not create or replay download commands. |
| Playback, pagination, theme, and shuffle consumers | Client effects use confirmed canonical values. The form and theme preview retain newer drafts. A save response confirms without SSE or a collection read; rotation membership may reconcile separately afterward. |

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
