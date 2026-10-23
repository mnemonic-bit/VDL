# Make Firefox extension signing optional for container publication

**Source:** User-requested feature
**Status:** Implemented; manual Firefox verification pending
**Last refined:** 2026-10-23
**Updates:** [Feature 0029, Automate Firefox extension signing for container releases](feature-0029-automate-firefox-extension-signing.md)
**Related:** [Feature 0026, Download authenticated pages with a Firefox companion](feature-0026-download-authenticated-pages-with-firefox.md)

## Decision summary

Make Mozilla signing a best-effort part of the trusted GitHub release
pipeline. A maintainer must be able to build and publish VDL's Docker image
without configuring AMO credentials, and without waiting for Mozilla review
or service recovery. When signing is unavailable for a recognized reason,
publish the image with the verified unsigned development package from the
same commit. When the exact extension version is approved and available,
publish with its verified Mozilla-signed XPI instead.

Keep one extension package in each image and one primary action in Settings
→ Browser Extension. The existing UI already distinguishes signed and
unsigned packages. Preserve that behavior and add actionable instructions for
temporarily loading an unsigned package into Firefox.

This proposal replaces Feature 0029's requirement that every published image
contain a signed extension and that pending review block publication. Its
identity, source-equivalence, credential isolation, and artifact-integrity
requirements continue to apply. Signing availability becomes optional;
verification of whichever package is selected remains mandatory.

## User outcome

- With no AMO setup, GitHub validation, image builds, container smoke tests,
  and publication can complete. Users can run VDL and use its ordinary
  download, upload, library, and playback features.
- With a signed package, users choose **Install Firefox extension** or
  **Update Firefox extension** and accept Firefox's normal confirmation.
- With an unsigned package, users choose **Download unsigned XPI** and see
  temporary-installation instructions and the browser-restart limitation.
- Maintainers can see which package was published and why fallback occurred
  in the workflow summary. An unsigned image must not be described as
  providing a normally installable Firefox extension.

## Scope and defaults

- Best-effort signing is the default for all existing `main`, commit-SHA,
  version, and `latest` publication paths. No secret, repository variable,
  workflow input, or runtime setting is required to enable unsigned fallback.
- When both AMO credentials are configured, automatically attempt the
  existing exact-version lookup and signing flow. If either is absent or
  empty, skip all AMO requests and select the unsigned package.
- Preserve pull-request validation without AMO credentials or network calls.
- Keep signing out of the Dockerfile and runtime server. Preserve the fixed
  extension ID, package routes, pairing protocol, and manual-update model.
- Do not add two simultaneous downloads, retrieve an older signed version,
  reuse another commit's artifact, or cache a signed package as fallback.
- A configurable strict-signing mode, separate extension release workflow,
  background approval polling, and automatic extension updates are deferred.

## Resolution outcomes

The resolver must distinguish a verified signed result, an explicitly
classified unsigned fallback, and a blocking error. Do not treat every
nonzero exit, exception, or failed job as permission to publish unsigned.

| Condition | Required outcome |
| --- | --- |
| Both credentials absent, or only one configured | Verified unsigned package; report missing or incomplete credential configuration; no AMO calls |
| AMO returns an authentication or authorization failure | Verified unsigned package; report credentials or add-on ownership need attention |
| AMO rate limit, HTTP 5xx, ordinary connection failure, DNS failure, or request timeout | Verified unsigned package; report temporary AMO unavailability |
| Exact add-on/version absent | Submit once as `unlisted`, using the existing bounded approval wait, then resolve the resulting state |
| Existing or newly submitted version is awaiting review | Verified unsigned package; report pending review; never resubmit an existing version |
| Exact version is approved, unlisted, and Mozilla-signed | Download, verify, and select the signed package |
| Approved file cannot be downloaded because of a recognized transient network or service failure | Verified unsigned package; report signed download unavailable |
| AMO explicitly rejects or disables the version, or reports failed extension validation | Block publication; require maintainer investigation |
| Wrong channel, ID, version, malformed metadata, unsafe URL or redirect, or TLS certificate validation failure | Block publication |
| Downloaded hash mismatch, missing signatures, unsafe archive entry, or source-content mismatch | Block publication |
| Unsigned package is absent, corrupted, signed unexpectedly, or differs from the checked-out source | Block publication |
| Artifact upload/download failure, missing result metadata, staging failure, tooling failure, or unclassified error | Block publication |
| Failed application validation, container test, cancelled run, or killed/timed-out job | Preserve the failure or cancellation; do not publish |

Use typed outcomes or stable reason codes rather than matching human-readable
error strings. Distinguish service/network failures from TLS, redirect, and
metadata validation failures even when the transport library represents them
with the same exception type. Never downgrade an integrity failure to an
availability warning.

