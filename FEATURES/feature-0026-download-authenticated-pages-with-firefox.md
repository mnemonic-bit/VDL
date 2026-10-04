# Download authenticated pages with a Firefox companion

**Source:** User-requested feature  
**Status:** Proposed  
**Last refined:** 2026-10-01  
**Extends:** Feature 0022, Move settings to a searchable, sectioned page; Feature 0023, Require authentication and manage users

## Decision summary

Provide a signed, self-distributed Firefox WebExtension named **VDL
Companion**. After a one-time pairing, clicking its toolbar action sends the
active page URL and the cookies Firefox considers applicable to that page to
the user's VDL instance and starts a private download. The extension never
asks for, sees, or stores the user's website password.

Bundle the Mozilla-signed XPI in native releases and in the VDL container so
an authenticated user can start installation from the Browser Extension
section in Settings. Firefox must still show and receive confirmation for its
own add-on installation prompt. Firefox does not allow the installing web page
to configure a WebExtension, so installation and pairing remain two explicit
steps. The Settings page reduces pairing to copying one short-lived pairing
string and pasting it into the extension's onboarding page.

Scope the first release to desktop Firefox 140 or later on Linux, macOS, and
Windows. Use one platform-neutral Manifest V3 XPI. Support ordinary Firefox
profiles and Firefox Containers, but not private windows, Firefox for Android
or iOS, partitioned cookies, or First-Party Isolation cookies in v1.

Treat both the browser cookies and the companion bearer token as credentials.
Trusted HTTPS remains the production default. Also allow loopback HTTP and
operator-configured RFC1918 private or RFC6598 shared IPv4 CIDRs for local deployments. This exception
is explicit, unencrypted, limited to literal private addresses, and disabled
for LAN ranges unless the operator configures `VDL_COMPANION_HTTP_CIDRS`.

Website cookies are ephemeral. VDL validates the structured cookie bundle,
converts it into a seekable in-memory Netscape-format stream, and reuses that
stream across the yt-dlp probe, download, format fallback, and final metadata
phases. It never writes browser cookies to SQLite, the download directory, a
temporary file, logs, SSE, or an API response. It drops the stream on every
terminal path. A process restart therefore requires a new toolbar click before
an interrupted authenticated download can resume.

## User outcome

After setup, the normal path is:

1. The user signs in to a supported website in Firefox and opens the page that
   contains the video.
2. The user clicks **Download current page with VDL** in the Firefox toolbar.
3. On the first use for that website host, Firefox asks whether VDL Companion
   may access data for that host. If the user grants it, the same action
   continues. Later uses on that host require only the toolbar click.
4. The extension captures the page URL and eligible cookies from that tab's
   cookie store, sends them directly to the paired VDL origin, and briefly
   shows a success or failure badge.
5. VDL creates or resumes a private Current item owned by the paired user and
   uses the cookie snapshot only for that live worker.

The extension does not open a quality dialog. The download uses VDL's current
default format and filename behavior. The owner can change the finished
item's visibility through the existing VDL controls.

## Terms

- A **companion connection** is a revocable association between one Firefox
  profile and one VDL user account.
- A **pairing string** contains the browser-visible allowed origin of VDL and a
  short-lived, single-use pairing code. It is a credential until it expires or
  is used.
- A **companion token** is the persistent, narrowly scoped bearer credential
  held by the extension after pairing.
- A **cookie snapshot** is the eligible cookie data captured by one explicit
  toolbar action. It is not synchronized after capture.
- An **authenticated download** is a download row started through the
  companion API and marked as requiring a fresh browser handoff for any later
  resume.
- **Protocol version 1** is the request/response contract defined by this
  specification. It is independent of the extension package version.

## Supported environment

### Browser and operating systems

- Support desktop Firefox Release and ESR only when the browser version is at
  least 140.
- Ship one XPI for Firefox on Linux, macOS, and Windows. The extension contains
  no native binary or native-messaging helper.
- Declare `incognito: "not_allowed"`. The action must not be available to a
  private tab and no private-window data may enter extension storage.
- Do not declare Android support. Firefox for Android and Firefox for iOS are
  outside this release.

### VDL transport

- Accept only a normalized trusted `https://host[:port]` origin or an allowed
  `http://private-ip[:port]` origin with no username, password, path other than
  `/`, query, or fragment.
- Firefox must trust the origin's certificate. The extension must not provide
  certificate overrides or an insecure mode.
- VDL itself does not terminate TLS. Operators may put it behind a trusted
  HTTPS reverse proxy. The browser-visible origin, obtained from
  `window.location.origin`, is authoritative during pairing, so TLS
  termination at a reverse proxy does not require Flask to infer the public
  scheme.
- Loopback HTTP is enabled by default. RFC1918 private or RFC6598 shared IPv4 HTTP is accepted only when
  the destination address belongs to a CIDR explicitly configured by the VDL
  operator. Public HTTP, `.local`/arbitrary hostnames, and non-allowlisted
  private HTTP remain rejected. The UI and privacy notice disclose that the
  exception has no transport encryption.

### yt-dlp floor

Require yt-dlp `2026.06.09` or later. Raise the native dependency floor from
its current older minimum and keep the container pinned at a version no older
than that floor. Earlier versions have a published cookie-leak issue in a curl
external-downloader path. The implementation must not rely on the current
environment happening to install a newer version than the declared native
minimum.

## Extension identity, source, and packaging

Use these immutable identities for the first signed release:

| Item | Value |
| --- | --- |
| Display name | `VDL Companion` |
| Firefox add-on ID | `{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}` |
| Initial package version | `1.0.0` |
| Initial companion protocol | `1` |

The add-on ID must never change after the first signed release. Changing it
would create a separate extension, lose the existing extension storage, and
break the update lineage.

Use a reviewable, framework-free source tree:

