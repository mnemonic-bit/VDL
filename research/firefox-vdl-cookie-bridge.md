# Firefox companion extension for authenticated VDL downloads

**Research status:** source-checked 2026-10-01  
**Scope:** external constraints and design guidance for a Firefox extension that sends the active page URL and a narrowly selected set of browser cookies to a user-configured VDL instance. This is a research note, not the feature specification.

## Reading key

- **Verified** means the statement is supported by the linked primary source.
- **Recommendation** is a proposed VDL design derived from those facts.
- **Unresolved** means implementation or policy validation is still required before release.

## Executive findings

1. **Verified:** A signed, unlisted XPI can be bundled in the VDL image and installed from a link served by VDL on desktop Firefox. Release and Beta Firefox still require Mozilla signing; self-distribution does not avoid AMO validation or policy review. The XPI response must use `Content-Type: application/x-xpinstall`, and Firefox always retains its own user confirmation step. [Mozilla signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) · [Mozilla self-distribution guide](https://extensionworkshop.com/documentation/publish/self-distribution/)
2. **Verified:** Firefox web pages cannot call an extension through `runtime.sendMessage()` or `runtime.connect()`, even with `externally_connectable`. Therefore the VDL page cannot silently transfer its origin or a pairing secret into a newly installed generic XPI. Installation can be one click plus Firefox's **Add** confirmation, but pairing needs a separate, explicit extension-controlled step. [MDN `externally_connectable`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable)
3. **Recommendation:** Scope v1 to desktop Firefox 140 or later, Manifest V3, normal (non-private) windows, and a toolbar action. Use required permissions `activeTab`, `cookies`, and `storage`; declare broad *optional* host capability but grant only the current website host and paired VDL host at runtime. Do not request persistent `<all_urls>`, `tabs`, content-script, scripting, history, or web-request access.
4. **Verified:** Cookie access requires both the `cookies` API permission and a matching host permission. Firefox Containers, private windows, dynamic partitioning, and First-Party Isolation create distinct cookie contexts; reading an undifferentiated global jar is incorrect. [MDN Cookies API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies) · [MDN cookie stores](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_the_Cookies_API)
5. **Recommendation:** Transmit structured JSON cookies, not a browser-generated Netscape file. VDL should validate the structure and create a private per-download Netscape jar for yt-dlp. This keeps delimiter handling and scoping decisions on the trusted backend, although conversion remains lossy for SameSite, partition keys, First-Party Isolation, and browser-store identity.
6. **Verified:** yt-dlp's Python API accepts `cookiefile` as a filename **or text stream**, loads it into a global `YoutubeDLCookieJar`, and writes the possibly updated jar back when `YoutubeDL.close()` runs. The file format is the seven-field Netscape/Mozilla format. [`YoutubeDL` parameter documentation in source](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py#L354-L357) · [`load_cookies`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py#L93-L113) · [`YoutubeDLCookieJar`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py#L1276-L1394) · [`save_cookies`/`close`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py#L1053-L1065)
7. **Recommendation:** Cookies should be ephemeral per download. Keep the in-memory jar through probe, download, format fallback, and a live pause; close and discard it on finish, error, or cancel. A crash or later resume cannot authenticate without a new browser transfer unless VDL deliberately adds encrypted persistence.
8. **Verified:** Mozilla treats URLs and cookies sent outside the extension as personal-data transmission. Cookies do not qualify for the policy's implicit single-use consent exception. New submissions after 2025-11-03 must declare data collection in the manifest. [Mozilla data taxonomy and built-in consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) · [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)

## 1. Packaging, signing, installation, and updates

### Signed and unlisted self-distribution

**Verified:** Packaged Firefox extensions are XPI files, which are ZIP archives with a different extension; the extension files, including `manifest.json`, are at the archive root. Mozilla recommends `web-ext build`. [Packaging guide](https://extensionworkshop.com/documentation/publish/package-your-extension/)

**Verified:** Release and Beta Firefox require Mozilla signing. The developer may choose **On your own** / unlisted distribution, or sign with `web-ext sign --channel=unlisted`; the resulting XPI is not publicly installable from AMO and is distributed by the developer. Automated validation always applies, a manual review can occur before or after signing, and signing can take up to 24 hours or longer when selected for manual review. [Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/) · [`web-ext` guide](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)

**Verified:** A desktop web install may be initiated by a normal XPI link or JavaScript directly handling a user click. The server must respond with `Content-Type: application/x-xpinstall`. If the trigger is framed, every frame between it and the top-level page must be same-origin; `InstallTrigger` is unsupported and was removed in Firefox 144. Firefox then displays its normal add-on confirmation. [Self-distribution guide](https://extensionworkshop.com/documentation/publish/self-distribution/)

**Recommendation:** The container may serve one immutable, Mozilla-signed artifact, for example `/firefox/vdl-companion-1.0.0.xpi`, with the required MIME type. Keep AMO credentials and signing out of the image and image build. Publish the artifact's SHA-256 in release metadata so maintainers can verify that the bundled bytes are the reviewed bytes.

**Verified:** Temporary development installation through `about:debugging` lasts only until Firefox restarts and does not reproduce normal install-time permission prompts. It is appropriate for development, not user distribution. [Temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

### Fixed ID and update channel

**Verified:** A Manifest V3 extension requires a fixed `browser_specific_settings.gecko.id` to be signed. The ID also identifies extension-owned storage and update lineage. [MDN `browser_specific_settings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) · [Mozilla add-on ID guide](https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/)

**Verified:** A self-hosted automatic-update channel requires a fixed HTTPS `browser_specific_settings.gecko.update_url`. Its JSON update manifest is keyed by extension ID. Firefox only installs a higher extension version; an `update_link` must be HTTPS or be accompanied by a SHA-256/SHA-512 `update_hash`. Existing installations continue using the old `update_url`, so losing that URL prevents them from discovering a replacement. [Updating an extension](https://extensionworkshop.com/documentation/manage/updating-your-extension/)

**Verified:** If no custom `update_url` is present, a self-installed copy checks AMO for a higher **listed** version. An extension kept exclusively unlisted otherwise needs another self-distribution mechanism for updates. [Self-distribution guide](https://extensionworkshop.com/documentation/publish/self-distribution/)

**Recommendation:** Do not point `update_url` at the installing VDL container: the URL is embedded in the signed, generic XPI and cannot vary by installation. Use a stable project-controlled HTTPS origin, or explicitly make updates manual. Continue bundling a current XPI in each VDL image so new users get the current version.

### Pairing cannot be folded into the install click

**Verified:** Firefox does not implement web-page-to-extension `runtime.sendMessage()` or `runtime.connect()`; `externally_connectable.matches` therefore cannot make the installing VDL page configure the extension. [MDN `externally_connectable`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable)

**Recommendation:** Use this onboarding:

1. The authenticated VDL page creates a single-use pairing code and continues to display it after the user clicks **Install Firefox companion**.
2. On `runtime.onInstalled`, the extension opens its packaged onboarding page.
3. The user enters the VDL base URL and pairing code, then clicks **Pair**. That click is the user action used to request host permission for the VDL host.
4. The extension exchanges the single-use code for a narrowly scoped, revocable companion token and stores the VDL origin plus token locally.
5. The options page exposes **Unpair**, which deletes local state and calls server-side revocation when reachable.

This is a one-time extra pairing step, not an every-download step. An all-sites content script whose purpose is to discover a VDL page and pull a token would materially increase privilege and attack surface and is not recommended.

## 2. Platform support

**Verified:** A pure WebExtension consists of platform-neutral packaged web resources, and an XPI is a ZIP-format package. There is no per-OS native binary in the proposed design. [Packaging guide](https://extensionworkshop.com/documentation/publish/package-your-extension/) · [MDN WebExtensions overview](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/What_are_WebExtensions)

**Recommendation:** One signed XPI should be the release artifact for desktop Firefox on Linux, macOS, and Windows. Test all three because networking, certificate trust, proxies, DNS, and Firefox policy configuration differ even though the package does not.

**Verified:** Desktop-style web installation does not work on Firefox for Android. A self-distributed XPI is downloaded and must be installed through Android's **Install Extension from File** flow. [Installing self-distributed extensions](https://extensionworkshop.com/documentation/publish/install-self-distributed/) A manifest is desktop-only unless it opts into Android with `browser_specific_settings.gecko_android`; Android also has UI differences around extension popups and active tabs. [MDN `browser_specific_settings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) · [MDN `tabs.Tab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab)

**Verified:** Desktop/Android Firefox add-ons are unavailable in Firefox for iOS; Apple's extension system is incompatible. [Mozilla Support: Firefox for iOS add-ons](https://support.mozilla.org/en-US/kb/add-ons-firefox-ios)

**Recommendation:** Declare v1 desktop-only. Android needs a separate UX, installation, permission, background-lifecycle, and network test effort. iOS is out of scope.

## 3. Manifest and API baseline

### Manifest version and Firefox minimum

**Verified:** Firefox supports Manifest V3. In Firefox, MV3 background work runs as a non-persistent event page through `background.scripts`; Firefox does not support Chrome's `background.service_worker`. Event listeners must be registered synchronously at top level, and persistent state belongs in the Storage API. [MDN `background`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background) · [MDN background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)

**Recommendation:** Use Manifest V3 with `action` and `background.scripts`. Set `strict_min_version` to `140.0`: Firefox's built-in data-transmission consent starts at desktop 140, and choosing that floor avoids maintaining a second custom consent flow for older releases. [Built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)

### Minimum permissions

**Recommendation:** Start with:

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "cookies", "storage"],
  "optional_host_permissions": ["*://*/*"],
  "incognito": "not_allowed",
  "background": { "scripts": ["background.js"] },
  "action": { "default_title": "Download current page with VDL" },
  "browser_specific_settings": {
    "gecko": {
      "id": "vdl-companion@example.invalid",
      "strict_min_version": "140.0",
      "update_url": "https://stable-project-origin.example/vdl-firefox-updates.json",
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

The IDs and URLs above are placeholders.

**Verified:** `activeTab` makes the active tab's URL/title available after a toolbar, context-menu, or shortcut action without permanent `tabs` access. It does **not** document Cookies API access. Cookies still require `cookies` plus a matching host permission. [MDN permissions and `activeTab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions) · [MDN Cookies API permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies)

**Verified:** MV3 `optional_host_permissions` declares hosts that may be requested later. `permissions.request()` must run in an extension user-action handler, and the requested origin can be narrower than the manifest's optional pattern. Users can revoke optional grants in Add-ons Manager. [MDN optional permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_permissions) · [MDN `permissions.request()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/permissions/request)

**Recommendation:** `*://*/*` is acceptable only as an ungranted capability ceiling. On a download click, request the active website hostname only; during pairing, request the VDL hostname only. Never proactively grant all sites. Do not add `tabs`, `scripting`, `content_scripts`, `webRequest`, `history`, `downloads`, or `<all_urls>` unless a later requirement proves them necessary.

**Verified:** Firefox match patterns do not include ports, so a host grant cannot be restricted to `:5000`; it applies to matching URLs on that host independently of port. [MDN match patterns](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns)

**Recommendation:** Even though browser permission is host-wide, extension application logic must pin network requests to the exact paired tuple `(scheme, normalized hostname, effective port)`, reject credentials/fragments in configured URLs, and never follow an API redirect to a different origin.

**Verified:** With `incognito: "not_allowed"`, private tabs are invisible to the extension. Mozilla policy also says private-browsing data must not be stored. [MDN `incognito`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/incognito) · [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)

## 4. Correct cookie selection

### Browser store and Containers

**Verified:** Firefox has normal, private, and per-Container cookie stores. `tabs.Tab.cookieStoreId` identifies the active tab's store, and `cookies.getAll({storeId: ...})` can restrict retrieval to it. [MDN cookie stores](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Work_with_the_Cookies_API) · [MDN `tabs.Tab`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab)

**Recommendation:** Always use the tab received by the toolbar user action and its `cookieStoreId`. Never aggregate cookies from every store. Do not ask for `contextualIdentities`; VDL does not need the Container's name or management access. The server does not need to receive `storeId` at all.

### Host permission and selection scope

**Verified:** `cookies.getAll({url})` returns unexpired cookies associated with the supplied URL. A host permission such as `https://www.example.com/*` can expose cookies for that host and parent-domain cookies, but not arbitrary sibling/subdomains. Wildcard-subdomain patterns expand that reach. [MDN `cookies.getAll()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/getAll) · [MDN Cookies API permission examples](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies)

**Recommendation:** The safest v1 default is cookies that Firefox associates with the active HTTP(S) page URL, from the active tab's store, after runtime permission for that host. This deliberately avoids exporting a browser-wide jar. It can miss a cookie scoped to another path, sibling host, or identity provider; handle that as a visible site-specific limitation rather than silently requesting all-site access.

### Partitioning and First-Party Isolation

**Verified:** `cookies.getAll()` defaults to unpartitioned storage. Supplying `partitionKey: {}` includes partitioned and unpartitioned cookies; supplying `partitionKey.topLevelSite` restricts it to a partition. With First-Party Isolation enabled, callers may need `firstPartyDomain`; `null` includes all first-party-domain values. [MDN cookie partitioning/FPI](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies) · [MDN `cookies.getAll()` parameters](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/getAll)

**Recommendation:** Do not flatten cookies from every partition. For v1 either:

- support only unpartitioned cookies and return a clear unsupported-partition message when that is insufficient; or
- include only unpartitioned cookies plus the partition whose top-level site matches the active tab, and only FPI cookies matching the active tab's first-party domain.

Deriving and normalizing the schemeful top-level site correctly requires eTLD+1 knowledge; string-splitting hostnames is wrong for public suffixes such as `co.uk`. If implementing the second option, use Firefox's Public Suffix API or an audited PSL implementation and add only its necessary permission.

### Fields and semantics

**Verified:** A `cookies.Cookie` contains `name`, `value`, `domain`, `hostOnly`, `path`, `secure`, `httpOnly`, `sameSite`, `session`, optional `expirationDate`, `storeId`, and Firefox partition/FPI metadata. [MDN `cookies.Cookie`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/Cookie)

The following mapping is recommended:

| Firefox field | Wire field | yt-dlp/Netscape mapping | Notes |
|---|---|---|---|
| `name`, `value` | strings | fields 6 and 7 | Validate types/lengths; structured JSON avoids tab/newline injection before backend conversion. |
| `domain`, `hostOnly` | `domain`, `host_only` | host-only domain with include-subdomains `FALSE`; prefix domain with `.` and use `TRUE` only for a domain cookie | Preserve host-only behavior; do not infer it from a leading dot. |
| `path` | string | field 3 | Must begin with `/`. |
| `secure` | boolean | field 4 | Secure cookies must not be used for plain-HTTP target URLs. |
| `expirationDate`, `session` | number or `null` | epoch seconds; `0` for a session cookie | yt-dlp explicitly converts `expires=0` back into a session cookie on load. |
| `httpOnly` | boolean | optionally `#HttpOnly_` prefix | yt-dlp recognizes and strips the prefix. HttpOnly restricts page JavaScript, not HTTP sending; Cookies API access is privileged. |
| `sameSite` | enum | not representable | Python's Netscape jar does not retain browser SameSite enforcement. |
| `partitionKey`, `firstPartyDomain` | structured metadata | not representable | Use only to decide whether a cookie is eligible; do not combine unrelated partitions. |
| `storeId` | local selection only | not representable | Do not send it to VDL. |

**Recommendation:** Send a versioned object rather than a text cookie file:

```json
{
  "schema": 1,
  "page_url": "https://video.example/watch/123",
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
      "same_site": "lax",
      "expires": null,
      "partition_key": null,
      "first_party_domain": ""
    }
  ]
}
```

VDL should allowlist fields; cap body bytes, cookie count, and individual string lengths; reject control characters, invalid domain/path combinations, expired cookies, duplicate ambiguous records, and a `page_url` that is not HTTP(S). Cookies and request bodies must never enter application logs, SSE payloads, error strings, analytics, or database columns.

## 5. Network path and pairing security

### Extension-to-VDL fetch

**Verified:** An extension background page can make XHR/fetch requests to destinations for which it has host permission. MV3 content-script requests instead run under page CORS rules, so privileged VDL requests belong in the background/extension page, not a content script. [MDN background cross-origin access](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts) · [MDN content-script fetch behavior](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)

**Recommendation:** All companion calls should use background `fetch()` with:

- `credentials: "omit"` so the extension never relies on or accidentally attaches the user's VDL browser session;
- `cache: "no-store"`;
- a bearer companion token in `Authorization`, never a URL/query parameter;
- a hard redirect policy (`redirect: "error"`);
- HTTPS except for a separately resolved loopback policy;
- explicit timeouts and bounded response bodies.

The companion routes must authenticate only their pairing code or bearer token. They should be narrowly exempted from VDL's ordinary browser-session requirement and same-origin mutation check; ordinary VDL API routes should remain unchanged. Do not add general permissive CORS to the application.

**Unresolved:** Firefox host permission bypasses normal cross-origin response restrictions for extension pages, but exact `Origin`, Fetch Metadata, preflight, and redirect behavior must be captured in an integration test against the chosen Firefox minimum. VDL's existing mutation guard rejects non-HTTP origins, so a `moz-extension://...` `Origin` would currently receive 403. Do not assume an Origin header is absent.

**Verified:** Emerging Private/Local Network Access models can add a preflight or user permission when a public context reaches a private or loopback address. The incubating PNA model uses `Access-Control-Request-Private-Network: true`; current browser behavior is not uniform. [WICG PNA explainer](https://github.com/WICG/private-network-access/blob/main/explainer.md) · [MDN Local Network Access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access)

**Unresolved:** Test a signed XPI with VDL at `127.0.0.1`, `localhost`, a LAN IP, a `.local` hostname, and a public HTTPS hostname. Treat OPTIONS/PNA handling as compatibility work, not as authentication.

### Transport security

**Verified:** Mozilla policy requires sensitive data transmission to be encrypted and purpose-limited. Cookies are personal website content. [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)

**Recommendation:** Require trusted HTTPS for remote and LAN VDL instances. Plain HTTP would expose both the VDL bearer token and website bearer cookies to the network. A loopback-only HTTP exception may be technically useful for a browser and container on the same machine, but Mozilla's published policy does not state a clear exception.

**Unresolved:** Ask AMO reviewers whether an explicitly loopback-only (`localhost`, `127.0.0.0/8`, `::1`) HTTP mode is acceptable. Until confirmed, the release behavior should default-deny it rather than silently weakening transport.

### Pairing token design

**Recommendation:** Pairing should use two credentials:

1. A server-created, random, single-use code with at least 128 bits of entropy, a short TTL (for example five minutes), and ownership bound to the VDL user who created it. Store only a keyed hash/server-side verifier, not the plaintext code.
2. A random per-pair bearer token returned exactly once. Store its verifier server-side, record owner, creation/last-use timestamps and a human-readable device label, and expose revoke/rotate controls. Scope it only to the companion download endpoint and pairing status/revocation—not history reads, preferences, administration, file streaming, or arbitrary VDL API access.

Rate-limit code exchange and token use; make code consumption atomic; do not reveal whether an invalid code ever existed; revoke all a user's tokens when that user is suspended or their security/session generation is reset.

**Verified:** `storage.local` persists on the device but is not encrypted, and MDN says it should not hold confidential information. `storage.session` is in-memory and disappears with the browser/extension session. [MDN Storage API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage)

**Recommendation:** A persistent pairing token in `storage.local` is a conscious residual risk required for restart-persistent one-click use. Reduce its value with narrow scope and easy revocation; never store website cookies. Do not use `storage.sync`, which would copy the token across devices. A session-only option can be offered for users who prefer re-pairing after browser restart. A non-extractable signing key could improve the design, but key persistence, backup, and server challenge protocol need a separate threat-modelled design.

## 6. yt-dlp integration

### What the Python API actually accepts

**Verified:** yt-dlp's CLI `--cookies FILE` means “Netscape formatted file to read cookies from and dump cookie jar in.” The corresponding Python option is `cookiefile`. [`options.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/options.py) · [`YoutubeDL.py` parameters](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py#L354-L357)

**Verified:** `load_cookies(cookie_file, browser_specification, ydl)` creates a `YoutubeDLCookieJar`, loads an existing readable file or text stream, and merges it with browser-derived jars if configured. [`cookies.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py#L93-L113)

**Verified:** `YoutubeDLCookieJar` reads and writes the seven-column Netscape format, supports the conventional `#HttpOnly_` prefix, treats blank/zero expiry as a session cookie, and accepts a file-like object as well as a filesystem path. [`YoutubeDLCookieJar` source](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py#L1276-L1394)

**Verified:** `YoutubeDL.close()` calls `save_cookies()` when `cookiefile` is configured. This matters because sites can refresh cookies during the probe/download. [`YoutubeDL.close`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py#L1053-L1065)

### Recommended bridge

**Recommendation:** On companion submission, VDL should:

1. validate the JSON cookie bundle;
2. convert only eligible cookies to Netscape format in a dedicated, seekable in-memory text stream;
3. rewind and pass the same stream as `cookiefile` to every `YoutubeDL` context for that job: initial metadata probe, selected-format download, format-unavailable fallback, and final/re-probe work;
4. allow yt-dlp to save refreshed cookies back to that stream;
5. close the stream and drop the structured input references on every terminal path.

`YoutubeDLCookieJar.open()` yields a supplied file-like object directly rather than opening a path, so a named temporary file is unnecessary. VDL does create multiple `YoutubeDL` contexts and yt-dlp writes updates on close; the stream therefore needs explicit rewinding before each context and a small wrapper whose clear/truncate operation also returns the cursor to offset zero. A regression test against the pinned yt-dlp version should lock down those file-like load/save semantics. The stream must be injected only after VDL's deployment-option helper performs its deep copy, so the secret-bearing object is neither copied nor split into multiple jar lifecycles.

**Verified:** yt-dlp's FAQ requires Netscape format for manually supplied files and warns that `--cookies-from-browser` plus `--cookies` exports cookies for **all** sites. The companion's narrow structured selection is therefore intentionally different from yt-dlp's full browser import. [yt-dlp cookie FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)

**Security requirement:** yt-dlp published a cookie-leak advisory affecting its curl external downloader before version `2026.06.09`; redirects or differing fragment hosts could receive improperly scoped cookies. Require yt-dlp `>=2026.06.09`, or conclusively demonstrate that VDL cannot enter the affected curl path. [yt-dlp GHSA-f7j3-774f-rfhj](https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-f7j3-774f-rfhj)

## 7. Redirects, additional domains, and unavoidable failures

**Verified:** Cookies are domain/path/secure scoped, and the extension can access cookies only for granted hosts. A login session may involve parent-domain cookies, host-only cookies on sibling identity domains, redirects, or partitioned third-party cookies. [MDN Cookies API permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies) · [HTTP `Set-Cookie` semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)

**Recommendation:** Do not promise “works for every logged-in page.” Use progressive handling:

- First attempt: active page URL plus cookies applicable to that URL.
- If yt-dlp reports login/auth failure, tell the user that the site may use another login domain or an unsupported partition; do not automatically broaden permissions.
- A later advanced UI may let the user explicitly add named related domains, requesting each at runtime and showing exactly which domains will be read.
- Never follow an arbitrary webpage-provided list of cookie domains without a fresh extension user action and permission prompt.

**Verified:** yt-dlp notes that some media URLs require the same IP, cookies, and/or HTTP headers, and sometimes the browser's User-Agent. Cookies alone are not a universal session clone. [yt-dlp FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)

**Unavoidable site-specific failures:** short-lived or rotating sessions, device/IP binding, anti-bot challenges, CAPTCHA, additional request headers, extractor-specific authentication behavior, Proof-of-Origin/token systems, and DRM can all defeat a cookie transfer. YouTube in particular documents cookie rotation and a special fresh-session export procedure. [yt-dlp extractor notes](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)

## 8. Pause, cancel, resume, expiry, and crash recovery

**Recommendation:** Lifecycle semantics should be explicit:

| VDL event | Cookie-jar behavior |
|---|---|
| Probe → download → fallback/re-probe | Reuse the same per-job jar so updates made by one yt-dlp context are available to the next. |
| Pause/unpause | Keep the jar while the worker remains alive. A long pause may outlast session validity. |
| Finish/error/cancel | Close and discard the in-memory jar in a `finally` path. Cancel must wake a paused worker before cleanup. |
| Process crash/restart | Process memory is lost; recovered jobs are `interrupted` but unauthenticated. |
| Resume of `cancelled`/`interrupted` | Require a fresh **Resume with Firefox** transfer, or create a new job that can reuse the `.part` media file. Ordinary resume without fresh cookies should explain why authentication is absent. |

Cookies captured once are a snapshot. The extension does not continuously synchronize browser cookie rotation. Server responses received by yt-dlp may update its job jar, but later browser-only changes do not. Expiry should therefore become a normal actionable error: “Session expired or was rotated; open the page while signed in and click Download with VDL again.”

Persisting cookies would enable automatic crash recovery but changes the security and privacy contract substantially. If later required, it needs encryption at rest with a key not stored beside ciphertext, per-user isolation, retention controls, rotation/revocation, migration, backup policy, and an explicit UI disclosure. It is out of scope for the ephemeral v1.

## 9. Mozilla policy and privacy requirements

**Verified:** Add-ons must be self-contained and must not load remote code for execution. Data transmission must be necessary to the primary function, disclosed, and user-controlled; browsing activity may be transmitted only as part of the primary function. Cookies are explicitly excluded from the implicit-consent exception. [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)

**Recommendation:** Bundle all JavaScript/CSS/HTML in the XPI. Do not use remote scripts, `eval`, analytics, telemetry, crash reporting, ad SDKs, or third-party CDNs. Network only to the user-paired VDL instance and stable update infrastructure handled by Firefox.

**Verified:** Firefox's data taxonomy classifies URLs/domains as `browsingActivity` and cookies as `websiteContent`; authentication data is a separate category. New AMO submissions must declare collection/transmission categories, and a privacy policy is required when data leaves the browser. [Built-in data consent taxonomy](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) · [Submitting an add-on](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)

**Recommendation:** Conservatively declare required `browsingActivity`, `websiteContent`, and `authenticationInfo`. The install disclosure and privacy policy should say, in plain language:

- only on the user's explicit toolbar action, the current page URL and selected cookies for that site are sent;
- the destination is the user's configured VDL server, not the extension developer;
- cookies can grant account access and are used only to attempt the requested download;
- the extension does not store website cookies;
- VDL keeps an in-memory jar only for the job and closes/discards it on terminal completion;
- pairing tokens persist locally until unpaired and are revocable in VDL;
- there is no analytics, advertising, sharing, or sale.

**Unresolved:** Confirm with AMO reviewer notes whether session cookies should be declared as both `websiteContent` and `authenticationInfo`. Mozilla explicitly puts cookies under `websiteContent`, while authentication cookies function as bearer authentication. Over-disclosure is safer than omitting a category, but reviewers should decide the final manifest classification.

## 10. Required validation before implementation is considered releasable

1. **Signed-XPI install matrix:** current Firefox Release and ESR where version is at least 140, on Linux/macOS/Windows; top-level link; correct MIME; logged-in VDL page; Firefox confirmation.
2. **Permission matrix:** grant, deny, revoke, and re-request website/VDL optional host permissions; non-default ports; ensure no request escapes the exact stored VDL origin.
3. **Cookie-store matrix:** default profile, at least two Firefox Containers logged into different accounts, FPI enabled, dynamic partitioning, and a rejected private-window attempt.
4. **Cookie semantics:** host-only versus domain cookie, secure cookie, HttpOnly, session and persistent expiry, duplicate name on different paths, parent-domain cookie, invalid/control-character payload, expired cookie, oversized bundle.
5. **Network matrix:** trusted public HTTPS, trusted LAN HTTPS, loopback; proxy; DNS failure; invalid/untrusted certificate; redirect; OPTIONS/CORS/Fetch Metadata/PNA headers recorded from a signed extension.
6. **VDL lifecycle:** probe success/failure, selected format, literal format-unavailable retry only, pause/unpause, cancel while paused, error cleanup, normal finish cleanup, crash loss, and resume requiring fresh cookies.
7. **Leak tests:** assert no cookie/token value appears in DB, Flask access/application logs, exception trace, SSE, history JSON, response body, filenames, or process command line.
8. **Revocation:** expired one-time code, replayed code, revoked token, suspended/deleted VDL user, password/session-generation reset, and token rate limiting.
9. **Site testing:** at least one simple same-domain login, one Firefox Container session, one redirect/identity-provider site, and one known rotating-cookie site. Record failures as extractor/site limitations rather than widening cookie access automatically.
10. **AMO preflight:** `web-ext lint`, privacy policy, reviewer test instructions and test account where lawful, data-category confirmation, remote-code audit, and a decision on loopback HTTP before submission.

## Unresolved decisions summary

- Whether v1 rejects all partitioned/FPI cookies or implements precise top-level-site selection using the Public Suffix List.
- Whether AMO accepts cleartext loopback transport; no official exception was found. LAN/remote HTTP must remain prohibited.
- Final AMO data category for authentication cookies (`websiteContent` alone versus also `authenticationInfo`).
- Manual versus stable central HTTPS automatic updates.
- Whether failed sites get an explicit additional-domain permission UI in v1 or only a documented limitation.
- Whether resume creates a fresh download row tied to an existing `.part`, or adds an authenticated resume endpoint to the existing row.
- Exact Firefox `Origin`, Fetch Metadata, CORS preflight, and PNA behavior against VDL; this needs a signed-extension integration capture.
- Whether User-Agent/header transfer is necessary for any initial supported site; adding it expands transmitted data and should be driven by a concrete verified failure.

## Primary-source index

- Mozilla Extension Workshop: [signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/), [self-distribution](https://extensionworkshop.com/documentation/publish/self-distribution/), [updates](https://extensionworkshop.com/documentation/manage/updating-your-extension/), [policies](https://extensionworkshop.com/documentation/publish/add-on-policies/), [built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
- MDN: [permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions), [Cookies API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies), [`cookies.getAll`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/getAll), [Storage API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage), [background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)
- yt-dlp: [cookie FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp), [`cookies.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py), [`YoutubeDL.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py), [cookie-leak advisory](https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-f7j3-774f-rfhj)

Source pages and current upstream `master` source were checked on 2026-10-01. Moving-source line anchors may drift; the linked symbol/file names are authoritative.
