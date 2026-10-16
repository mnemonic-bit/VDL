# VDL Companion

This directory is the reviewable source and release input for the Firefox 140+
Manifest V3 companion. It has no build-time JavaScript transformation and no
remote executable code.

## Development package

From the repository root:

```bash
npx --yes web-ext@latest lint --source-dir browser-extension/src
npx --yes web-ext@latest build --source-dir browser-extension/src \
  --artifacts-dir browser-extension/dist --overwrite-dest
```

Temporary installation through `about:debugging` is suitable only for local
development. The production artifact must be signed as an unlisted add-on by
Mozilla. Do not put AMO credentials, signing keys, or the signing command in a
container build.

## Release process

1. Increment `manifest.json`'s version for every behavior change.
2. Run `web-ext lint` and the extension tests.
3. Sign the source as an unlisted extension through AMO, keeping the immutable
   add-on ID `{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}`. In the
   [AMO Developer Hub](https://addons.mozilla.org/en-US/developers/), choose
   **Submit a New Add-on → On your own**, upload a ZIP built from `src/`, and
   download the signed XPI from **My Add-ons** after Mozilla approves it.
4. Rename the returned signed file to `vdl-companion-firefox.xpi`.
5. Audit the archive against `src/`, ignoring only Mozilla signature metadata
   under `META-INF/`, then generate the checksum:

   ```bash
   cd browser-extension/dist
   sha256sum vdl-companion-firefox.xpi > vdl-companion-firefox.xpi.sha256
   ```

   From the repository root, run
   `python scripts/verify_companion_xpi.py --require-signed` to check the
   checksum, every archived source byte, and signature metadata before release.
   The normal validation workflow runs this audit without `--require-signed`
   so development packages remain testable.

6. Test the signed XPI on supported Firefox Release and ESR builds. Capture
   Origin, preflight, Private/Local Network Access, trusted-certificate,
   redirect, Container, rotating-cookie, pause, cancellation, and fresh-resume
   behavior before release.

The checked-in artifact is an unsigned development package. It is the exact
input served by VDL and copied into development containers, and the Docker
build fails if its checksum is missing or mismatched. The publication workflow
rejects a new release until that file is replaced by Mozilla's signed artifact,
the checksum is regenerated, and the source-byte audit passes. Firefox must
still validate the signature during release testing.

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