```text
browser-extension/
├── src/
│   ├── manifest.json
│   ├── background.js
│   ├── onboarding.html
│   ├── onboarding.js
│   ├── options.html
│   ├── options.js
│   ├── extension.css
│   ├── privacy.html
│   └── icons/
├── dist/
│   ├── vdl-companion-firefox.xpi
│   └── vdl-companion-firefox.xpi.sha256
└── README.md
```

- Keep the extension vanilla HTML, CSS, and JavaScript. Do not introduce a
  frontend bundler, transpiler, framework, remote module, or runtime CDN.
- All executable code must be inside the XPI. Do not use `eval`, downloaded
  code, analytics, telemetry, advertising, or third-party error reporting.
- Build the unsigned package with Mozilla's `web-ext` tooling and sign it as
  an **unlisted** extension through AMO. Signing happens outside the Docker
  build. AMO API credentials and signing keys must never enter the repository,
  build context, image layers, or runtime container.
- Track or attach the signed XPI and its SHA-256 as release inputs. A release
  check must unpack it, ignore Mozilla's signature metadata, and verify that
  every remaining payload file matches the reviewed `src/` tree.
- Copy the exact signed XPI into the container image. Fail the image build when
  the artifact or checksum is absent or mismatched.
- The XPI version is independent of root `VERSION`. Any repository code change
  still follows the project's normal root-version rule; a change to extension
  behavior also increments the XPI version.

### Manifest contract

The signed manifest uses Manifest V3 and includes, at minimum:

```json
{
  "manifest_version": 3,
  "name": "VDL Companion",
  "version": "1.0.0",
  "permissions": ["activeTab", "cookies", "storage"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "incognito": "not_allowed",
  "background": {"scripts": ["background.js"]},
  "action": {"default_title": "Download current page with VDL"},
  "browser_specific_settings": {
    "gecko": {
      "id": "{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}",
      "strict_min_version": "140.0",
      "data_collection_permissions": {
        "required": [
          "browsingActivity",
          "websiteContent",
          "authenticationInfo"
        ]
      }
    }
  }
}
```

The broad optional host patterns are an ungranted capability ceiling, not an
install-time grant. At runtime, request only the exact active website host and
the exact paired VDL host. Firefox match patterns do not restrict ports, so the
extension's own network code must additionally pin the VDL destination to the
stored `(scheme, normalized hostname, effective port)` tuple.

Do not request `tabs`, `scripting`, `content_scripts`, `webRequest`, `history`,
`downloads`, `contextualIdentities`, native messaging, or a persistent
`<all_urls>` grant. Register all event listeners synchronously at the top level
because Firefox implements an MV3 background script as a non-persistent event
page.

Do not include `update_url` in v1. A generic signed XPI cannot point automatic
updates at whichever private VDL instance installed it, and no stable
project-controlled HTTPS update service is part of this feature. A newer VDL
release bundles a higher-versioned XPI; the user installs it from Settings and
Firefox updates the existing add-on in place because its ID is unchanged.

## Installation and pairing experience

### Browser Extension settings section

Add **Browser Extension** to Settings for every authenticated user, after
Playback and before Users or Danger Zone. It contains:

- a short explanation that the companion sends the current URL and that
  site's cookies only after a toolbar click;
- a warning that cookies can grant the same website access as the signed-in
  browser session;
- a transport-readiness check based on `window.location.origin` and the
  server's configured private-HTTP CIDRs;
- **Install Firefox extension** or **Update Firefox extension**, linked
  directly to the bundled signed XPI;
- **Create pairing string**, **Copy pairing string**, its five-minute expiry,
  and **Invalidate**;
- a list of this user's active companion connections showing device label,
  extension version, paired time, and last-used time; and
- a **Revoke** action for each connection.

When the page is neither HTTPS nor an allowed private HTTP origin, keep
installation available but disable pairing generation and explain how the
operator can configure a private or shared IPv4 CIDR.
Do not claim that clicking Install silently installs or pairs the extension.
The UI must state that Firefox will show an Add confirmation and that the
extension onboarding page will request the pairing string once.

### XPI delivery

Expose the signed artifact at:

```text
GET /browser-extension/vdl-companion-firefox.xpi
```

This artifact is public, like the assets needed by the login page; it contains
no user or server secret. Return:

- `Content-Type: application/x-xpinstall`;
- `Content-Disposition: inline; filename="vdl-companion-firefox.xpi"`;
- `Cache-Control: no-store`; and
- `X-Content-Type-Options: nosniff`.

The route serves only the build-time artifact after verifying its configured
SHA-256. It accepts no filename component and must not become a general file
server. A missing or invalid artifact is a server/release error and disables
the Settings install action.

### Pairing string

`POST /api/extension/pairing-codes` creates one code for the current signed-in
user. It is an ordinary session-authenticated, same-origin mutation. It
returns the raw code once and replaces any earlier unconsumed code for that
user.

- Generate 16 random bytes with `secrets.token_bytes`, encode them as unpadded
  base64url, and prefix the display value with `VDL1-`.
- Keep only an HMAC-SHA-256 verifier, user ID, creation time, and expiry in a
  lock-protected in-process map. Use the application's persistent signing
  secret as the HMAC key.
- Expire it after five minutes, consume it atomically on a successful exchange,
  and discard all outstanding codes when the process exits.
- A code is single-use even when the client loses the successful response.

The Settings frontend combines the response with its own
`window.location.origin` and copies this format:

```text
vdl-pair-v1:<unpadded-base64url-of-utf8-json>
```

The JSON is exactly:

```json
{"origin":"https://vdl.example:8443","code":"VDL1-…"}
```

The extension onboarding page accepts that single pasted value, decodes and
validates it locally, displays the normalized origin prominently, and requires
the user to click **Pair with this VDL**. It must reject extra fields, public
or non-private HTTP, credentials, paths, queries, fragments, invalid
base64url, and an invalid code shape before making a network request.

