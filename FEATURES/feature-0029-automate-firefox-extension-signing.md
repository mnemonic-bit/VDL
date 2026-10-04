# Automate Firefox extension signing for container releases

**Source:** User-requested feature
**Status:** Proposed
**Last refined:** 2026-10-04
**Extends:** Feature 0014, Make the repository GitHub-ready; Feature 0026, Download authenticated pages with a Firefox companion

## Decision summary

Automate Mozilla signing of VDL Companion as an unlisted, self-distributed
Firefox extension during the trusted post-merge release pipeline. Keep the
extension and application in one repository and retain `.github/workflows/main.yml`
as the release orchestrator. Add a least-privilege `sign-extension` job between
the existing `validation` and `publish` jobs rather than introducing another
repository or making the Docker build contact Mozilla.

The signing job resolves the fixed extension ID and manifest version against
AMO. It submits the source only when that version does not exist, waits for a
bounded period, and otherwise downloads the already approved version. It then
verifies Mozilla's metadata and hash, proves that the signed archive differs
from the reviewed source only by allowed signature metadata, and passes the
signed XPI and its checksum to `publish` as a commit-bound workflow artifact.

Mozilla review is asynchronous and may outlive a GitHub-hosted job. A pending
review therefore blocks container publication without falling back to the
checked-in unsigned package. A maintainer reruns the failed workflow after AMO
approval; the rerun queries the existing ID and version before attempting any
submission, so it downloads the approved result instead of creating a
duplicate. A scheduled resume workflow is deliberately deferred until manual
reruns prove burdensome.

The published container remains the user-facing distribution mechanism. An
authenticated desktop-Firefox user opens VDL Settings, chooses **Install
Firefox extension**, and accepts Firefox's required **Add** confirmation. The
extension is not publicly listed on AMO, and AMO credentials never enter the
repository, workflow artifact, Docker build context, image, or running
container.

The supporting research and primary-source citations are recorded in
[`research/firefox-unlisted-signing-ci.md`](../research/firefox-unlisted-signing-ci.md).

## User outcome

For a user of an official VDL container image:

1. The bundled `vdl-companion-firefox.xpi` is signed by Mozilla and installable
   in Firefox Release and ESR 140 or later.
2. The user installs it directly from VDL's Browser Extension settings section;
   there is no AMO listing to find and no separate download site.
3. Firefox shows its normal installation and permission confirmation. VDL does
   not claim or attempt silent installation.
4. Installation and pairing remain separate. After installation, the existing
   short-lived pairing-string flow connects that Firefox profile to VDL.

Native development checkouts continue to carry an explicitly unsigned
development XPI. Temporary installation and the existing unsigned-package UI
remain available for development, while a published image must never contain
that development artifact.

## Goals

- Produce a Mozilla-signed, unlisted XPI from the reviewed
  `browser-extension/src/` tree.
- Make every published `main`, commit-SHA, version, and `latest` image contain
  a verified signed XPI.
- Keep pull-request validation deterministic and free of AMO credentials.
- Make the signing operation idempotent by fixed add-on ID and manifest
  version.
- Fail closed when AMO validation, review, signing, download, or local
  verification is incomplete.
- Isolate AMO credentials from the existing high-privilege image-publishing
  job.
- Preserve the current Dockerfile handoff, backend integrity check, fixed XPI
  route, and Preferences installation experience.
- Give maintainers actionable workflow output for pending review, rejection,
  credential failure, content mismatch, and transient service failure.

## Non-goals

- Publicly list or distribute VDL Companion through AMO.
- Bypass Firefox's installation or permission confirmation.
- Add enterprise-policy installation.
- Add automatic extension updates. The manifest continues to omit
  `update_url`; users install a newer bundled XPI manually.
- Sign pull-request code or expose AMO credentials to pull-request workflows.
- Put Mozilla API calls, Node tooling, credentials, or signing logic in the
  Dockerfile.
- Make AMO approval timing predictable or automatically correct an AMO policy
  rejection.
- Introduce a second repository, a dedicated signing service, or a long-lived
  project-managed signing key.
- Add a scheduled polling workflow in the first implementation.

## Terms

- **Development XPI:** The unsigned package tracked at
  `browser-extension/dist/vdl-companion-firefox.xpi` for local development and
  deterministic source checks.
- **Production XPI:** The exact Mozilla-signed bytes downloaded from AMO and
  staged only in the trusted release workspace before the container build.
