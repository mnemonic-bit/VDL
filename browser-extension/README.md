# VDL Companion

This directory is the reviewable source and release input for the Firefox 140+
Manifest V3 companion. It has no build-time JavaScript transformation and no
remote executable code.

## Development package

From the repository root:

```bash
npm ci
npm run extension:lint
npm run extension:build -- --artifacts-dir /tmp/vdl-extension-build
python3 scripts/extension_release.py validate
```

Unsigned packages support temporary development/testing installation through
`about:debugging`. Normal Firefox installation requires a Mozilla-signed
unlisted package. Do not put AMO credentials, signing keys, or the signing command in a
container build.

## Release process

Every packaged-source change must increment `manifest.json`'s version and the
matching `COMPANION_PACKAGE_VERSION` in `vdl.py`. The add-on ID remains fixed.
The pull-request gate uses the lockfile-pinned `web-ext` to lint and build the
source, then checks the development XPI and version contract without AMO
credentials.

After `main` validation, the protected `amo-signing` job verifies the checked-in
unsigned package, then resolves the exact ID/version when both credentials are
available. It submits an absent version once as unlisted, or downloads an
already approved version. Existing pending versions are never resubmitted.

Signing is best effort by default: no AMO setup is needed for a first image
publication. Missing or incomplete credentials skip all AMO calls. Credential
or ownership failure, rate limiting, temporary service/network failure, pending
review, and transient signed-download failure select the verified unsigned
package. The workflow summary gives a sanitized explanation and next steps.
Rejection, failed validation, malformed metadata, TLS/unsafe transport,
checksum, signature, archive, source-content, artifact, tooling, and unknown
failures block publication.

The selected package is checked against the manifest, checksum and every source
byte outside `META-INF/`. Signed packages also require AMO's SHA-256 and signature
entries. The publisher independently verifies a schema-2, commit-bound artifact,
including its explicit signed/unsigned state. Both architectures test the same
selected bytes before publication. The source invariant is intentionally strict:
if Mozilla changes another file during signing, investigate before changing the
verifier. Firefox validates actual Mozilla signatures during installation;
synthetic test signatures cannot establish real Firefox installability.

For automatic signing, configure both `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in
the branch-restricted `amo-signing` GitHub environment. Create or rotate them in
the [AMO Developer Hub](https://addons.mozilla.org/en-US/developers/).
See [repository setup](../.github/REPOSITORY_SETTINGS.md). Credentials and
signing output must never enter logs, artifacts, the Docker build or runtime.
The first real submission must confirm account ownership and source equivalence.

The checked-in XPI stays unsigned. Publication stages exactly one verified
package in the release workspace. Later approval or credential setup does not
modify an image already published: create a new application release/commit to
bundle the now-approved exact version. Keep existing commit/version tags
immutable. Unchanged extension source needs no manifest-version bump solely
because Mozilla has signed it. Updates remain manual from VDL Settings.

## Install the bundled package

For a signed package, choose **Install Firefox extension** (or **Update Firefox
extension**) in Settings → Browser Extension and accept Firefox's confirmation.
Installation and pairing are separate.

For **Download unsigned XPI**, temporary loading is available for testing:

1. Download and extract the XPI into a local folder. If your archive tool needs
   it, rename the local copy from `.xpi` to `.zip` before extraction.
2. Open `about:debugging` in Firefox and choose **This Firefox**.
3. Choose **Load Temporary Add-on** and select the extracted `manifest.json`.
4. Open the VDL Companion toolbar action and use the pairing flow.

Temporary loading lasts only until Firefox restarts; repeat the loading steps
afterward. Downloading an unsigned XPI alone does not install it normally. A
compatible signed companion already installed can continue using its existing
connection even when the new server image bundles an unsigned package.
If Settings reports an integrity failure, contact the VDL operator.

See Mozilla's [temporary installation instructions](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)
and [signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/).
Manual release verification should cover normal installation of a real signed
XPI and temporary loading of unsigned source, including removal after restart.

## Pairing and troubleshooting

VDL should be opened through an HTTPS origin whose certificate Firefox trusts.
Loopback HTTP is accepted for local development, and an operator may explicitly
enable an RFC1918 private or RFC6598 shared IPv4 CIDR with
`VDL_COMPANION_HTTP_CIDRS`. Local HTTP is unencrypted and must be limited to a
trusted network; public HTTP and HTTP hostnames remain rejected. After loading
or installing the companion as described above, create a five-minute pairing
string in VDL and paste it into the onboarding page. On the first use for a website host, Firefox asks for access
to that host. Firefox Containers remain isolated because each action reads the
clicked tab's cookie store.

If a site reports an expired session, revisit the source page while signed in
and click the toolbar action again. Partitioned/FPI cookies, related login
domains, local storage, browser-bound credentials, CAPTCHA, bot protection,
and DRM are not supported. Updates are manual: install the newer bundled XPI;
the fixed add-on ID updates the existing installation.