Firefox does not implement web-page-to-extension external messaging, so the
VDL page must not attempt silent post-install configuration, a content-script
workaround, or automatic extraction of the pairing string.

### Pairing exchange

On the Pair click, the extension:

1. requests the optional host permission for the normalized allowed VDL host;
2. stops without sending anything if permission is denied;
3. sends `POST /api/extension/pair` from the background page with
   `credentials: "omit"`, `cache: "no-store"`, and `redirect: "error"`;
4. supplies the code, a user-editable device label, package version, and
   protocol version; and
5. stores the returned VDL origin and bearer token in `browser.storage.local`
   only after the server confirms success.

`storage.local` is not encrypted. The onboarding and privacy text must say so.
Do not use `storage.sync`. Never store website cookies, page URLs, download
IDs, request bodies, or a browsing history in extension storage. V1 supports
one paired VDL origin per Firefox profile; pairing a different origin requires
unpairing the current connection first.

The options page shows the paired origin, paired username, device label,
extension version, last successful contact, **Test connection**, **Unpair**,
and the privacy disclosure. Unpairing first calls the token self-revocation
endpoint when reachable, then deletes all local connection state even if that
request fails.

## Companion token model

Return a bearer token once in this form:

```text
vdlx_<22-character-base64url-id>.<43-character-base64url-secret>
```

The ID represents 128 random bits and the secret represents 256 random bits.
Persist only an HMAC-SHA-256 verifier of the full token, keyed by the
application signing secret. Compare verifiers with `hmac.compare_digest`.

Create this table with `CREATE TABLE IF NOT EXISTS` in `init_db()`:

```sql
CREATE TABLE extension_tokens (
    id                     TEXT PRIMARY KEY,
    user_id                INTEGER NOT NULL
                               REFERENCES users(id) ON DELETE CASCADE,
    token_verifier         BLOB NOT NULL,
    device_label           TEXT NOT NULL,
    extension_version      TEXT NOT NULL,
    protocol_version       INTEGER NOT NULL,
    paired_session_version INTEGER NOT NULL,
    created_at             REAL NOT NULL,
    last_used_at           REAL
);
CREATE INDEX extension_tokens_user_id
    ON extension_tokens(user_id);
```

Rules:

- Normalize a device label to Unicode NFC, trim it, reject control characters,
  and require 1 through 80 visible characters.
- On every token-authenticated request, reload the associated user. Accept the
  token only when the user exists, has a password, is not suspended, and the
  current `session_version` equals `paired_session_version`.
- Password reset/session-version change, suspension, deletion, explicit
  revoke, or self-unpair invalidates the connection. Ordinary browser sign-out
  does not revoke it; the UI must disclose this distinction.
- Update `last_used_at` and the reported extension version after successful
  authentication, but at most once every five minutes per token to avoid a
  database write on every action.
- The token authorizes only companion status, private download submission or
  authenticated resume, and self-revocation. It cannot read history, stream
  files, change visibility or preferences, receive SSE, administer users, or
  call any existing VDL endpoint.
- Return the same generic `401 {"error":"Companion authentication failed"}`
  for malformed, unknown, revoked, invalidated, or suspended-user tokens.

## HTTP API contract

All responses are JSON except the XPI. Add `Cache-Control: no-store` to every
pairing, connection, status, and download response.

### Session-authenticated management API

| Method and path | Behavior |
| --- | --- |
| `POST /api/extension/pairing-codes` | Replace and return the current user's five-minute code |
| `DELETE /api/extension/pairing-codes/current` | Invalidate the current user's unconsumed code; idempotent `204` |
| `GET /api/extension/connections` | List only the current user's active connections; never return token verifiers |
| `DELETE /api/extension/connections/<id>` | Revoke a connection owned by the current user; unknown/not-owned IDs return `404` |

Administrators do not gain a general token-list endpoint through this feature.
Suspending or resetting another user already invalidates their tokens through
the checks above; deleting the user cascades their token rows.

The pairing-code response uses Unix seconds:

```json
{
  "code": "VDL1-…",
  "expires_at": 1790870700
}
```

The connection-list response is:

```json
{
  "connections": [
    {
      "id": "…",
      "device_label": "Firefox on Alice's laptop",
      "extension_version": "1.0.0",
      "protocol_version": 1,
      "created_at": 1790870400,
      "last_used_at": 1790870520
    }
  ],
  "bundled_extension": {
    "version": "1.0.0",
    "url": "/browser-extension/vdl-companion-firefox.xpi",
    "sha256": "…"
  },
  "http_pairing_allowed": false
}
```

`last_used_at` is null until the token's first post-pair authenticated request.
No management response contains a token, verifier, paired session version, or
another user's connection.
`http_pairing_allowed` reports whether the current literal request host is in
the operator's private-HTTP CIDR policy; HTTPS readiness remains authoritative
in the browser through `window.location.origin`.

### Cross-origin companion API

| Method and path | Authentication | Behavior |
| --- | --- | --- |
| `POST /api/extension/pair` | Single-use code | Exchange a valid code for one token |
| `GET /api/extension/status` | Bearer token | Return user, server, package, and protocol compatibility metadata |
| `POST /api/extension/downloads` | Bearer token | Start, deduplicate, or resume a private authenticated download |
| `DELETE /api/extension/token` | Bearer token | Revoke the calling token and return `204` |

Every companion request supplies:

```text
X-VDL-Companion-Protocol: 1
X-VDL-Companion-Version: <manifest version>
```

Unsupported protocols return HTTP `426` with:

```json
{
  "error": "Companion update required",
  "code": "incompatible_protocol",
  "supported_protocols": [1],
  "extension_url": "/browser-extension/vdl-companion-firefox.xpi"
}
```

Status success is HTTP `200`:

```json
{
  "paired": true,
  "user": {"username": "alice"},
  "protocol_version": 1,
  "server_version": "…",
  "bundled_extension": {
    "version": "1.0.0",
    "url": "/browser-extension/vdl-companion-firefox.xpi",
    "sha256": "…"
  }
}
```