- **Extension release key:** The tuple of immutable Firefox add-on ID and
  `manifest.json` version.
- **Source digest:** A deterministic SHA-256 over the relative path and bytes
  of every regular file under `browser-extension/src/`, in bytewise path order.
- **Signing gate:** The `sign-extension` job that must succeed before
  `publish` can start.
- **Pending review:** An AMO version that exists but is not yet approved and
  downloadable as a Mozilla-signed file.

## Identity and version contract

The extension release key is:

| Field | Source | Required value |
| --- | --- | --- |
| Add-on ID | `browser-extension/src/manifest.json` | `{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}` |
| Extension version | `browser-extension/src/manifest.json` | Current monotonically increasing Firefox package version |
| Backend package version | `vdl.py` `COMPANION_PACKAGE_VERSION` | Exactly equal to the manifest version |
| AMO channel | Signing workflow | `unlisted` |

The add-on ID is immutable. Every change to packaged extension content must
increment the manifest version and the mirrored backend package version.
Changing only application code does not require a new extension version.

AMO versions are immutable release records. CI must never try to replace an
existing version. If AMO already has the current ID/version, the workflow must
download and verify that version. If its payload does not match the current
source, publication fails and the extension requires a new version after the
discrepancy is understood.

The implementation of this feature is an application feature and therefore
increments root `VERSION` by `MINOR`, resetting `PATCH`, once. This feature
specification itself is documentation-only and does not increment `VERSION`.

## One-time maintainer setup

Before the first production signing run, a maintainer must:

1. Create or select the Mozilla/AMO developer account that will permanently
   own the fixed add-on ID.
2. Accept Mozilla's applicable developer agreement and create AMO API
   credentials.
3. Confirm that the fixed ID is either unused or already owned by that account.
4. Create a GitHub environment named `amo-signing`.
5. Restrict the environment to the `main` branch. A required reviewer is
   optional for the sole-maintainer repository but may be enabled.
6. Add these environment secrets:

   | GitHub secret | `web-ext` environment variable | Meaning |
   | --- | --- | --- |
   | `AMO_JWT_ISSUER` | `WEB_EXT_API_KEY` | AMO JWT issuer/API key |
   | `AMO_JWT_SECRET` | `WEB_EXT_API_SECRET` | AMO JWT signing secret |

The secret authorizes API calls as the AMO account. It must be rotated after
suspected disclosure. It must not be copied into repository variables,
workflow inputs, metadata files, command-line arguments, logs, caches, or
artifacts.

Record the required environment and repository settings in
`.github/REPOSITORY_SETTINGS.md`, because environment protection and secrets
cannot be fully represented in Git.

## Tooling contract

Use a lockfile-pinned version of Mozilla's current `web-ext` CLI with a Node
version compatible with that release. Do not use `web-ext@latest` in
validation or publication.

Packaging remains a tooling operation only. The extension source stays plain
HTML, CSS, JavaScript, JSON, and SVG with no bundling, transpilation,
minification, generated runtime code, or remote executable dependency. If a
future change introduces preprocessing, it must first extend this design to
create and submit Mozilla's required human-readable source archive and
reproducible build instructions.

The signing command for a version absent from AMO is equivalent to:

```bash
web-ext sign \
    --channel=unlisted \
    --source-dir=browser-extension/src \
    --artifacts-dir="$RUNNER_TEMP/amo-signed" \
    --approval-timeout=1800000 \
    --no-input
```

Credentials are supplied only through the two documented environment
variables. The exact 30-minute wait may be adjusted downward if runner cost or
feedback warrants it, but it must remain bounded and below the job timeout.
`--approval-timeout=0` is not used because disabling the approval wait does not
produce the signed XPI required by the next job.

## Pull-request validation

Keep `.github/workflows/validation.yml` credential-free and safe for untrusted
fork pull requests. Extend its existing Node setup and deterministic gate with
extension release checks that run without contacting AMO:

1. Install the lockfile-pinned extension tooling with `npm ci`.
2. Run `web-ext lint --self-hosted` against `browser-extension/src/`.
3. Build a fresh unsigned package in a temporary directory.
4. Require the manifest ID to equal the fixed VDL ID.
5. Require the manifest version to be valid for Firefox and equal
   `COMPANION_PACKAGE_VERSION`.
6. Require the development XPI's non-`META-INF/` file paths and bytes to equal
   the source tree.
7. Require an extension-source content change relative to the merge base to
   include a manifest-version change.
