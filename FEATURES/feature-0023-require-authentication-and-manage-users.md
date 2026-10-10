# Require authentication and manage users

**Source:** User-requested feature  
**Status:** Implemented  
**Last refined:** 2026-10-01  
**Extends:** Feature 0022, Move settings to a searchable, sectioned page

## Decision summary

Require an authenticated account before serving any application content or
private API. Preserve only the sign-in flow, static assets required by that
flow, and the data-free health endpoint as public resources.

Provide the built-in roles `normal` and `admin`. Store role names as database
rows and connect users to roles through a many-to-many join table so additional
roles can be introduced without changing the users schema. The current user
management interface assigns one role to each user; multiple simultaneous role
assignments are a schema capability reserved for future authorization work.

Bootstrap a single administrator named `admin` on the first database
initialization. Do not ship a default password. The first visit must require
that administrator to choose and confirm a password before any account can use
the application. Record bootstrap completion independently from the username
so renaming the initial administrator never creates another passwordless
`admin` account after a restart.

Show a Users section in Settings only to administrators. It must allow an
administrator to add, rename, suspend, resume, change the role of, reset the
password of, and remove users while guaranteeing that at least one active
administrator remains.

## Terms and authorization model

- An **anonymous visitor** has no valid signed session and can access only the
  sign-in flow, static assets, and `/api/health`.
- An **active user** has a password and is not suspended. Both normal users and
  administrators can use all existing download, upload, playback, history,
  preference, and event-stream features.
- A **normal user** has the `normal` role and cannot view or call user
  administration features.
- An **administrator** has the `admin` role and can manage accounts through the
  Users settings section and `/api/users` endpoints.
- A **suspended user** retains its database record and role assignments but
  cannot sign in or continue using an existing session.
- An **active administrator** is an administrator who is not suspended. The
  system must always retain at least one such account.

Roles control application capabilities, not ownership of individual media.
Download history, files, preferences, and active jobs remain shared application
state visible to every authenticated user.

## Access boundary

The following resources remain public:

- `GET /login` and `POST /login`;
- static files needed to render the sign-in page;
- `GET /api/health`, so container and deployment health checks work before an
  administrator completes setup.

Every other page and API route requires a valid active-user session, including
the SSE event stream and media-serving routes.

- An anonymous browser request for an application page redirects to `/login`.
- An unauthenticated `/api/*` request returns HTTP `401` with
  `{"error": "Authentication required"}` rather than an HTML redirect.
- A signed-in user who opens `/login` is redirected to `/`.
- The application and sign-in responses use `Cache-Control: no-store` so
  authenticated pages and credential errors are not retained by shared
  browser caches.

Authentication must run before route-specific logic so a rejected request
cannot read history, file metadata, thumbnails, previews, preferences, events,
or user data.

## Initial administrator setup

On the first database initialization:

1. Seed the `normal` and `admin` roles if they do not already exist.
2. Create the username `admin` with the `admin` role and a null password hash.
3. Persist a bootstrap marker in application configuration.
4. Generate and persist the session-signing secret if one does not exist.

While a passwordless bootstrap administrator exists, `/login` operates in
setup mode:

- show `Set administrator password` instead of the ordinary sign-in heading;
- show the administrator username as a read-only value;
- require a password and matching confirmation;
- enforce the normal password validation rules;
- atomically replace the null password with a generated hash; and
- start an authenticated administrator session after a successful update.

Other usernames cannot sign in until setup is complete. Concurrent setup
submissions must not overwrite a password that another request has already
created.

The bootstrap marker, rather than the literal username, is authoritative. An
administrator may rename `admin`; database initialization after that rename
must neither restore the old name nor create a second administrator.

## Sign-in, sessions, and sign-out

Ordinary sign-in accepts a username and password through `/login`.

- Username lookup is case-insensitive.
- An unknown username and an incorrect password produce the same `Invalid
  username or password.` message.
- A correct password for a suspended account produces `This account is
  suspended.` and does not create a session.
- Password hashes are checked with Werkzeug's password-hashing helpers. Plain
  text passwords must never be stored.
- A successful login replaces any existing session and records the user ID and
  the user's current session version.