The pair endpoint accepts at most 16 KiB. The download endpoint requires a
`Content-Length`, accepts at most 256 KiB, and rejects larger bodies with
`413` before parsing JSON. Require `application/json`; otherwise return `415`.

### Pair request and response

Request:

```json
{
  "code": "VDL1-…",
  "origin": "https://vdl.example:8443",
  "device_label": "Firefox on Alice's laptop",
  "extension_version": "1.0.0",
  "protocol_version": 1
}
```

Success is HTTP `201`:

```json
{
  "token": "vdlx_….…",
  "connection_id": "…",
  "user": {"username": "alice"},
  "protocol_version": 1,
  "server_version": "…",
  "bundled_extension_version": "1.0.0"
}
```

Invalid, expired, replaced, or already-used codes all return the same HTTP
`401` response. Rate-limit failed exchanges to 10 per minute per
`request.remote_addr` and 60 per minute process-wide with bounded,
lock-protected in-memory counters. Do not trust `X-Forwarded-For` unless a
separate deployment feature adds an explicit trusted-proxy configuration.
Bind each code to the exact normalized origin that created it and require the
pair request to repeat that origin, so editing a pairing string cannot bypass
the operator's private-HTTP CIDR policy.

### Download request

Request headers include `Authorization: Bearer <token>`. The body schema is:

```json
{
  "schema": 1,
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "page_url": "https://video.example/watch/123?episode=4",
  "captured_at": 1790870400,
  "cookies": [
    {
      "name": "session",
      "value": "…",
      "domain": "video.example",
      "host_only": true,
      "path": "/",
      "secure": true,
      "http_only": true,
      "expires": null
    }
  ]
}
```

No other top-level or cookie fields are accepted. In particular, the endpoint
does not accept a filename, output path, format selector, arbitrary yt-dlp
option, visibility, owner, headers, user agent, or additional cookie domains.
Require a lowercase canonical UUIDv4 for `request_id`. Require `captured_at` to
be a non-negative integer Unix timestamp no more than ten minutes in the past
or future; it is freshness validation only, is not an authentication factor,
and is not persisted.

For a new download, return HTTP `201`:

```json
{
  "id": "a1b2c3d4",
  "action": "started",
  "status": "starting",
  "visibility": "private"
}
```

When the current user already has an active authenticated row with exactly the
same normalized URL, return HTTP `200` with that ID and
`"action":"already_active"`. When a cancelled or interrupted authenticated
row exists, atomically claim the newest such row, start it with the fresh
cookie snapshot, and return HTTP `200` with `"action":"resumed"`. Finished or
error rows do not prevent a new download.

`request_id` is a UUID generated once per toolbar action. Add
`extension_request_id TEXT` to the downloads migration list and create a
partial unique index on `(owner_user_id, extension_request_id)` when the value
is not null. A retry with the same user and request ID returns the previously
associated row rather than launching a duplicate. If that ID is reused with a
different normalized URL, return `409` with `code: "request_id_conflict"`.

Resolve one submission under `_db_lock` and one SQLite transaction in this
order: existing row for the same owner/request ID; active
`starting`/`downloading`/`paused` authenticated row for the same canonical
URL; newest `cancelled`/`interrupted` authenticated row ordered by
`created_at DESC, id DESC`; otherwise a new row. Claim a resumable row by
changing it to `starting` in that transaction. Start exactly one worker only
after commit, and publish the change event after commit.

### Error vocabulary

Use a stable machine-readable `code` alongside a short `error` message:

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_request` | Invalid JSON shape, URL, cookie, label, or ID |
| `401` | `companion_auth_failed` | Code/token is unusable or its user is inactive |
| `409` | `request_id_conflict` | An idempotency key was reused for another URL |
| `413` | `request_too_large` | Route-specific body limit exceeded |
| `415` | `unsupported_media_type` | Request is not JSON |
| `426` | `incompatible_protocol` | Extension/server protocol mismatch |
| `429` | `rate_limited` | Pairing or token request limit exceeded |
| `500` | `extension_package_unavailable` | Bundled XPI failed integrity validation |

Do not put cookie names, cookie values, bearer tokens, raw URLs, pairing codes,
or request bodies in an error response.

## Cross-origin boundary

Preserve the existing session requirement and same-origin mutation guard for
every existing route. Exempt only the four companion routes and their OPTIONS
requests from session authentication. Each exempt route must authenticate its
own one-time code or bearer token before performing work.

- Accept a browser-supplied Origin only when it is a syntactically valid
  `moz-extension://<host>` origin. Reject ordinary HTTP(S), `null`, and
  malformed origins on companion mutations. If Firefox omits Origin for a
  privileged background request, code/token authentication remains mandatory.
- For a valid extension Origin, echo it in
  `Access-Control-Allow-Origin`, add `Vary: Origin`, and never set
  `Access-Control-Allow-Credentials`.
- OPTIONS may allow only the route's method and the headers
  `Authorization`, `Content-Type`, `X-VDL-Companion-Protocol`, and
  `X-VDL-Companion-Version`. Cache a successful preflight for no more than 600
  seconds.
- When a valid preflight includes
  `Access-Control-Request-Private-Network: true`, return
  `Access-Control-Allow-Private-Network: true`. This is transport
  compatibility, not authentication.
- The extension always uses `credentials: "omit"`, `cache: "no-store"`, an
  explicit timeout, bounded response parsing, and `redirect: "error"`.
- After pairing, every request URL is constructed from the stored exact VDL
  origin and a hard-coded relative API path. Never follow a response redirect
  or accept an API-provided absolute destination.

Capture actual Origin, Fetch Metadata, preflight, and Private/Local Network
Access behavior with a signed XPI on the minimum supported Firefox before
release. Compatibility findings may narrow accepted headers but must not
weaken code/token authentication, the configured transport policy, or
exact-origin pinning.