8. Reject symlinks, duplicate archive entries, case-colliding paths, absolute
   paths, traversal components, and files not present in the reviewed source.

The source-change version rule must compare content rather than treating every
README, privacy-document, checksum, or development-package change as extension
behavior. It applies to files included in the XPI.

Do not change validation to `pull_request_target`, do not pass AMO secrets into
the reusable workflow, and do not sign a package during a pull request.

## Trusted release workflow

### Job graph

Change `.github/workflows/main.yml` to enforce:

```text
validation
    -> sign-extension
        -> publish
```

`sign-extension` runs for every trusted `main` publication, not only when the
extension changed. This guarantees that every image build receives a signed
artifact. An unchanged extension version follows the inexpensive AMO
lookup/download path and is never resubmitted.

Retain the existing `push` trigger for `main`. Add `workflow_dispatch` so a
maintainer can start recovery for the current trusted ref when an earlier run
or its artifacts are no longer rerunnable. GitHub's ordinary **Re-run failed
jobs** operation remains the preferred response to a pending review because it
preserves the original commit.

### Job permissions and environment

The signing job must:

- declare `needs: validation`;
- use `environment: amo-signing`;
- use only `contents: read` repository permission;
- check out exactly `GITHUB_SHA` with persisted Git credentials disabled;
- receive no package, release, attestation, or OIDC write permission;
- expose AMO secrets only to the step that queries or submits to AMO; and
- run only repository-owned scripts and lockfile-pinned dependencies while
  those secrets are available.

The existing `publish` job retains its narrowly scoped write permissions but
must not receive AMO secrets. This separation prevents one job from holding
both the AMO account credential and GitHub package/release publication
authority.

## AMO resolution state machine

The signing helper must query AMO API v5 for the exact add-on ID and manifest
version before invoking `web-ext`.

| Observed state | Required action |
| --- | --- |
| Add-on/version absent | Run `web-ext sign --channel=unlisted` once and wait for the bounded approval period. |
| Upload validation in progress | Poll only within the remaining bounded wait. |
| Validation failed | Fail and surface the validation URL/result without exposing credentials. |
| Version awaiting review | Fail the signing gate with an explicit pending-review summary and rerun instructions. |
| Version rejected, disabled, or blocked | Fail permanently for that run; do not submit the same version again. |
| Approved, unlisted, Mozilla-signed version | Download the existing signed file and continue to local verification. |
| Existing listed or enterprise version | Fail because its channel violates the release contract. |
| Authentication or ownership failure | Fail with an environment/ownership diagnostic. |
| Rate limit, AMO outage, invalid response, or download failure | Fail as transient; never use the development XPI. |

HTTP 404 is treated as absence only when it is the authenticated, exact-version
lookup response. A CDN download 404, an add-on ownership failure, or a malformed
API response must not cause a new submission.

The helper generates short-lived AMO JWTs in memory and must not persist or log
them. It accepts only HTTPS AMO and Mozilla CDN URLs. Redirects must not forward
the AMO authorization header to a different origin.

## Signed-package verification

Treat every downloaded file as untrusted until all checks pass. The signing
job must require:

1. AMO reports channel `unlisted`.
2. AMO reports the file status as approved/public.
3. AMO reports `file.is_mozilla_signed_extension` as true.
4. The downloaded file's SHA-256 equals AMO's final `file.hash`.
5. The file is one well-formed ZIP/XPI with no encrypted entries, duplicate
   names, absolute paths, traversal paths, backslash aliases, NUL bytes, or
   case-insensitive name collisions.
6. The XPI contains `manifest.json` with exactly the fixed ID and requested
   version.
7. The expected Mozilla signature entries exist under `META-INF/`.
8. After excluding only regular files under `META-INF/`, the archive contains
   exactly the same relative paths and bytes as `browser-extension/src/`.
9. No source symlink or non-regular filesystem object is packaged.
10. Exactly one candidate signed XPI was produced or downloaded.

The rule that signing changes only `META-INF/` is a VDL release invariant to be
confirmed by the first real signing result. If Mozilla legitimately normalizes
another file, stop the release, document the exact transformation in this
specification, and add the narrowest possible verifier exception. Do not
weaken the comparison preemptively.

After verification, rename the exact downloaded bytes to
`vdl-companion-firefox.xpi` and generate:

```text
<lowercase-sha256>  vdl-companion-firefox.xpi
```

Do not re-zip, normalize, or otherwise modify the signed XPI.

## Workflow artifact contract

