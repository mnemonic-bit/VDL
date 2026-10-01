## 43. [Resolved] User administration was fragmented and lacked safe edit guards

**Severity:** Medium

**Status:** Resolved incrementally in versions `0.26.1` through `0.26.4` on
2026-10-01.

The Users section in Preferences presented every account as a separate,
permanently editable block. Login identity and the user's human-readable name
were conflated, actions used full text buttons, and adding a user happened in a
separate form rather than in the account list. The interaction also lacked a
clear single-row edit state and did not explain why another row became
unavailable once that behavior was introduced.

The same review exposed an administrator-safety gap. The backend rejected the
usual attempt to demote or suspend the final active administrator, but its
demotion check depended on the target administrator being active. The UI also
initially allowed the final administrator's role dropdown to be opened and
showed only its **Normal** option as unavailable, which made the invariant
look like an option-level restriction rather than a locked role.

### Reproduction

1. Sign in as an administrator and open **Preferences → Users**.
2. Before the fix, observe that accounts are rendered one after another as
   separate editors instead of rows in a common table.
3. Compare the username field with the account heading. There is no separate
   human-readable Name value.
4. Change fields on an existing account. Before the fix, the row does not
   enter an explicit draft state with icon-only Save and Cancel actions, and
   another row is not locked until the first draft is resolved.
5. Add a user. Before the fix, this uses a separate form above the account
   list rather than a final empty table row with field hints.
6. Remove a user. Before the fix, confirmation uses the browser's generic
   confirm prompt rather than an application dialog identifying the account.
7. With only one active administrator, inspect that account's Role control.
   During the first safety pass, the dropdown remained enabled and only its
   **Normal** option was greyed out.
8. Start editing one row and move the pointer over a different, disabled row.
   During the first table pass, no explanation is shown for the lock.

**Actual:** Account management was visually fragmented, login and display
names were not distinct, edit ownership was ambiguous, destructive
confirmation was inconsistent with the application, and administrator/edit
locks were either incomplete or unexplained.

**Expected:** Users should appear in one table with Login Name, Name, Role,
and icon-only actions. A final empty row should create accounts. Only one row
may hold unsaved changes; it must expose Save and Cancel icons and prevent
editing another row until the draft is resolved. Removal should use an
application confirmation dialog. The final active administrator's complete
Role control must be disabled and explain why, while rows locked by another
draft must explain how to continue.

### Diagnosis

- The frontend rendered independent `<article>` editors and a separate create
  form, with no shared table or active-draft state.
- The `users` schema stored only `username`, so the UI had no distinct value
  for a person's display name.
- Removal called `confirm()` directly instead of using the application's
  dialog pattern.
- The last-admin database guard grouped demotion with suspension under a
  condition that required the target administrator to be active. That left a
  suspended final administrator outside the demotion branch.
- The first UI guard disabled only the **Normal** option. The later row lock
  disabled controls but did not attach a reason to the locked row, and native
  disabled controls could prevent the row's hover target from receiving the
  pointer.

### Resolution

- Replaced the independent account blocks with a responsive user table whose
  rows contain Login Name, Name, Role, and icon-only Suspend/Resume and Remove
  actions.
- Added a migrated `users.name` column, backfilled existing rows from
  `username`, and validated and exposed the field through the create and
  update APIs.
- Added a final empty row with muted placeholders. Saving it generates a
  secure initial password and presents that password once in an application
  dialog.
- Added explicit per-row draft state. The edited row switches to checkmark and
  X actions; all other rows remain disabled until Save or Cancel resolves the
  draft. Escape also cancels the active edit.
- Replaced the generic removal prompt with a modal dialog that names the user
  and requires an explicit Remove action.
- Split administrator demotion and suspension checks on the backend so either
  operation requires another active administrator. Direct API requests remain
  protected even if the UI is bypassed.
- Disabled the entire Role dropdown for the final active administrator,
  retained the visible **Admin** value, and added the tooltip “You cannot
  change the role of the last administrator on the system.”
- Marked every row outside the active edit as locked and added the tooltip
  “Save or cancel the current user changes before editing another user.”
  Pointer handling routes hover over disabled fields and icons to the row so
  the explanation remains available across the full row.

### Verification

- `tests/test_migrations.py` verifies that existing databases gain the Name
  column and that legacy users receive their login name as the initial value.
- `tests/test_auth.py` verifies Name persistence, ordinary last-active-admin
  protection, successful demotion when another active administrator exists,
  and the suspended-final-administrator edge case.
- `tests/browser/auth.spec.cjs` verifies the table lifecycle, generated
  password dialog, Save/Cancel behavior, removal dialog, whole-selector
  last-admin lock, and both tooltip transitions.
- The authentication backend suite passed 10 tests, and the authentication
  browser suite passed all 4 tests. JavaScript syntax and diff validation also
  passed.
- The Podman deployment was rebuilt after the completed fixes; `/api/health`
  reports version `0.26.4`.
