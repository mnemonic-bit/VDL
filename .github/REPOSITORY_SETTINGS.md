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
- Do not enable paid-only secret validity, custom-pattern, campaign, security
  overview, or security merge-protection controls.

## First image publication

The first successful `Main` run pushes `main` and a full-commit-SHA tag, then
checks the SHA tag without registry credentials. A new GHCR package may default
to private and make that run stop before creating version tags or a Release.

1. Open **Packages > vdl > Package settings** and set visibility to **Public**.
2. Confirm the package is connected to this repository. The image's OCI source
   label should establish the connection automatically; add it manually if it
   does not.
3. Rerun the failed `Main` workflow. Its anonymous access check must pass before
   attestations, `v<VERSION>`, `latest`, and the GitHub Release are created.
4. From a logged-out shell, run
   `docker pull ghcr.io/mnemonic-bit/vdl:<full-commit-sha>`.

Retain immutable full-SHA and `v<VERSION>` tags indefinitely. `main` and
`latest` are movable convenience tags. Roll back by pulling an immutable tag,
never by assuming what either movable tag previously referenced. No automatic
package-retention deletion policy is configured.