## Active-page and cookie selection

The toolbar action operates only on the `tab` passed to
`browser.action.onClicked`.

1. Require a normal, non-private tab with an `http:` or `https:` URL.
2. Reject `about:`, `file:`, `data:`, `blob:`, browser-extension, and other
   schemes.
3. Reject an active page whose origin is the paired VDL origin. This prevents
   sending VDL's own session cookie back through the downloader and instructs
   the user to open the video page instead.
4. Remove the URL fragment. Preserve the query because it may identify the
   media, while disclosing in Settings that VDL persists download URLs and
   their queries in its existing download database.
5. Reject embedded URL usernames or passwords and URLs longer than 8,192 UTF-8
   bytes.
6. If needed, request an optional host grant for exactly the active page's
   scheme and hostname. Denial cancels the action without reading cookies.
7. Call the Cookies API with the page URL and the tab's `cookieStoreId` so a
   Firefox Container never leaks cookies from the default profile or another
   Container.
8. Enumerate candidates with the URL and store plus `partitionKey: {}` and
   `firstPartyDomain: null`, which lets Firefox report partition/FPI metadata
   without querying another host or store. Select only unexpired cookies whose
   returned partition key is absent/unpartitioned and whose
   `firstPartyDomain` is empty/absent. Do not flatten the other contexts.
9. Project only the wire fields specified above, send the request immediately,
   and discard the array in a `finally` path.

The extension and server use the same URL canonicalization for deduplication:
lowercase the scheme and IDNA hostname, reject an invalid port, omit port 443
for HTTPS and port 80 for HTTP, preserve any other explicit port, replace an
empty path with `/`, preserve the path and query octets without percent-decode
and re-encode transformations, and remove the fragment. Cookie and resume
checks use the server-produced canonical value; the database stores that value.

V1 deliberately omits partitioned and FPI cookies. If Firefox reports only
unsupported-context cookies for the page, show an actionable local error:
`This sign-in uses partitioned or First-Party Isolation cookies, which VDL
Companion does not support yet.` If both eligible and unsupported cookies are
present, proceed with eligible cookies; a later authentication failure may
explain this limitation. Do not request broader host access automatically.

### Cookie validation at VDL

- Accept zero through 300 cookies.
- Require a non-empty name of at most 256 UTF-8 bytes and a value of at most
  16,384 bytes. Values may be empty.
- Limit domain to 253 ASCII bytes and path to 2,048 UTF-8 bytes.
- Reject NUL, ASCII control characters, DEL, tabs, CR, and LF in every string.
- Require `host_only`, `secure`, and `http_only` to be JSON booleans.
- Require a path beginning with `/`.
- Normalize one leading dot away for comparison. A host-only cookie domain
  must equal the page hostname. A domain cookie must equal the hostname or be
  its dot-delimited parent. IP-literal cookies must match exactly.
- Apply RFC-style cookie path matching: accept when the cookie path equals the
  request path, or is its prefix and either ends in `/` or is followed by `/`
  in the request path. Reject a cookie that could not apply to that URL.
- Reject a secure cookie for a non-HTTPS page URL.
- Accept `expires` as null for a session cookie or as a finite integer Unix
  timestamp in the supported Python range; reject an already expired cookie.
- Reject duplicate `(normalized domain, path, name)` tuples.
- Convert internationalized page hostnames with IDNA and compare the ASCII
  forms. Browser-supplied cookie domains must already be ASCII/IDNA-safe.

Structured JSON is mandatory; never accept an uploaded Netscape cookie file.
The server, not the extension, is responsible for escaping and conversion.

## Download persistence and ownership

Append these fields to the existing downloads migration list; do not modify
the initial `CREATE TABLE downloads` statement:

```sql
ALTER TABLE downloads ADD COLUMN
    browser_authenticated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE downloads ADD COLUMN extension_request_id TEXT;
```

Then create the idempotency index described above.

- Insert an authenticated row in one transaction with
  `browser_authenticated = 1`, `visibility = 'private'`, the token user's
  `owner_user_id` and current username snapshot, and the request ID. Never
  insert it as public and update it afterward.
- Publish the normal change event only after the transaction commits. SSE and
  history payloads must not contain cookie or token data.
- Existing rows migrate to `browser_authenticated = 0` and retain their
  current behavior.
- A companion token cannot choose another owner or public visibility.
- Exact-URL active deduplication and resume searches are scoped to the token
  user's `owner_user_id` and `browser_authenticated = 1`. They must not reveal
  another user's private row.
- An authenticated row remains marked after completion so later interrupted
  or cancelled behavior is unambiguous.

The normal `/api/resume` endpoint must return `409` with code
`fresh_browser_cookies_required` for a cancelled/interrupted row whose
`browser_authenticated` flag is true. The frontend replaces its ordinary
Continue action with **Re-send from Firefox** and explains that the user must
open the source page while signed in and click the companion action. A fresh
companion submission for the same URL atomically claims that row and relies on
the existing `continuedl=True` behavior to reuse its `.part` file.

## In-memory yt-dlp cookie bridge

### Conversion

After the request is fully validated, pass the structured cookie bundle only
as an argument to the new worker thread. Once the worker owns a concurrency
slot, convert it to a dedicated `io.StringIO`-compatible stream containing:

```text
# Netscape HTTP Cookie File
<domain>\t<include-subdomains>\t<path>\t<secure>\t<expires>\t<name>\t<value>
```

- Prefix the domain with `#HttpOnly_` when `http_only` is true, as supported
  by yt-dlp's `YoutubeDLCookieJar`.
- Use `FALSE` and an unprefixed host for host-only cookies.
- Use `TRUE` and a leading-dot domain for domain cookies.
- Use `TRUE`/`FALSE` for secure and `0` for a session-cookie expiry.

