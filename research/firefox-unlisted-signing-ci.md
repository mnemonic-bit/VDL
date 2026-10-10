# Firefox unlisted signing in the VDL release pipeline

**Research status:** source-checked 2026-10-04  
**Scope:** whether Mozilla signing can be automated in GitHub Actions and how the resulting XPI should become the extension bundled in VDL's published container image. Only Mozilla, GitHub, and repository sources are used.

## Reading key

- **Verified** is a fact supported by an inline primary-source link.
- **Recommendation** is a proposed VDL implementation based on those facts.
- **Unresolved** needs a real AMO submission or maintainer decision before release.

## Answer

**Verified:** Yes. Current `web-ext sign` can submit an extension to AMO's `unlisted` channel and download the signed XPI for self-distribution. It accepts the AMO JWT issuer and secret through `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, and it uses AMO API v5 by default. Unlisted means the extension is not publicly viewable or installable from AMO; the developer distributes the returned XPI. [Mozilla `web-ext` command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/) · [Mozilla signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

**Recommendation:** Add a secret-bearing `sign-extension` job to `.github/workflows/main.yml`, after the existing reusable `validation` job and before `publish`. It should obtain or reuse the signed XPI, verify it, rename it to `browser-extension/dist/vdl-companion-firefox.xpi`, generate the existing `.sha256` file, and hand those two files to `publish` as a workflow artifact. The existing `Dockerfile` can then copy and checksum exactly those staged files before the multi-platform image is built. Do not put AMO credentials or AMO network calls in the Docker build.

This gives a seamless **end-user** path: pull the published image, open Preferences, click the extension link, and accept Firefox's normal installation prompt. It does not allow silent installation from an ordinary web page. Mozilla documents a normal top-level link or click handler and requires `Content-Type: application/x-xpinstall`; Firefox remains responsible for the install/permission UI. [Mozilla self-distribution guide](https://extensionworkshop.com/documentation/publish/self-distribution/)

## Facts that shape the design

### Signing, credentials, identity, and versions

**Verified:** Release and Beta Firefox require Mozilla-signed extensions even when the developer self-distributes them. All distribution methods remain subject to Mozilla's Add-on Policies and distribution agreement. [Mozilla signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

**Verified:** The supported high-level command is:

```bash
web-ext sign \
    --channel=unlisted \
    --source-dir=browser-extension/src \
    --artifacts-dir="$RUNNER_TEMP/amo-signed" \
    --no-input
```

For an unlisted submission, `web-ext` packages the source, submits it, and downloads a signed XPI. `--channel` is required; `unlisted` selects self-distribution. The documented environment variables are `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`. [Mozilla `web-ext sign` reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)

**Verified:** A maintainer must first create an AMO account and generate credentials on AMO's API Credentials Management page. The key is the JWT issuer and the secret signs short-lived API JWTs. Mozilla warns that the credentials can make API calls as that user and must never be committed or shared. Direct API clients use HS256 JWTs with `iss`, a high-probability-unique `jti`, UTC `iat`, and `exp` no more than five minutes after `iat`. [AMO external authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)

**Verified:** Manifest V3 requires a stable `browser_specific_settings.gecko.id` for signing, and AMO checks a supplied ID for uniqueness on first submission. VDL already declares `{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}`; that value must not change between versions. [MDN `browser_specific_settings`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings) · [Mozilla add-on ID guide](https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/)

**Verified:** Re-submitting an existing add-on/version is a conflict rather than an overwrite. AMO's submission API documents HTTP 409 for add-ons or versions that already exist, and the older signing endpoint likewise documents 409 for an existing version. [AMO API overview](https://mozilla.github.io/addons-server/topics/api/overview.html) · [AMO signing API](https://mozilla.github.io/addons-server/topics/api/v4_frozen/signing.html)

**Recommendation:** Treat `browser-extension/src/manifest.json`'s version (`1.0.3` at the time of this note) as the AMO release key. Increment it for every extension-content change, independently of root `VERSION`. The CI job must be idempotent: look up that ID/version first, download it when already approved, submit it only when absent, and reject an existing signed version whose non-signature contents do not match the current source.

### Source submission and reviewer information