Each private request reloads the user from SQLite and accepts the session only
when the user still exists, is active, has a password hash, and has the same
session version recorded at login. Deleting or suspending a user therefore
takes effect on that user's next request. Resetting a password increments the
session version and invalidates all previously issued sessions for that user.

The signed session cookie must be HTTP-only and use `SameSite=Lax`. Its signing
secret is stored in the database so clean application restarts do not
arbitrarily sign users out. Operators remain responsible for serving VDL over
HTTPS when cookie confidentiality over the network is required.

Sign-out is a `POST /logout` operation. It clears the current session and
redirects to `/login`.

## Role-ready data model

Persist authentication and authorization state in these SQLite tables:

| Table | Required purpose |
| --- | --- |
| `users` | User identity, case-insensitive unique username, password hash, suspension flag, session version, and creation time |
| `roles` | Case-insensitive unique role names, initially `normal` and `admin` |
| `user_roles` | Many-to-many relationship between users and roles, with cascading cleanup |
| `app_config` | Bootstrap-completion marker and persistent session-signing secret |

The role name must not be implemented as a hard-coded users-table enum. The
backend returns available roles from the `roles` table so the management UI can
render the database's current vocabulary.

New installations and existing download databases use the same idempotent
initialization path. Adding access control must preserve download history,
preferences, tags, files, and active-state crash recovery.

## Users settings experience

Add `Users` to the existing Settings navigation between Playback and Danger
Zone for administrators only. Do not render the navigation item or section for
normal users. Server-side authorization remains mandatory even when the
interface is absent.

The section contains an add-user form with:

- username;
- initial password;
- role selected from the roles returned by the server; and
- an `Add user` action.

List users case-insensitively by username. Each row shows the current role and
suspension state and provides controls to:

- rename the account;
- select its role;
- enter an optional replacement password;
- save those changes;
- suspend or resume the account; and
- remove the account after explicit confirmation.

Identify the signed-in administrator with `(you)`. Disable that row's Suspend
and Remove actions. If the administrator renames their own account, update the
username shown in the header without requiring a reload. If they demote their
own account while another active administrator exists, reload the page so the
Users section is removed.

Display management failures through the existing Settings error treatment and
reload the list after successful mutations.

## User administration API

All user endpoints require the `admin` role. A normal user receives HTTP `403`
with `{"error": "Administrator access required"}`.

| Method and path | Behavior |
| --- | --- |
| `GET /api/users` | Return public user records, role names, and the current user ID |
| `POST /api/users` | Create a user with username, password, and role; default the role to `normal` when omitted |
| `PATCH /api/users/<id>` | Update any supplied combination of username, password, role, and suspended state |
| `DELETE /api/users/<id>` | Remove the user and its role assignments |

Successful create returns HTTP `201`. Unknown user IDs return `404`. Invalid
payloads, duplicate names, unknown roles, and invariant violations return
`400` with a human-readable `error` field. User responses must omit
`password_hash` and must never return a submitted password.

Changing the current administrator's password refreshes the session version in
that same response so their initiating session remains valid. Other existing
sessions for the account become invalid.

## Validation and invariants

### Usernames

- Accept strings only.
- Normalize to Unicode NFC and trim surrounding whitespace.
- Require 1 through 64 visible characters.
- Reject control characters.
- Enforce case-insensitive uniqueness.

### Passwords

- Accept strings only.
- Require at least 8 characters and at most 1024 characters.
- Store only a generated password hash.
- Treat a blank password in an existing user's editor as `no password change`.

### Roles and suspension

- Accept only a role that exists in the roles table.
- Accept only a JSON boolean for the suspended field.
- The current administrator cannot suspend or delete their own account.
- Deleting, suspending, or demoting the last active administrator must fail.
- Renaming an administrator is allowed and does not change bootstrap state.
- Removing a user cascades removal of its role relationships but does not
  delete shared downloads or media.

## Security requirements

- Use one-way, salted password hashing through Werkzeug; never implement or
  persist reversible password encryption.