Implement a small private `RewindingCookieBuffer` wrapper. Its clear/truncate
operation must truncate to zero **and** seek to offset zero, because yt-dlp
writes a refreshed cookie jar when a `YoutubeDL` context closes. Before every
new context, seek to zero. Reuse the same stream for:

- initial `extract_info(download=False)`;
- the selected-format download;
- the existing literal `Requested format is not available` fallback; and
- any final metadata/re-probe that performs network extraction.

Apply deployment-wide options with `yt_dlp_options()` before adding
`cookiefile` to the returned dict. That helper deep-copies its input; placing
the secret stream in the input would duplicate the buffer and break the
single-jar lifecycle.

Do not use a named temporary file, a `/tmp` jar, a file in the download
directory, an environment variable, or a command-line argument. Do not add a
global cookie jar shared between jobs.

### Lifecycle

| Event | Cookie behavior |
| --- | --- |
| Waiting for a worker slot | Keep only this job's structured bundle in its worker argument |
| Probe/download/fallback | Reuse the same in-memory stream so server-refreshed cookies carry forward |
| Pause/unpause | Keep the stream while the worker thread remains alive |
| Cancel while paused | Existing cancel behavior wakes the worker; cleanup then closes the stream |
| Finished/error/cancelled | Close the stream and drop all bundle/value references in `finally` |
| Process crash/restart | Memory is lost; the row becomes `interrupted` and requires a fresh toolbar click |
| Companion resume | Build a new stream from newly captured browser cookies and reuse the existing partial media |

The implementation may minimize object lifetimes, but it must not promise
cryptographic memory erasure: Python strings and allocator copies cannot be
reliably zeroized. The VDL process owner remains trusted and can inspect
process memory while a job is live.

## Extension action behavior

- An unpaired toolbar click opens the onboarding page.
- A paired click immediately marks the action busy, validates the tab, obtains
  the site permission if necessary, captures cookies, and submits once.
- Use a 30-second request timeout. A timeout or ambiguous network failure may
  retry once with the same `request_id`; it must never generate a new request
  ID for an automatic retry.
- Show `…` while working, `✓` for three seconds after `started`, `resumed`, or
  `already_active`, and `!` after an error. Also set the action title to a
  useful short status so the badge is not the only indicator.
- Do not request the notifications permission. Detailed failures open or link
  to the packaged options/status page, where they appear in an alert region.
- A denied site permission, invalid page, incompatible protocol, revoked
  token, untrusted certificate, offline VDL, and unsupported cookie context
  each receive distinct user-facing guidance.
- A `401` clears no local token automatically, because a temporary server-side
  state could be misdiagnosed. Mark the connection unusable and offer
  **Re-pair**. Explicit Unpair removes it.

## Settings and Current-item behavior

The Browser Extension settings section uses the existing searchable-settings
patterns, theming variables, focus treatment, status/error components, and
responsive layout. It must remain usable at a 390 px viewport.

- Pairing codes and tokens must never be rendered into HTML attributes, URLs,
  logs, or browser history. The raw pairing string lives only in a text control
  until expiry/invalidation and is cleared when the user leaves the section.
- Copy success and errors are announced through a polite live region.
- Connection revoke requires explicit confirmation and preserves keyboard
  focus predictably after removal.
- Compare each connection's last reported extension version with the bundled
  manifest version. Show Update when the bundled version is newer, but do not
  claim that an install completed until the companion next reports that
  version.
- Mark authenticated Current items with a small **Firefox session** label.
- For authenticated cancelled/interrupted items, replace Continue with
  **Re-send from Firefox**. This is guidance, not a button that can trigger the
  external toolbar action.
- Authentication failures should say that the session may have expired or
  rotated and direct the user to revisit the signed-in source page. Do not
  display cookie details.

## Privacy and security requirements

- Capture occurs only in direct response to the toolbar action. Do not watch
  navigation, poll tabs, collect history, prefetch cookies, or continuously
  synchronize a session.
- The extension sends data only to the user-confirmed, exact paired VDL origin.
  The extension developer receives nothing.
- Use the current tab's cookie store and current page URL only. Do not export a
  browser-wide jar or all cookies accessible through granted hosts.
- Default every authenticated download to private. The URL and query still
  persist in the existing downloads table; disclose that fact because URLs
  can themselves contain secrets.
- Never persist raw pairing codes, companion tokens, token verifiers, cookie
  names/values, or authorization headers in logs. Token verifiers are the only
  token-derived database value.
- Install a per-worker redactor around every yt-dlp message that can reach the
  database, application logger, exception response, or UI. It must replace
  exact cookie values and authorization material, strip URL fragments, and
  replace URL queries in diagnostic text with `?<redacted>` before the message
  leaves the worker.
- Do not log companion request bodies or Authorization headers. Access logs
  may record only method, route, status, size, and normal transport metadata.
- Use parameterized SQL for every token, request ID, device label, and owner.
- Enforce route body limits before JSON parsing and allowlist every JSON field.
- Compare credentials in constant time. Generate codes, IDs, and secrets with
  Python's `secrets` module, never `random` or UUID entropy alone.
- Rate-limit valid download submissions to 10 per minute per companion token.
  This is abuse containment, not a quota; an accepted idempotent retry counts
  once.
- Do not weaken the existing exact format-unavailable fallback rule. Generic
  authentication, network, ffmpeg, or extractor errors must not trigger a
  different-format retry.
- Do not attempt to bypass paywalls, DRM, CAPTCHA, bot protection, geographic
  restrictions, account authorization, or a site's terms. The user must have
  legitimate browser access to the requested media.

## Expected limitations and failure messages

Cookies are not a complete browser session. A download may still fail when a
site depends on:

- a sibling identity-provider domain or a cookie not applicable to the active
  URL;
- a partitioned/FPI cookie;
- localStorage, IndexedDB, a bearer header, a client certificate, a passkey, or
  a browser-bound key;