**Verified:** Mozilla requires a separate readable source archive and reproducible build instructions when code was minified, bundled, generated, templated, or otherwise preprocessed. Matching source must accompany every affected version. Current `web-ext` supports `--upload-source-code=<archive>`. [Mozilla source-code submission guide](https://extensionworkshop.com/documentation/publish/source-code-submission/) · [Mozilla `web-ext` command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)

**Recommendation:** VDL's extension is plain, readable source with no build transformation, so a second source archive is not presently required by the documented rule. Keep it that way. Add `approval_notes` explaining how to pair with a test VDL instance, what URL/cookie data is transmitted, and how a reviewer can exercise the toolbar action. Mozilla says functional review may require testing information and, when an account is needed, test credentials. [Mozilla Add-on Policies, Submission Guidelines](https://extensionworkshop.com/documentation/publish/add-on-policies/)

### Validation, review, and asynchronous completion

**Verified:** Every submission receives automated validation before signing. Mozilla says signing can take up to 24 hours, or longer when selected for manual review, and unlisted add-ons can be manually reviewed after submission. [Mozilla signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

**Verified:** `web-ext` waits 15 minutes for approval by default via `--approval-timeout`; `--timeout` separately defaults to five minutes for a service response. Setting the approval timeout to zero disables waiting. [Mozilla `web-ext` command reference](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/)

**Verified:** A GitHub Actions job defaults to a maximum of 360 minutes. That is shorter than Mozilla's stated possible review time, so one continuously running `web-ext sign` invocation cannot guarantee completion. [GitHub workflow syntax: `timeout-minutes`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes)

**Verified:** AMO v5 supplies the state needed for an asynchronous client. `POST /api/v5/addons/upload/` returns an upload UUID; the upload-detail endpoint exposes `processed`, `valid`, and validation results. Version detail exposes `channel`, `file.status` (`public` means approved, `unreviewed` means awaiting review, and `disabled` covers rejected/disabled/not-reviewed), `file.url`, `file.hash`, and `file.is_mozilla_signed_extension`. Unlisted records require authentication as an author. [AMO Add-ons API v5](https://mozilla.github.io/addons-server/topics/api/addons)

**Recommendation:** Use a bounded wait, not a day-long runner:

1. Query AMO for the manifest ID/version.
2. If absent, invoke pinned `web-ext sign --channel=unlisted` with an approval timeout of roughly 15–30 minutes.
3. If `web-ext` times out after AMO accepted the upload, fail the signing gate without building or pushing an image. A later rerun first queries AMO and downloads the now-approved file instead of submitting the duplicate version.
4. If AMO says `unreviewed`, report the AMO state and fail cleanly. If `disabled` or validation failed, surface the validation/review result and require a new manifest version after correction. If approved and Mozilla-signed, download the file.

GitHub supports rerunning failed jobs using the same commit SHA, which makes this bounded retry safe when the lookup is idempotent. [GitHub rerun documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)

**Alternative recommendation:** If unattended completion after a long manual review is a hard requirement, use a second scheduled or manually dispatched poll/resume workflow. A single existing push-triggered run cannot wait reliably for a review that may exceed its job lifetime. This is a release-automation limitation, not an end-user installation limitation.

## Concrete workflow for this repository

### `.github/workflows/validation.yml`

Keep this reusable workflow deterministic and credential-free. It runs for pull requests, including untrusted fork code; GitHub does not pass Actions secrets to fork-triggered `pull_request` workflows. [GitHub secret types](https://docs.github.com/en/code-security/reference/secret-security/secret-types#actions-secrets)

**Recommendation:** Extend its existing Node setup and complete deterministic gate to check:

- `web-ext lint` against `browser-extension/src`;
- deterministic unsigned packaging from `src`;
- manifest ID remains the fixed VDL ID and version syntax is valid;
- the checked-in development XPI and source contain the same non-signature files, or replace that check with a generated unsigned package if the repository stops tracking the development XPI;
- extension-source changes also change the manifest version, using a repository test rather than contacting AMO.

Do not call AMO and do not expose AMO secrets here. Do not change this workflow to `pull_request_target` to obtain secrets: GitHub warns that privileged triggers combined with executing untrusted pull-request code create a repository-compromise path. [GitHub `pull_request_target` security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

### `.github/workflows/main.yml`

The current ordering is `validation` then `publish`; `publish` checks out the tested commit, builds and smoke-tests both image platforms, pushes commit/main/version tags, attests images, and creates a GitHub Release. Preserve that order and insert this job:

```text
validation
    -> sign-extension (contents: read; protected AMO environment)
        -> publish (download and verify signed-XPI artifact)
```

**Recommendation:** `sign-extension` should:

1. Declare `needs: validation`, `permissions: { contents: read }`, and a protected environment such as `amo-signing`. Restrict that environment to `main`; optionally require a reviewer. GitHub environment secrets are available only to jobs referencing the environment and remain unavailable until protection rules pass. [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
2. Check out the exact `GITHUB_SHA` with persisted credentials disabled, as the current workflow already does.
3. Use a pinned Node version and a lockfile-pinned `web-ext` version instead of `npx --yes web-ext@latest`. Continue pinning third-party Actions to full commit SHAs; GitHub calls a full-length commit SHA the only immutable Action reference. [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions)
4. Expose `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` to the single signing/polling step as `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`. Keep them as two distinct environment secrets, not structured JSON, and never put their values on a command line. GitHub recommends individual secrets and warns that command-line arguments may be visible or captured. [GitHub secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use#use-secrets-for-sensitive-information) · [GitHub using-secrets guidance](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
5. Run only reviewed, pinned tooling while those secrets are present. Secret redaction is not a security boundary; a compromised runner process can intentionally exfiltrate referenced secrets. [GitHub compromised-runner model](https://docs.github.com/en/actions/concepts/security/compromised-runners)
6. Resolve, submit/poll, download, and verify the XPI as described below.
7. Upload only the XPI, `.sha256`, manifest ID/version, AMO-reported hash, and source-tree digest as a workflow artifact. Never upload credentials or generated JWTs.

GitHub workflow artifacts are the supported mechanism for sharing binary output between jobs. Pin `actions/upload-artifact` and `actions/download-artifact` to reviewed full SHAs, give the artifact a commit/version-specific name, and use `overwrite: false`/unique naming so an older or parallel result cannot silently replace it. [GitHub workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) · [GitHub artifact REST schema, including digest and originating SHA](https://docs.github.com/en/rest/actions/artifacts)

**Recommendation:** Change `publish` to `needs: [validation, sign-extension]`. Immediately after checkout, download the signed artifact into a temporary directory, verify its recorded digest and metadata, and then copy exactly those two files to the paths already expected by the `Dockerfile`. Do this before `Build the multi-platform image locally`. Do not fall back to the checked-in unsigned XPI if the artifact is missing or invalid.

Keeping signing and publishing in separate jobs is preferable to simply adding a secret step to `publish`: the signing job needs only `contents: read`, while the existing publisher has `contents`, `packages`, `attestations`, and OIDC write capabilities. The artifact is the explicit boundary between the AMO credential and the image publisher.

### XPI integrity and reproducibility gate

**Verified:** AMO's version response provides the final file hash, signed-state flag, and download URL. In the frozen v4 signing API, Mozilla explicitly states that the reported hash is for the final signed file and that redirects may carry an `X-Target-Digest` SHA-256 that clients should verify. [AMO API v5 version fields](https://mozilla.github.io/addons-server/topics/api/addons) · [AMO v4 signed-file download integrity](https://mozilla.github.io/addons-server/topics/api/v4_frozen/signing.html)

**Recommendation:** Before uploading the workflow artifact, require all of the following:

- AMO channel is `unlisted`, status is approved, and `file.is_mozilla_signed_extension` is true;
- the downloaded XPI's SHA-256 equals AMO's `file.hash` (or the redirect's `X-Target-Digest` when using v4);
- the archive passes `unzip -t` and contains the expected manifest ID and version;
- after stripping only Mozilla's signature metadata under `META-INF/`, its files and bytes equal a fresh deterministic package from `browser-extension/src`;
- exactly one signed XPI was produced/downloaded, then it is renamed to `vdl-companion-firefox.xpi` and its local checksum file is regenerated.

The non-`META-INF` equality rule is a VDL release invariant, not a Mozilla guarantee documented by the cited API. Confirm it against the first real signed result; if AMO legitimately normalizes another file, document and narrowly allow that exact transformation rather than weakening the comparison.

### `Dockerfile`

No AMO-specific Docker instruction is needed. Its current allow-listed `COPY` of the XPI and checksum followed by `sha256sum -c` is the correct final handoff once `publish` stages the CI-produced signed files at those paths.

**Recommendation:** Keep the Docker build network-independent with respect to AMO, keep credentials out of build arguments and layers, and fail closed on a missing/mismatched artifact. Add or retain a container smoke assertion that the served extension reports the manifest ID/version and is recognized as Mozilla-signed; the checksum alone proves only that the copied file matches the adjacent checksum.

### `browser-extension/README.md`

**Recommendation:** Replace the manual production-signing checklist with the automated release contract:

- how an authorized maintainer creates/rotates `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in the protected environment;
- source changes require a manifest-version increment;
- validation is local and credential-free;
- `main.yml` submits or reuses the exact unlisted version, verifies it, and injects it into the image;
- a pending manual review blocks image publication and is resumed by rerunning the signing job;
- local development continues to use the unsigned development package;
- never commit AMO credentials, JWTs, or place them in the container build.

### `browser-extension/src/manifest.json`

**Recommendation:** Keep the existing ID permanently and increment `version` only when the packaged extension changes. Keep `strict_min_version: 140.0` and the declared data-collection permissions aligned with actual behavior.

Do not add an `update_url` merely to solve initial installation. Without it, new VDL containers can still offer the current signed XPI, but existing Firefox installations require users to install the newer bundled file manually. Mozilla documents that self-distributed extensions need a self-hosted `update_url`/update manifest for automatic updates; otherwise a listed AMO update is the only AMO-driven update path. [Mozilla self-distribution guide](https://extensionworkshop.com/documentation/publish/self-distribution/)

## Failure behavior

The release must fail before `docker buildx build` and before any image push when any of these occurs:

- AMO credentials are missing, invalid, expired, or belong to an account that does not own the existing ID;
- the fixed add-on ID is already registered to another AMO account;
- the manifest version already exists but its content differs from current source;
- validation fails, the upload is rejected/disabled, or manual review is still pending at the bounded timeout;
- AMO or its download CDN is unavailable;
- AMO's final hash, workflow-artifact digest, local checksum, ID/version, signature flag, or source comparison fails;
- the artifact is absent, expired, ambiguous, or originated from a different commit;
- the Docker image does not serve the same signed bytes that were verified.

Do not convert a timeout or AMO failure into a warning and do not use the checked-in unsigned development XPI as a production fallback. A failed publication is safer than an image whose Preferences pane offers an un-installable or unreviewed extension.

## Security and trust summary

- **Verified:** Secrets are withheld from fork pull-request workflows, so PR validation can remain safe and deterministic. [GitHub secret types](https://docs.github.com/en/code-security/reference/secret-security/secret-types#actions-secrets)
- **Recommendation:** Release signing should run only after protected-main validation, in a least-privilege job using a protected environment and step-scoped secrets.
- **Recommendation:** Treat signed output as untrusted until AMO metadata, AMO hash, source equivalence, ID/version, archive structure, and workflow artifact provenance all agree.
- **Recommendation:** Rotate the AMO secret immediately after suspected exposure. Mozilla states it authorizes API calls as the account. [AMO authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)
- **Recommendation:** The image should contain only the public signed XPI and checksum. Neither the AMO issuer/secret nor a generated JWT belongs in the repository, artifact, build context metadata, image layer, SBOM, attestation, or log.

## End-user experience and its limits

**Verified:** A signed unlisted XPI can be installed from VDL's ordinary desktop-Firefox link when it is served as `application/x-xpinstall`; it does not need a public AMO listing. Firefox for Android does not support this same web-install flow. [Mozilla self-distribution guide](https://extensionworkshop.com/documentation/publish/self-distribution/)

**Recommendation:** For desktop Firefox, the existing Preferences action can remain the entire discovery/download path. Keep the user-visible copy explicit that Firefox will show an **Add** confirmation and that later extension updates are manual unless VDL separately implements a stable HTTPS update manifest.

**Unresolved:** “Seamless” cannot mean silent install for unmanaged desktop Firefox. Automatic enterprise installation exists through Firefox enterprise policy, but that is an administrator deployment model, not something a Dockerized web application can impose on a visitor's browser. [Mozilla enterprise distribution](https://extensionworkshop.com/documentation/enterprise/enterprise-distribution/)

## AMO policy uncertainties to resolve with the first real submission

1. **Ownership/availability:** The repository proves the manifest ID but not whether `{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}` is unused or already owned by the intended AMO account. First submission is the only authoritative check; AMO requires uniqueness and rejects updates from non-owners. [Mozilla add-on ID guide](https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/) · [AMO Add-ons API v5](https://mozilla.github.io/addons-server/topics/api/addons)
2. **Review outcome:** CI can automate submission, polling, verification, and packaging, but it cannot guarantee Mozilla approval or its timing. Every unlisted version remains reviewable and can later be rejected or blocked. [Mozilla signing overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
3. **Cookie/data policy:** Mozilla's current policy treats URLs/cookies sent outside the extension as data transmission, requires accurate disclosure and user control, and permits Mozilla reviewers to reject or disable noncompliant add-ons. VDL's Firefox 140+ manifest declares browsing activity, website content, and authentication information, but only an actual review can confirm that Mozilla considers the declaration, onboarding, pairing, consent, transport security, privacy notice, and reviewer instructions sufficient. [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/) · [MDN data-collection manifest field](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings)
4. **Test service access:** Policy says authors must provide functional-testing information and credentials when needed. Decide whether reviewers will receive a temporary HTTPS VDL test instance/pairing flow or instructions sufficient to run one locally, and put that information in private `approval_notes`, not public CI logs. [Mozilla Add-on Policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
5. **Signed archive normalization:** The recommended source-equivalence check assumes signing adds only `META-INF/` signature data. Validate that assumption on the first signed XPI and record any narrowly required exception.

## Decision

Proceed with CI automation in `main.yml`; keep `validation.yml` secret-free. The minimum production gate is:

```text
tested commit
  -> approved unlisted AMO version for fixed ID/version
  -> AMO hash + source-equivalence verification
  -> commit-bound workflow artifact
  -> Docker COPY + sha256 verification
  -> multi-platform smoke tests
  -> GHCR push/attest/release
```

This makes the Docker image the delivery vehicle for a Mozilla-signed, non-public extension while preserving Firefox's required user confirmation and Mozilla's review authority.