Upload one commit-bound artifact named from the full source SHA and extension
version. It contains only:

```text
vdl-companion-firefox.xpi
vdl-companion-firefox.xpi.sha256
extension-metadata.json
```

`extension-metadata.json` has a versioned schema and records at least:

```json
{
  "schema": 1,
  "repository": "owner/repository",
  "source_commit": "40 lowercase hexadecimal characters",
  "extension_id": "{9f743f7e-c0b3-4b99-9e58-6434d3c883d4}",
  "extension_version": "1.0.3",
  "channel": "unlisted",
  "source_sha256": "64 lowercase hexadecimal characters",
  "xpi_sha256": "64 lowercase hexadecimal characters",
  "amo_file_id": 123,
  "amo_file_url": "https://..."
}
```

The repository value is taken from trusted workflow context, not a package or
API response. The AMO URL is provenance metadata, never a later unverified
download instruction.

Use pinned revisions of `actions/upload-artifact` and
`actions/download-artifact`, disable hidden-file inclusion, choose a short
retention period, and use unique names rather than overwriting another
artifact. Workflow artifacts are a same-run handoff, not the permanent source
of extension releases. AMO remains authoritative for later retrieval of an
unchanged approved version.

## Publication and Docker integration

Change `publish` to `needs: [validation, sign-extension]`. After checking out
the tested commit and before `docker buildx build`, it must:

1. Download exactly the artifact named by the current full commit and manifest
   version into a temporary directory.
2. Reject zero, multiple, ambiguously named, or unexpected files.
3. Recompute and verify the XPI checksum.
4. Require metadata repository and source commit to match the trusted workflow
   context.
5. Require metadata extension ID/version to match the checked-out manifest and
   backend version.
6. Re-run the archive identity, signature-entry, and source-equivalence checks
   without AMO credentials.
7. Copy the verified XPI and checksum over the development files at the exact
   paths already consumed by the Dockerfile.

The root Dockerfile continues to allow-list only the XPI and checksum and to
run `sha256sum -c`. It performs no signing and needs no AMO-specific argument,
secret mount, package, or network access.

Both platform smoke tests must inspect the built image and require that:

- the bundled XPI checksum is valid;
- the XPI contains the expected Mozilla signature entries;
- its manifest ID and version are correct;
- the public route serves byte-for-byte the same XPI;
- the response remains `application/x-xpinstall`, inline for installation,
  `no-store`, and `nosniff`; and
- backend package metadata reports `signed: true`.

Only after both image variants pass may the existing workflow push tags,
attest images, or create a GitHub Release.

## Pending review and retry behavior

The normal first-submission path waits up to the configured bounded approval
timeout. If AMO has not approved the version:

- the signing job fails before `publish` starts;
- its step summary states the add-on ID, version, non-secret AMO status, and
  that the maintainer should rerun after approval;
- no XPI artifact is uploaded unless the complete verification gate passed;
- no container tag, attestation, Git tag, or GitHub Release is published; and
- the checked-in development XPI is never used as a fallback.

On rerun, the exact-version lookup happens first. An approved version is
downloaded and publication proceeds. A still-pending version fails again
without submitting another upload. A rejected version remains a hard failure;
the maintainer corrects the source, increments the extension version, and
merges a new change.

If repeated manual reruns become an operational problem, a later feature may
add a scheduled poll/resume workflow. That workflow must reuse the same
resolver and verifier, operate only on trusted `main` commits, and explicitly
bind any resumed publication to a current commit whose manifest version and
source digest match the approved AMO file.

## Repository documentation

Update `browser-extension/README.md` to describe:

- local unsigned build and lint commands using the pinned tooling;
- the automated unlisted signing contract;
- required extension-version increments;
- the protected-environment setup and credential rotation path;
- the pending-review rerun procedure;
- the strict signed-source verification rule;
- the difference between local development artifacts and published-image
  artifacts; and
- the continued absence of automatic updates.

Update `.github/REPOSITORY_SETTINGS.md` with the non-file-backed environment
configuration. Keep secret values and generated JWTs out of all documentation.

## Security requirements

- AMO secrets are available only on trusted `main` publication runs after the
  complete deterministic validation gate passes.
- Pull-request workflows remain read-only and secret-free.
- The signing job and publishing job have separate credentials and permissions.
- Third-party Actions use reviewed full commit SHAs.
- Node dependencies and `web-ext` are lockfile-pinned.
- Shell tracing is disabled for credential-bearing steps.
- Secret values, authorization headers, JWTs, and raw AMO error bodies that
  echo request data are redacted from logs and step summaries.