- a matching browser User-Agent or other request headers;
- short-lived, rotating, device-bound, or IP-bound tokens;
- JavaScript challenges, CAPTCHA, Proof-of-Origin/token providers, or DRM; or
- an extractor that does not support the site.

Report these as site/session limitations. Never respond by silently requesting
all-site permissions, additional domains, browser history, or arbitrary
headers. Support for explicitly chosen related domains or headers requires a
later feature and a new privacy review.

## Implementation map

| Area | Required change |
| --- | --- |
| `vdl.py` | Migrations, token/code stores, validators, scoped companion auth and CORS, XPI serving, private/idempotent insert/resume, in-memory cookie bridge, redaction, resume guard |
| `templates/index.html` | Browser Extension settings markup and any new shared icons in the existing SVG symbol library |
| `static/app.js` | Settings navigation, XPI/package state, pairing-string lifecycle, connection list/revoke, authenticated-row guidance |
| `static/styles.css` | Responsive settings/connection/status styles using existing theme variables |
| `browser-extension/` | Reviewable MV3 source, privacy text, signed artifact, checksum, developer instructions |
| `Dockerfile` | Copy and integrity-check the signed XPI; no browser, AMO credential, or signing tool at runtime |
| dependency locks | Require yt-dlp `>=2026.06.09` natively and retain a safe container pin |
| tests | Backend, extension-unit, browser, container, signed-Firefox integration, and leak coverage described below |
| documentation | Installation, HTTPS proxying, private-HTTP CIDRs, pairing, use, update, revoke, privacy, troubleshooting, and security-reporting guidance |

## Acceptance criteria

- An authenticated desktop user can install the bundled Mozilla-signed XPI
  from VDL after Firefox's own confirmation; no AMO public listing is required.
- The same XPI installs and operates on supported Firefox versions on Linux,
  macOS, and Windows.
- The VDL page cannot silently configure the extension. Copying one pairing
  string and confirming the displayed exact origin pairs it once.
- Loopback HTTP pairs by default. Private or shared IPv4 HTTP pairs only for an
  operator-configured CIDR; public and non-allowlisted HTTP cannot pair or
  receive cookies.
- The extension has no permanent all-sites grant. The first action on a host
  triggers Firefox's host-permission prompt; later actions on that host are
  one click.
- A click reads only cookies applicable to the active URL from that tab's
  `cookieStoreId`. Two Containers signed in as different accounts never mix
  their cookies.
- Private, partitioned, and FPI cookies are not transmitted. Unsupported-only
  contexts receive a clear local error.
- The extension does not store website cookies, page URLs, request bodies, or
  download IDs. It stores only the exact VDL origin, narrow token, device
  label, and minimal connection state in `storage.local`.
- Every accepted companion download is atomically owned by the paired user,
  private from its first visible event, marked browser-authenticated, and uses
  current server-side filename/format preferences.
- Repeated or ambiguous delivery of one `request_id` starts at most one worker.
  A second click for the same active URL returns the active row rather than
  creating a duplicate.
- A fresh click for the URL of the newest cancelled/interrupted authenticated
  row resumes that row with fresh cookies and reuses its partial file.
- Ordinary Continue refuses such a row and explains that fresh Firefox cookies
  are required.
- Cookie data exists only in the request/worker's process memory, survives the
  live probe/download/fallback/pause lifecycle, and is dropped on every
  terminal path. No cookie file appears anywhere in the filesystem.
- Refreshed cookies written by one yt-dlp context are visible to the next
  context through the same rewound stream.
- A restart marks a live job interrupted and cannot resume it until the
  extension sends a new snapshot.
- Pairing codes expire in five minutes, are single-use, replace previous codes,
  and are never persisted raw. The raw companion token is returned once and
  only its verifier is stored server-side.
- Revocation, password/session reset, suspension, and deletion reject the
  token on its next request. Browser sign-out alone leaves the explicitly
  paired connection active.
- Existing web/API CSRF and session boundaries remain unchanged. Only the
  documented companion routes accept extension-origin requests, and each
  independently authenticates a code or token.
- Cookies, tokens, codes, Authorization headers, and raw request bodies never
  appear in SQLite downloads, application/access logs, SSE, history JSON,
  errors, filenames, process arguments, or API responses.
- An extension package with a missing/mismatched checksum is not offered or
  served.
- The packaged extension passes `web-ext lint`, declares all three conservative
  data categories, contains no remote executable code, and has an accurate
  privacy disclosure.

## Verification

### Backend automation

Add unit/integration coverage for:

- pairing-code entropy shape, replacement, expiry, atomic single use, restart
  loss, generic failure response, and rate limiting;
- token parsing, HMAC verification, constant-time comparison, narrow scope,
  owner listing/revoke, self-revoke, throttled last-use update, session-version
  invalidation, suspension, and cascading user deletion;
- protocol/version headers, route-specific content limits, MIME enforcement,
  stable error codes, and body-field allowlists;
- extension Origin acceptance, ordinary web Origin rejection, omitted Origin,
  OPTIONS, PNA header handling, no credentialed CORS, and regressions for every
  existing same-origin mutation route;
- URL normalization, fragment removal, credential rejection, IDNA, length
  caps, and exact-origin comparisons including IPv4, IPv6, and non-default
  ports;
- every cookie field/type/size/control-character constraint, host-only and
  domain matching, IP literals, path matching, secure cookies, expiry,
  duplicates, zero cookies, 300 cookies, and oversized payloads;
- atomic private insert, owner snapshot, browser-auth marker, request-ID
  idempotency/conflict, same-owner URL deduplication, cross-owner isolation,
  exact-URL auto-resume, and normal-resume refusal;
- Netscape conversion including HttpOnly, host-only/domain, session expiry,
  empty values, and no tab/newline injection;
- the pinned yt-dlp's file-like load/save behavior, including the custom
  truncate/rewind semantics and refreshed-cookie continuity through probe,
  download, and literal format fallback;
