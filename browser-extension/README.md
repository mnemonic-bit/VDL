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

Temporary installation through `about:debugging` is suitable only for local
development. The production artifact must be signed as an unlisted add-on by
Mozilla. Do not put AMO credentials, signing keys, or the signing command in a
container build.

## Release process

Every packaged-source change must increment `manifest.json`'s version and the
matching `COMPANION_PACKAGE_VERSION` in `vdl.py`. The add-on ID remains fixed.
The pull-request gate uses the lockfile-pinned `web-ext` to lint and build the
source, then checks the development XPI and version contract without AMO
credentials.

After `main` validation, the protected `amo-signing` job resolves that exact
ID/version. It submits an absent version once as unlisted, or downloads an
already approved version. A pending review blocks publication; rerun the failed
workflow after AMO approves it. The signed XPI is checked against AMO's SHA-256,
the manifest, and every source byte outside `META-INF/`. Only the verified
artifact is handed to the image publisher. The source invariant is intentionally
strict: if Mozilla changes another file during signing, investigate and document
that transformation before changing the verifier.

Maintainers configure `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` as secrets in the
branch-restricted `amo-signing` GitHub environment. Create or rotate those
credentials in the [AMO Developer Hub](https://addons.mozilla.org/en-US/developers/)
and never add them to the repository or Docker build. The first live submission
must confirm that the AMO account owns the fixed ID and that Mozilla accepts
the source-equivalence rule. Test the resulting XPI in supported Firefox builds.

The checked-in artifact is an unsigned development package. Local containers
serve it for testing. Published images receive the verified signed artifact in
the release workspace; no signed binary or AMO credential needs to be committed.
Firefox still validates the signature when installing. Updates remain manual:
install the newer XPI from VDL Settings after upgrading the container.

## Pairing and troubleshooting

VDL should be opened through an HTTPS origin whose certificate Firefox trusts.
Loopback HTTP is accepted for local development, and an operator may explicitly
enable an RFC1918 private or RFC6598 shared IPv4 CIDR with
`VDL_COMPANION_HTTP_CIDRS`. Local HTTP is unencrypted and must be limited to a
trusted network; public HTTP and HTTP hostnames remain rejected. Install the XPI from Settings, accept Firefox's Add
prompt, create a five-minute pairing string in VDL, and paste it into the
onboarding page. On the first use for a website host, Firefox asks for access
to that host. Firefox Containers remain isolated because each action reads the
clicked tab's cookie store.

If a site reports an expired session, revisit the source page while signed in
and click the toolbar action again. Partitioned/FPI cookies, related login
domains, local storage, browser-bound credentials, CAPTCHA, bot protection,
and DRM are not supported. Updates are manual: install the newer bundled XPI;
the fixed add-on ID updates the existing installation.