- AMO API responses do not choose local output paths or artifact names.
- Downloads accept only expected Mozilla HTTPS origins and are hash-verified.
- Artifact metadata is validated as data; it is never sourced as shell code.
- A missing, expired, or unverifiable artifact blocks publication.
- The final image and its attestations contain no AMO credential or JWT.

## Test plan

### Deterministic unit tests

Exercise the resolver and verifier without contacting AMO:

- exact approved unlisted version selects download;
- absent version selects one submission;
- pending, rejected, disabled, listed, enterprise, ownership, authentication,
  rate-limit, malformed-response, and transient-error states fail correctly;
- a rerun of a pending or approved version never submits again;
- AMO hash mismatch is rejected;
- manifest ID or version mismatch is rejected;
- missing signature entries are rejected;
- extra, missing, modified, duplicate, traversal, absolute, backslash, NUL,
  case-colliding, encrypted, and symlink archive entries are rejected;
- only `META-INF/` signature files may differ from source;
- checksum and metadata output are deterministic and contain no secret;
- extension and backend versions must match; and
- packaged-source changes require an extension-version change.

HTTP tests use a local fixture server or mocked transport. They must cover safe
redirect behavior and prove that authorization is not forwarded to an
unapproved origin.

### Workflow and container tests

- Validate workflow syntax and shell/script lint locally where practical.
- Run the complete credential-free gate on the development XPI.
- Exercise artifact creation and consumption with a synthetic signed-XPI
  fixture containing the expected signature paths; this proves orchestration,
  not Mozilla signature validity.
- Extend `tests/container/smoke.sh` to reject an unsigned production image and
  to compare the served bytes with the staged signed fixture.
- Preserve the unit test that identifies the tracked development XPI as
  unsigned and its synthetic signed-package test.
- Add browser coverage for the signed package state: the Settings link is
  inline, has no `download` attribute, says **Install Firefox extension**, and
  reports Firefox's Add-confirmation guidance.

The live AMO call is a release integration, not a deterministic test. Do not
use production AMO credentials in pull-request tests.

## Acceptance criteria

- Pull requests lint and package the extension without AMO access or secrets.
- A packaged extension-source change without a manifest-version increment is
  rejected before merge.
- Every trusted `main` publication resolves the exact AMO ID/version before
  Docker build.
- A new version is submitted to AMO as `unlisted` at most once.
- An already approved version is downloaded rather than resubmitted.
- A pending or rejected version prevents every image push and release action.
- A rerun after approval downloads, verifies, and packages the existing AMO
  version successfully.
- The signing job has no package, release, attestation, or OIDC write access.
- The publishing job never receives AMO credentials.
- The signed XPI matches AMO's hash and the reviewed source outside
  `META-INF/`.
- The commit-bound artifact contains only the XPI, checksum, and non-secret
  metadata.
- Both published architectures contain and serve the exact verified XPI.
- Production container smoke tests require `signed: true`.
- The Docker build contains no AMO access and fails if its staged checksum is
  absent or mismatched.
- An official container's Preferences link initiates Firefox's normal install
  flow for the signed unlisted extension.
- Local development continues to identify and download the unsigned package
  honestly.
- `./tests/run-all.sh --unit` passes with at least 90% `vdl.py` line coverage,
  and `./tests/run-all.sh --all` passes before the feature is declared done.

## Implementation scope

Expected files include:

- `.github/workflows/main.yml`
- `.github/workflows/validation.yml`
- `.github/REPOSITORY_SETTINGS.md`
- `browser-extension/README.md`
- lockfile-backed extension tooling configuration under `browser-extension/`
- a repository-owned AMO resolver/signed-XPI verifier under `scripts/` or
  `tests/support/`, with production logic kept out of test-only modules
- `tests/test_browser_extension.py` or a focused signing-helper test module
- `tests/browser/extension-settings.spec.cjs`
- `tests/container/smoke.sh`
- `VERSION`

`Dockerfile`, the fixed XPI route, and the Preferences implementation should
need no behavioral change unless testing exposes a narrowly scoped production
handoff defect.

## Verification

Before completion:

```bash
./tests/run-all.sh --unit
./tests/run-all.sh --all
```

Also perform the first real unlisted submission from the protected `main`
workflow, verify the signed archive normalization assumption, install the XPI
from an official container in supported desktop Firefox, and capture the AMO
review result without recording secrets.