- buffer closure on success, each exception, queued cancel, cancel while
  paused, and authentication failure, with a filesystem assertion proving no
  cookie jar was created;
- redaction canaries proving every cookie/token/code value and URL query is
  absent from DB fields, captured logs, exceptions, JSON, and SSE; and
- XPI MIME, no-store headers, public availability, fixed path, checksum
  enforcement, and missing-artifact behavior.

### Extension automation

Use mocked Firefox WebExtension APIs to cover:

- top-level listener registration for a non-persistent background page;
- pairing-string decode/validation, visible-origin confirmation, VDL host grant
  acceptance/denial, exact port pinning, redirect refusal, and enforcement of
  HTTPS/loopback/operator-allowlisted private/shared IPv4 transport policy;
- one-pairing storage, `storage.local` rather than sync, self-unpair cleanup,
  and absence of page/cookie data after every outcome;
- active-tab scheme checks, VDL-origin rejection, fragment stripping, exact
  site grant request, grant denial, and continued action after a first grant;
- correct `cookieStoreId` use, Container isolation, unpartitioned/FPI filtering,
  wire projection, and no unrelated-cookie aggregation;
- request ID reuse on a single retry, timeouts, response-size limits, badge and
  action-title state, 401 re-pair guidance, 426 update guidance, and all
  actionable failures;
- manifest permissions, fixed ID, minimum Firefox, incognito exclusion, data
  declarations, lack of update URL, and lack of forbidden capabilities; and
- `web-ext lint` plus an archive audit for remote URLs/code and undeclared
  files.

### Browser, container, and release validation

- Extend the VDL browser suite for the Browser Extension section, insecure
  origin warning, pairing create/copy/invalidate, connection list/revoke,
  update comparison, keyboard behavior, live-region announcements, both
  themes, and 390 px layout.
- Extend container smoke coverage to verify the exact XPI bytes/checksum/MIME,
  public artifact with private management APIs, token-authenticated private
  creation, HTTPS proxy deployment instructions, and dependency version.
- Before release, test the signed XPI on current Firefox Release and a
  supported ESR on Linux, macOS, and Windows.
- Capture a real signed-extension network matrix for trusted public HTTPS,
  trusted LAN HTTPS, non-default ports, proxying, DNS failure, untrusted
  certificate, redirects, Origin/preflight/PNA, and permission revocation.
- Use a controlled fixture site with an HttpOnly session cookie to prove an
  authenticated yt-dlp request works. Repeat with two Firefox Containers
  holding distinct sessions.
- Test a rotating-cookie response, pause/unpause, cancel while paused,
  interrupted restart, and fresh-cookie resume against the real pinned yt-dlp.
- Submit the unlisted package with its privacy policy and reviewer instructions
  and obtain a valid Mozilla signature before marking the feature releasable.

Run the repository suites with the project's existing commands, plus the new
extension lint/unit and signed-Firefox integration commands documented in
`browser-extension/README.md`.

## Documentation requirements

- Add an operator guide for trusted HTTPS through a reverse proxy, including
  certificate trust on the Firefox machine and non-default ports, plus the
  explicit CIDR configuration and plaintext warning for private HTTP.
- Add a user guide for install, Firefox confirmation, copy/paste pairing,
  first-site permission, one-click use, update, revoke, session-expiry retry,
  Container behavior, and unsupported sites.
- Publish the extension privacy notice both inside the XPI and alongside the
  project. It must state exactly what is captured, the explicit action that
  triggers it, the user-selected destination, in-memory VDL lifetime, locally
  persistent token, URL persistence in VDL, and absence of analytics/sharing.
- Document manual updates and explain that the settings page cannot inspect an
  installed extension directly; it knows only the version last reported by an
  active connection.
- Update security-reporting guidance to forbid including real cookie values,
  bearer tokens, signed media URLs, or pairing strings in bug reports.

## Non-goals

- Asking for, storing, or replaying website usernames, passwords, passkeys, or
  multi-factor credentials.
- Embedding Chromium/Firefox, providing a VDL-hosted login window, or adding a
  broader browser automation subsystem to the container.
- Persisting website cookies or automatically recovering an authenticated job
  after a VDL restart without a fresh browser action.
- Supporting partitioned cookies, First-Party Isolation cookies, related
  identity-provider domains, localStorage, IndexedDB, custom headers,
  User-Agent cloning, client certificates, or browser-bound keys in v1.
- Firefox private windows, Firefox for Android/iOS, Chromium-based browsers,
  Safari, native messaging, or a native helper.
- Silent add-on installation, bypassing Firefox's confirmation, automatic
  install-to-pair transfer, or more than one paired VDL instance per Firefox
  profile.
- Automatic extension updates in v1. A stable central HTTPS update service may
  be specified later.
- Guaranteeing compatibility with every logged-in site, or bypassing DRM,
  paywalls, CAPTCHA, bot protection, geographic restrictions, or site access
  controls.
- Allowing companion tokens to browse the VDL library, retrieve media, alter
  settings, choose filesystem paths, or administer users.

## Research basis and release gates

The supporting primary-source research is recorded in
`research/firefox-vdl-cookie-bridge.md`. It establishes the signed-XPI,
installation, pairing, permission, cookie-store, transport, AMO policy, and
yt-dlp constraints behind this specification.

The following are validation gates, not undecided product behavior:

1. Confirm actual signed-Firefox Origin/preflight/PNA behavior and implement
   only the minimum compatible headers described above.
2. Confirm AMO accepts the conservative declarations
   `browsingActivity`, `websiteContent`, and `authenticationInfo`; do not remove
   a declaration merely to reduce install friction.
3. Obtain an unlisted Mozilla signature and verify the signed bytes against
   the reviewed source before bundling them.
4. Validate Mozilla review acceptance of the documented local/private HTTP
   exception before publishing a signed production package; keep public HTTP
   prohibited regardless of that outcome.