- Do not include password hashes in HTML, JSON, logs, or user-list responses.
- Resolve authorization from the current database record on every request;
  do not trust a role name stored only in the client or session cookie.
- Reject cross-origin `POST`, `PUT`, `PATCH`, and `DELETE` requests when their
  browser-supplied Origin or Fetch Metadata identifies another site.
- Apply administrator checks in Flask route handlers in addition to hiding
  administrator-only UI.
- Keep the public health response free of account and application-content
  data.
- Preserve parameterized SQL for all usernames, passwords, roles, and user IDs.

## Accessibility and responsive behavior

- Give every sign-in, setup, add-user, and user-editor control a visible label
  or equivalent accessible name.
- Expose sign-in and setup errors in an alert region.
- Use appropriate password autocomplete values: `current-password` for normal
  sign-in and `new-password` for setup and administrative resets.
- Keep user controls keyboard operable with visible focus treatment.
- Announce refreshed user-list content through a polite live region.
- Keep add and edit forms within the viewport at desktop, tablet, and narrow
  mobile widths by collapsing their grid layout as space decreases.
- Preserve light, dark, and system theme behavior on both the sign-in page and
  Users settings section.

## Acceptance criteria

- A fresh database creates exactly one passwordless `admin` administrator and
  records bootstrap completion.
- Before setup, visiting `/` redirects to `/login` and displays the initial
  administrator password form.
- The setup form rejects mismatched or invalid passwords, hashes a valid
  password, signs the administrator in, and cannot overwrite an already-set
  password.
- Renaming the bootstrap administrator and restarting the application does not
  recreate the username `admin`.
- Anonymous requests cannot read any existing application page, private API,
  SSE stream, thumbnail, preview, or media file. `/api/health` remains usable.
- Page requests redirect anonymous visitors to `/login`; API requests receive
  a JSON `401` response.
- Valid active users can sign in and sign out. Incorrect credentials and
  suspended accounts cannot create a session.
- Normal users can use the existing media application but cannot see Users in
  Settings and receive `403` from every user-administration endpoint.
- Administrators can add normal and administrator users, rename them, change
  roles, reset passwords, suspend and resume access, and remove accounts.
- Passwords in the database are hashes and no user API response contains a
  password hash.
- Suspending or deleting a user blocks its existing session on the next
  request. Resetting a password invalidates sessions issued with the previous
  session version.
- The application rejects every operation that would leave no active
  administrator and rejects self-suspension and self-removal.
- Role names are stored in `roles`, assignments are stored in `user_roles`, and
  the schema can represent more than one role per user without migration.
- Existing databases gain the authentication tables and bootstrap account
  without losing download, preference, tag, or file state.
- Cross-origin browser mutations are rejected while same-origin UI and
  non-browser API clients continue to work.
- User management and first-login flows remain usable at a 390 px viewport and
  with keyboard navigation.

## Verification

Automated coverage must include:

- backend tests for private-route enforcement, bootstrap setup, password
  hashing, login/logout, suspension, normal-user denial, administrator CRUD,
  last-administrator protection, rename persistence, and session invalidation;
- migration tests for all authentication tables, seeded roles, the bootstrap
  administrator, bootstrap marker, and persistent session secret;
- browser tests for anonymous redirection, valid sign-in, and administrator
  add/suspend/password-reset/remove interactions; and
- container smoke tests proving that health remains public, application data
  remains private, first-login setup works, and an authenticated request can
  use the application.

Run the repository suites with:

```bash
python -m unittest discover -s tests -v
python tests/browser/run.py
bash tests/container/smoke.sh
```

## Non-goals

- Per-user download libraries, ownership, quotas, or preference sets.
- Fine-grained permissions beyond the normal/admin distinction.
- Exposing multiple simultaneous role assignments in the current API or UI.
- Self-service registration, password changes, or password recovery.
- Email addresses, invitations, profile data, avatars, or account verification.
- Multi-factor authentication, SSO, OAuth, LDAP, or external identity
  providers.
- Login rate limiting, account lockout, audit logging, or administrator action
  history.
- Replacing Flask's signed-cookie sessions with server-side sessions or tokens.
- Providing TLS termination inside the Flask application or development
  server.