Keep individual requests and approval waiting bounded below the job timeout.
An approval wait ending normally with a known pending-review state may select
unsigned fallback. A job that is forcibly terminated has no trusted result.
If submission fails and no authoritative version or recognized availability
state can be established, block publication instead of guessing why it failed.

## Workflow and artifact handoff

Retain the least-privilege separation between validation, extension resolution,
and image publication. The extension job continues to use the protected
`amo-signing` environment with read-only repository permission. Only the AMO
step receives `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`, mapped to
`WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`.

1. Complete the existing deterministic validation before resolving the
   extension. Validate the unsigned development XPI against the checked-out
   source, checksum, fixed ID, and manifest/backend version contract.
2. Resolve signing using the table above. Recognized unsigned fallback is a
   successful resolution with a warning, not a failed prerequisite job.
3. Produce exactly one commit-bound package artifact for either successful
   outcome. Include the selected XPI, its checksum, and non-secret metadata.
4. In the separate publisher, download that artifact from the current run,
   revalidate its contents and metadata against the checked-out commit, and
   stage the package at the existing Dockerfile paths.
5. Build and test both supported architectures with the same selected bytes
   before following the existing image, tag, release, and attestation policy.

The artifact metadata must explicitly record `signed` as a boolean, a stable
resolution reason, the repository and source commit, fixed extension ID,
extension version, source digest, and selected XPI SHA-256. Signed metadata
also retains the AMO file ID and URL. Unsigned metadata must not invent AMO
provenance or claim approval. Version the metadata schema when extending the
existing contract, and reject missing, unknown, or contradictory fields.

The publisher must independently confirm that the selected package's signature
state matches the metadata. Both package types retain all applicable archive,
identity, checksum, and source-equivalence checks. Signed verification also
retains the AMO hash and signature-entry checks. Firefox performs its own
signature validation during installation.

Do not implement fallback by adding unconditional `continue-on-error`, by
using `always()` to publish after arbitrary failures, or by letting artifact
download failure silently select the checked-in XPI. The resolver must
explicitly produce and verify the unsigned artifact when fallback is allowed.

No AMO credential, generated JWT, authorization header, raw credential-bearing
error body, or signing-process output may enter logs, artifacts, Docker
arguments, image layers, or the running app. Keep existing reviewed and pinned
tooling and protected-branch restrictions.

## Maintainer feedback and later approval

The workflow summary must state the extension ID and version, selected package
type, source commit, and a sanitized explanation. For example:

> Publishing with the unsigned Firefox companion: AMO credentials are not
> configured. The app remains usable; normal Firefox extension installation
> requires a Mozilla-signed package.

For missing or incomplete credentials, name both expected environment secrets
and the `amo-signing` environment, with a link to setup documentation. For an
authentication failure, direct the maintainer to check credential validity and
add-on ownership. For pending review or temporary unavailability, explain that
a later release workflow can resolve the exact same extension version again.

Adding credentials or AMO approval does not change an already published image.
A subsequent publication must produce a new image containing the signed
package. Preserve existing immutable commit and version tags; do not promise
that rerunning an already published commit can replace them. Document that a
new application release/commit is the supported path after an unsigned
publication. An unchanged extension payload does not need an extension-version
bump solely because Mozilla has since signed it.

## In-app download and installation

Use the existing package metadata and one primary action, based on the
verified package actually bundled in the image:

| State | Primary action | Guidance |
| --- | --- | --- |
| Signed | Install/update Firefox extension | Normal Firefox confirmation; installation and pairing are separate |
| Unsigned | Download unsigned XPI | Development/testing package; temporary loading instructions and restart limitation |
| Missing or failed integrity check | Disabled download/install action | Package unavailable; contact the VDL operator |

For unsigned downloads, retain the attachment response and `download`
attribute. Do not initiate Firefox's normal installation prompt for that
package or suggest that downloading it is enough to install it normally.

Show instructions beside the unsigned action, optionally in an expandable
help block:

1. Download the XPI and extract it into a local folder. If the archive tool
   requires it, rename the local copy from `.xpi` to `.zip` before extraction.
2. Open `about:debugging` in Firefox and choose **This Firefox**.
3. Choose **Load Temporary Add-on** and select the extracted `manifest.json`.
4. Open the VDL Companion toolbar action and use the existing pairing flow.

Explicitly state that temporary loading lasts only until Firefox restarts and
must be repeated afterward. Do not promise that pairing or extension storage
is erased or retained by a restart. Do not recommend disabling signature
checks as the installation path for ordinary Firefox users.

Signed packages keep the current install/update behavior, inline response,
and no forced-download attribute. Changing between bundled package states
must refresh the label, link attributes, and help text together. Do not revoke
existing companion connections or demand that users replace a compatible
installed signed extension merely because the new server image is unsigned.

Keep AMO configuration details in maintainer documentation and the workflow
summary; in-app help should explain the available user action. Preserve the
existing integrity-unavailable state and pairing transport/access checks.

## Documentation and implementation areas

