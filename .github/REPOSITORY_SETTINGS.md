# GitHub repository settings

These settings cannot be represented completely by files in the repository.
Apply this checklist after the feature branch is merged. All items are available
to a public repository owned by a personal GitHub Free account; do not enable a
paid trial or paid-only security control.

## Presentation

- Keep the repository public.
- Set the description to `A lightweight local video-downloader UI powered by yt-dlp.`
- Leave the homepage empty unless a maintained project site is created later;
  the README is the project page and GitHub Pages is intentionally unused.
- Add topics: `video-downloader`, `yt-dlp`, `flask`, `docker`, `sse`, and
  `self-hosted`.
- Upload `overlay-initial.png` as the social preview. Replace it only with a
  maintained 1280 x 640 project image that contains no downloaded-media data.

## Actions and merge rules

- Under **Actions > General**, allow GitHub-authored actions plus the verified
  Docker and Anchore actions used by the workflows. Require actions to be pinned
  to a full commit SHA if the repository setting is offered.
- Set the default workflow token permission to **Read repository contents and
  packages** and leave **Allow GitHub Actions to create and approve pull
  requests** disabled. The `Main` workflow raises permissions only for its
  post-test publication job.
- After the first pull request containing these workflows has run, create an
  active ruleset targeting `main`. Do not add a bypass actor. Require a pull
  request with zero required approvals, require branches to be up to date, and
  require these status checks:
  - `Validation / Deterministic gate`
  - `CodeQL / Analyze (python)`
  - `CodeQL / Analyze (javascript-typescript)`
- Do not enable a direct-push or administrator bypass. The repository owner can
  still edit the ruleset itself, but ordinary changes to `main` must use a pull
  request and pass the checks.

The deterministic check is reproduced locally with `./tests/run-all.sh --all`.
Its workflow also validates CodeQL pins before the application tests. Keep
`Validation / Deterministic gate` required on `main`, including for Dependabot
pull requests: the CodeQL revision check fails this existing required status
when any job mixes revisions or uses a mutable CodeQL ref. No additional status
check is needed. Confirm the live ruleset has this requirement; workflow files
alone cannot enforce a merge restriction. Run the same pin check locally with
`npm ci && node scripts/check-codeql-pins.cjs` and its regression tests with
`node --test tests/codeql-pins.test.cjs`.

CodeQL result upload, GHCR publication, GitHub Releases, and OIDC-backed
attestation have no local equivalent because they are GitHub services. The
container smoke and both application architectures remain locally reproducible
with Docker/Podman and QEMU-capable Docker respectively.

## Security and dependency maintenance

- Enable the dependency graph, Dependabot alerts, and Dependabot security
  updates. Monthly version-update pull requests are file-configured for Actions
  and Docker. Keep Python plus the hashed container lock as one manual reviewed
  update; Dependabot alerts still surface known vulnerable Python packages.
- Enable private vulnerability reporting.
- Confirm public-repository secret scanning and push protection are enabled.
- Use this repository's advanced CodeQL workflow; do not also enable CodeQL
  default setup. Require the two CodeQL checks in the `main` ruleset.
- Keep CodeQL Action updates in the `codeql` Dependabot group. All CodeQL
  subactions within a job must retain the same full commit SHA.
- Do not enable paid-only secret validity, custom-pattern, campaign, security
  overview, or security merge-protection controls.

## First image publication

AMO setup is optional. With no credentials, or only one credential, the trusted
workflow makes no AMO requests and publishes a verified unsigned development
companion. Ordinary VDL features remain available. Settings labels this package
**Download unsigned XPI**, with temporary Firefox loading instructions; it is
not a normally installable Firefox extension.

To enable best-effort signing, create a GitHub environment named `amo-signing`,
restrict deployment branches to `main`, and add both environment secrets
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from the AMO developer account that owns
the fixed VDL add-on ID. A required reviewer is optional. Rotate the secret in
the Developer Hub and replace it in the environment after suspected exposure.
Only the AMO resolution step receives these secrets; its job has read-only
repository permission, and the publisher receives no AMO credentials.

The workflow summary identifies the package type, extension ID/version, source
commit, and stable resolution reason. Missing/incomplete credentials,
authentication/ownership failure, rate limiting, service or ordinary network
failure, pending review, and transient signed-download failure select verified
unsigned output. Check credential validity and add-on ownership for an
authentication warning. Integrity, TLS, unsafe redirect, rejection, validation,
metadata, tooling, artifact, and unknown failures block publication. See
[Feature 0043](../FEATURES/feature-0043-make-firefox-extension-signing-optional.md).

Approval or added credentials do not change an existing image. Publish a new
application release/commit to bundle the now-signed exact extension version;
unchanged extension source needs no extension-version bump. Existing commit
and version tags remain immutable; rerunning an already published commit is
not a supported way to replace an unsigned companion.

The first successful `Main` run pushes `main` and a full-commit-SHA tag, then
checks the SHA tag without registry credentials. A new GHCR package may default
to private and make that run stop before creating version tags or a Release.

1. Open **Packages > vdl > Package settings** and set visibility to **Public**.
2. Confirm the package is connected to this repository. The image's OCI source
   label should establish the connection automatically; add it manually if it
   does not.
3. Publish a new commit to `main` after making the package public. The already
   published SHA tag is immutable, so its workflow cannot replace that image.
   If no version tag or Release was created, keep that application version for
   this recovery commit. The anonymous access check must pass before
   attestations, `v<VERSION>`, `latest`, and the GitHub Release are created.
4. From a logged-out shell, run
   `docker pull ghcr.io/mnemonic-bit/vdl:<full-commit-sha>`.

Retain immutable full-SHA and `v<VERSION>` tags indefinitely. `main` and
`latest` are movable convenience tags. Roll back by pulling an immutable tag,
never by assuming what either movable tag previously referenced. No automatic
package-retention deletion policy is configured.