Expected implementation changes include:

- `.github/workflows/main.yml`: optional signing resolution and consistent
  artifact handoff, summary, staging, and architecture checks.
- `scripts/extension_release.py`: classified outcomes, verified unsigned
  artifact production, extended metadata, and package-state-aware staging.
- `scripts/verify_companion_xpi.py`, if needed: explicit expected signature
  state while preserving all existing verification rules.
- `tests/container/smoke.sh`: verify exact expected signed/unsigned state;
  setting the current signed-required flag to zero alone is insufficient.
- `static/app.js` and `templates/index.html`: unsigned temporary-installation
  guidance while preserving the single-action UI.
- `.github/REPOSITORY_SETTINGS.md` and `browser-extension/README.md`: first
  publication without AMO setup, optional credential setup, fallback reasons,
  temporary installation, and the later signed-publication path.
- Relevant release-helper, workflow, backend, browser, and container tests.

No database migration, new runtime preference, alternate extension ID, or
second package-serving route is required. Update Feature 0029's affected
release guarantees when implementing this proposal, linking back to this
specification so documentation no longer claims signing is mandatory.

This specification is documentation-only and leaves root `VERSION` unchanged.
Implementation is a feature: increment the then-current root MINOR version
and reset PATCH once. Change the extension manifest and mirrored backend
package version only if packaged extension source changes.

## Acceptance criteria and verification

1. A trusted release with neither AMO secret, and one with only one secret,
   performs no AMO requests, selects a verified unsigned artifact, passes
   both architecture checks, and remains eligible for normal publication.
2. An already approved exact version selects the signed artifact without a
   new submission. An absent version is submitted once; a pending version
   selects unsigned and is not resubmitted on a later resolution.
3. Authentication failure, rate limiting, service outage, request timeout,
   pending review, and transient approved-file download failure each yield
   the specified unsigned result and an actionable sanitized summary.
4. Rejection, disabled/invalid versions, unsafe transport, malformed metadata,
   wrong identity/channel/version, archive violations, hash/signature/source
   mismatch, and unknown errors block every publication action. Tests prove
   these failures cannot be converted into unsigned fallback.
5. Either artifact is bound to the current repository, commit, extension
   version, and source. Missing artifacts, tampered metadata, signature-state
   disagreement, and cross-run/commit substitution fail before image build.
6. Container tests verify expected signature state, served bytes, checksum,
   manifest identity, and package version for both signed and unsigned images
   on both architectures. Other application checks still gate publication.
7. Browser tests cover signed, unsigned, and integrity-unavailable states,
   including action text, URLs, download attributes, temporary-installation
   instructions, state changes, and preserved pairing behavior.
8. A manual Firefox check confirms normal installation of a real signed XPI
   and temporary loading of the unsigned package, including its disappearance
   after restarting Firefox. Synthetic signature fixtures prove orchestration
   and UI state, not Mozilla signature validity.
9. A later application release can obtain the now-approved extension without
   changing its unchanged manifest version or replacing existing immutable
   image tags. Pull-request tests remain credential-free and deterministic.

Exercise remote states with mocked transport or local fixtures; no production
AMO credentials are required for automated tests. Run
`./tests/run-all.sh --unit` and verify at least 90% `vdl.py` line coverage
before marking implementation complete. Also run the relevant browser tests
and both signed/unsigned container checks, followed by the repository's full
`./tests/run-all.sh --all` gate.

## Implementation notes

Implemented in application version `0.46.0`. The extension source and its
manifest/backend package version remain unchanged at `1.0.3`.

The release helper uses schema-2 metadata with an explicit signature state,
classified resolution reason, and signed-only AMO provenance. Publisher staging
independently verifies the selected package and supplies its expected state and
SHA-256 to both architecture checks. Publication refuses to overwrite an
already published commit image; a new application commit/release is required.
The credential-free validation job also runs workflow safety regression tests.

Settings includes temporary-loading instructions for unsigned packages and
refreshes action attributes and help together as package state changes. The
action stays disabled until verified package metadata arrives. Existing
companion connections and the pairing flow remain available.

The browser fixture stubs native thumbnail generation for its dummy video
bytes, so installing ffmpeg does not make bulk-seed pagination checks time out.
Real thumbnail generation remains covered by the unit and media tiers.

The full `./tests/run-all.sh --all` gate passed: 295 unit tests with 91.2%
backend coverage, 213 browser tests, five media integration tests, and shipping
container checks. Ten workflow regressions and signed/unsigned amd64 image
smoke checks also passed. The signed fixture is synthetic.
The arm64 attempt on this host failed with `Exec format error` because QEMU/binfmt
is unavailable; the publication workflow retains QEMU-backed arm64 checks.
Normal installation of a real Mozilla-signed XPI and temporary loading followed
by a Firefox restart remain manual release checks.

Mozilla's installation constraints are documented in
[Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
and [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).
