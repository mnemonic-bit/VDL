# Make the repository GitHub-ready

**Source:** User-requested feature
**Status:** Implemented in repository; maintainer settings pending
**Last refined:** 2026-09-17

## Decision summary

Prepare VDL as a public, maintainer-operated GitHub repository. Visitors should
have enough context to understand, evaluate, install, and use the project, while
the sole maintainer has reliable automation and appropriate repository
safeguards.

The project is publicly visible but is not being organised around outside code
contributions. GitHub-readiness therefore prioritises user documentation,
licensing, issue and security reporting, reproducible validation, and release
hygiene over contributor onboarding or community-governance process.

Every change to `main` must arrive through a pull request and pass the complete
deterministic test suite that GitHub-hosted runners can support. After merge,
the resulting `main` commit must pass the same gate again before its Docker
image is published to GitHub Container Registry (GHCR).

The complete design must work for a public repository owned by a personal
GitHub Free account. It may use the security, automation, package, and release
features that GitHub provides free to public repositories, but it must not
require a paid plan, metered larger runner, organisation, or separately
licensed GitHub security product.

## Current repository state

- The repository already has a GitHub `origin` remote.
- `README.md` documents native and container operation, storage, security
  constraints, dependency upgrades, and verification commands.
- `VERSION` provides a canonical SemVer release number with a mandatory bump
  policy in `AGENTS.md`.
- `tests/run-all.sh --all` is the documented release gate, with unit, browser,
  local-media, and shipping-container tiers.
- The container build uses pinned base images and a hashed Python dependency
  lock.
- Runtime data, virtual environments, agent state, and browser-test artefacts
  are covered by ignore rules.
- There is currently no `.github/` directory or GitHub Actions workflow.
- There is no repository licence, contribution guide, code of conduct,
  security policy, issue template, or pull-request template.
- Container images are built locally; the repository does not currently build
  or publish an image through GitHub Actions.

## Confirmed requirements

- Keep the repository public.
- Treat the project as sole-maintainer and sole-contributor. Do not imply that
  external pull requests or shared project governance are expected.
- Licence the repository under the MIT License, permitting use, copying,
  modification, distribution, sublicensing, and sale while requiring the
  copyright and licence notices to remain with substantial portions of the
  software.
- Include MIT's warranty and liability disclaimer without adding project-
  specific restrictions that would make the licence nonstandard.
- Use the copyright line `Copyright (c) 2026 mruether` in the MIT licence.
- Require changes to `main` to arrive through pull requests, including changes
  authored by the sole maintainer. Do not require another person's approval,
  but do require the GitHub Actions validation checks to pass before merge.
- On every pull request targeting `main`, run the unit and coverage, browser,
  generated local-media, and shipping-container tiers.
- Build and exercise the actual root `Dockerfile` during pull-request
  validation, but never publish an image from a pull-request workflow.
- On every push produced by merging to `main`, rerun all four deterministic
  test tiers. Publish the Docker image to GHCR only after every tier succeeds.
- A failed, cancelled, or skipped prerequisite test must prevent publication.
- After every successful `main` gate, publish the tested image with the mutable
  `main` tag and an immutable tag derived from the full Git commit SHA.
- When the root `VERSION` has no corresponding Git tag and GitHub Release,
  create both as `v<VERSION>` from the tested `main` commit. Publish the same
  image with `v<VERSION>` and update `latest` to that image.
- If `v<VERSION>` already exists, do not recreate the release or overwrite its
  versioned image tag. A documentation-only merge therefore updates `main` and
  adds its commit-SHA image without claiming a new application release.
- Treat the GitHub Release as the source for the README's current-version badge
  while retaining the root `VERSION` file as the repository's canonical
  version declaration.
- Publish every GHCR image as a multi-platform image supporting both
  `linux/amd64` and `linux/arm64` under the same image tags.
- Build and validate both platform variants before publishing their shared
  manifest. Failure of either platform must prevent publication of both.
- Generate an SBOM and a GitHub-native build-provenance attestation for every
  published platform image, bound to its immutable image digest.
- Publish provenance through GitHub's OIDC-backed attestation mechanism so the
  project does not need to create, store, or rotate a private signing key.
- Grant `attestations: write` and `id-token: write` only to the post-test jobs
  that create attestations.
- Keep the macOS native-fullscreen check manual because a Linux runner cannot
  establish that platform behavior.
- Keep `scripts/network-smoke.sh` outside the required gate because its public-
  site dependency is intentionally nondeterministic.
- Give pull-request validation read-only permissions. Grant `packages: write`,
  the `contents: write` needed for tags and releases, and attestation
  permissions only to post-merge publication jobs. Use the repository's
  automatic `GITHUB_TOKEN` and GitHub OIDC rather than separately stored
  registry credentials or signing keys.
- Add a compact README badge row showing the current VDL version, required
  pipeline status, MIT licence, and published container availability. Each
  badge must link to the corresponding release, workflow, licence, or package.
- Derive version presentation from `VERSION` or GitHub release metadata rather
  than maintaining an unrelated version string solely for the badge.
- Allow visitors to open GitHub issues for bug reports and feature requests
  through separate structured issue forms.
- Describe issue support as best effort with no guaranteed response or
  resolution time. Accepting issues must not imply that external pull requests
  or ongoing maintenance of every requested use case is promised.
- Direct vulnerability reports to GitHub's private vulnerability-reporting
  channel through `SECURITY.md`, not to a public issue form.
- Use only standard GitHub-hosted runners that are free for public repositories.
  Do not require larger runners; use free runner capabilities or emulation for
  the `linux/arm64` build and validation.
- Enable the dependency graph, Dependabot alerts, and Dependabot security
  updates wherever they can preserve the repository's dependency-locking
  contracts.
- Configure monthly Dependabot version-update pull requests for GitHub Actions
  and Docker. Keep coordinated Python dependency and hashed-lock regeneration
  under explicit maintainer review; an alert must still be raised for known
  vulnerable Python dependencies.
- Enable the free public-repository secret scanning and push protection.
- Enable private vulnerability reporting for the public repository.
- Run CodeQL analysis for Python and JavaScript and require its result before a
  pull request may merge.
- Exclude controls that require GitHub Pro, Team, Enterprise, GitHub Code
  Security, GitHub Secret Protection, or another paid add-on. The dated
  eligibility audit below records the current free and paid boundaries.
- Keep uploaded workflow artefacts minimal and short-lived so screenshots,
  traces, SBOMs, and build outputs stay within the GitHub Free allowance.
- Treat repository-readiness work as one explicit feature with a reviewable
  scope rather than adding unrelated GitHub files ad hoc.
- Preserve the existing application architecture, container hardening, test
  tiers, and release-version policy.
- Do not publish packages, container images, releases, or repository changes
  merely by adding the metadata and automation needed to support them.
- Keep credentials and mutable runtime data out of the repository.
- Document any GitHub repository settings that cannot be represented as files
  and must be configured by a maintainer in the GitHub UI.
- Make every automated check reproducible locally, or clearly document why a
  GitHub-only check has no local equivalent.

## Implementation scope

The feature includes the following repository files, workflows, and settings.

### Project presentation

- Refine the README introduction, feature summary, screenshots, prerequisites,
  support boundaries, and project status.
- Add repository topics, description, social preview, and homepage guidance
  for settings that live outside Git.
- Keep the confirmed badge row concise. Do not add decorative badges for
  technologies or metrics that do not help a visitor assess or obtain VDL.
- Do not add a GitHub Pages site; the repository README is the public project
  page and a separate site would duplicate it without serving a confirmed need.

### Legal and community files

- Add a root `LICENSE` containing the standard MIT License text with
  `Copyright (c) 2026 mruether`.
- Identify the MIT licence in the README without duplicating or paraphrasing
  its operative terms there.
- Add `SECURITY.md` with supported versions and a private vulnerability
  reporting path.
- Add a bug-report issue form requesting the VDL version, deployment method,
  host/browser details, reproduction steps, expected and actual behavior, and
  sanitised logs where relevant.
- Add a feature-request issue form requesting the problem or use case, desired
  outcome, and relevant alternatives or constraints.
- Disable blank issues and provide a security contact link that directs
  vulnerability reports away from the public tracker.
- Explain that issue handling is best effort without a response-time guarantee
  and that duplicate, unsupported, or insufficiently actionable reports may be
  closed.
- Do not add `CONTRIBUTING.md`, a code of conduct, or a pull-request template
  unless a concrete sole-maintainer workflow requires one.

### Continuous integration

- Add a pull-request validation workflow that runs `tests/run-all.sh --all`
  with its Python, Node/Playwright, Chromium, ffmpeg, and Docker prerequisites.
- Add a post-merge `main` workflow that reruns the same gate and makes
  publication depend on its success.
- Configure a `main` ruleset that requires a pull request and the validation
  status checks while requiring zero approving reviews for the sole
  maintainer.
- Do not use `pull_request_target` to build or execute pull-request code.
- Pin third-party Actions to reviewed immutable revisions and minimise workflow
  permissions.
- Add dependency caching only where it materially improves runtime without
  weakening reproducibility.

### Releases and container distribution

- Publish successful post-merge images to GHCR under the repository owner and
  link the package from the README.
- Tag every successful post-merge image as `main` and with an immutable full
  commit SHA.
- When `v<VERSION>` does not exist, create that Git tag and GitHub Release from
  the tested commit, tag the image as `v<VERSION>`, and move `latest` to it.
- Never recreate or overwrite an existing Git release tag or versioned image
  tag. Documentation-only merges publish only `main` and their commit SHA.
- Fail safely and require maintainer review if only part of a release already
  exists, such as a Git tag without its GitHub Release, rather than guessing
  whether the partial release should be overwritten or completed.
- Generate the README version badge from the latest GitHub Release and link it
  to that release rather than duplicating the value in README source.
- Publish one multi-platform manifest containing tested `linux/amd64` and
  `linux/arm64` images for every `main`, commit-SHA, version, and `latest` tag
  produced by the release policy.
- Ensure architecture-specific image digests remain available beneath the
  manifest so deployments are reproducible and inspectable.
- Generate an SBOM for each platform image and attach GitHub-native provenance
  to each immutable image digest before publishing the shared manifest.
- Treat missing SBOM or provenance generation as a publication failure rather
  than silently releasing an image without the required verification data.
- Document how a user can inspect the SBOM and verify provenance for a GHCR
  image. Do not introduce a project-managed signing key.
- Retain immutable version and commit-SHA tags without automatic deletion;
  document rollback using one of those immutable references rather than the
  movable `main` or `latest` tags.
- Ensure a release or image version agrees with the root `VERSION` file.

### Repository safeguards and maintenance

- Document and enable PR-only `main` protection, required validation and CodeQL
  checks, zero required approving reviews, read-only default Actions
  permissions, free public secret scanning and push protection, dependency
  alerts, and private vulnerability reporting.
- Add monthly Dependabot version updates for the `github-actions` and `docker`
  ecosystems. Pin Actions to immutable full commit SHAs and let Dependabot
  propose reviewed SHA updates.
- Keep Python dependency updates and regeneration of
  `requirements-container.txt` as one manual, reviewed operation while still
  surfacing applicable Dependabot vulnerability alerts.
- Retain immutable commit-SHA and versioned container tags. Treat `main` and
  `latest` as movable convenience tags; rollback documentation must prefer an
  immutable version or commit-SHA tag.
- Do not add an automatic package-retention deletion policy in the initial
  implementation.
- Define ownership and maintenance expectations without inventing a team that
  does not exist.

## Non-goals under the current draft

- Changing VDL's Flask, SQLite, SSE, or vanilla-JavaScript architecture.
- Making the unauthenticated application safe for direct public-Internet
  exposure.
- Establishing a multi-maintainer governance or external-contributor process.
- Automatically deploying a running VDL instance.
- Committing secrets, signing keys, tokens, downloaded media, or local database
  state.
- Adding process documents that have no clear maintainer or user.
- Using GitHub Pages, paid larger runners, organisation-wide policy features,
  or paid GitHub security products.

## Completion criteria

Every selected file and workflow must be internally consistent, and all
documented local commands must pass. Automation must use least-privilege
permissions; required validation and CodeQL checks must block unvalidated
merges; publication must be impossible after a failed gate; both supported
image architectures must pass validation and receive SBOM and provenance
metadata; README badges must resolve to real project state; and every required
out-of-repository setting must appear in a concise maintainer checklist.

The completed feature must be deployable on a public personal GitHub Free
repository without entering billing information or enabling a paid trial. The
first successful publication must include an explicit check that the GHCR
package is public and anonymously pullable.

## Verified GitHub capabilities

- A ruleset for `main` can require every change to be associated with a pull
  request and can require selected status checks before merging. GitHub allows
  the pull-request rule to require no approving review, which fits a sole-
  maintainer repository while still preventing direct changes to `main`.
  Bypass access must be omitted if the rule is intended to apply to the
  maintainer as well. ([Rules available in
  rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
  [protected
  branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches))
- Validation and publication can be safely separated by event: run tests and a
  non-publishing container build for `pull_request` events targeting `main`,
  then run the complete GitHub-compatible test gate again and publish only on
  `push` to `main`. A publish job can declare the validation jobs with `needs`,
  so GitHub skips publication when any prerequisite fails. Pull-request jobs
  should not receive write permissions, and `pull_request_target` must not be
  used to build or run pull-request code because GitHub warns that this can
  expose write privileges or secrets. ([Workflow
  triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
  [job
  dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds),
  [pull-request event
  security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target))
- A workflow in this repository can publish its associated image to GHCR with
  the automatically supplied `GITHUB_TOKEN`; the publishing job needs
  `contents: read` and `packages: write`, so a separately stored registry token
  is unnecessary. These write permissions should exist only on the publishing
  job. ([Publishing packages with GitHub
  Actions](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions),
  [publishing Docker
  images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images))
- GitHub provides a native workflow-status badge whose URL can be scoped to the
  `main` branch and `push` event. GitHub also provides a stable
  `/releases/latest` link. The README's version badge should therefore be
  generated from the canonical `VERSION` or release metadata and link to the
  latest release, rather than introducing another manually maintained version
  value. ([Workflow-status
  badges](https://docs.github.com/en/actions/how-tos/monitor-workflows/add-a-status-badge),
  [linking to the latest
  release](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases))
- Workflow permissions should default to read-only and be raised per job, and
  every referenced action should be pinned to a reviewed full-length commit
  SHA; GitHub identifies a full SHA as the only immutable action reference and
  offers a repository setting that enforces this policy. For a published
  public container, GitHub can additionally create build-provenance
  attestations; that optional publishing step requires `attestations: write`
  and `id-token: write` alongside the container's `packages: write`.
  ([Secure use of GitHub
  Actions](https://docs.github.com/en/actions/reference/security/secure-use),
  [repository Actions
  settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository),
  [container artifact
  attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations#generating-build-provenance-for-container-images))

## GitHub Free eligibility

**Audited:** 2026-09-17 against official GitHub documentation for a public
repository owned by a personal GitHub Free account.

| Capability | Decision for this feature | Free-tier boundary |
|---|---|---|
| GitHub Actions | Include | Standard GitHub-hosted runners are free for public repositories. GitHub Free includes 500 MB of artifact storage and 10 GB of cache storage per repository; larger runners are always charged and must not be required. Keep uploaded artefacts short-lived. ([Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) |
| Pull-request and check enforcement | Include | Public repositories on GitHub Free support rulesets and protected branches. Require a pull request and passing status checks, set required approvals to zero, and omit every ruleset bypass actor. Classic branch protection can instead enable **Do not allow bypassing** so the rule applies to the owner/admin. The owner necessarily retains authority to edit or disable the repository rule itself. ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)) |
| GHCR images | Include with a one-time visibility check | Public-package use is free, and Container Registry image storage and bandwidth are currently free. A public image supports anonymous pulls. Because first-publication visibility depends on how the package is linked and published, link it to this repository and verify that it is **Public** after the first publish. ([Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages), [package permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages), [Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)) |
| GitHub Releases | Include | Releases are available to repository writers; each release may have up to 1,000 assets, each under 2 GiB, with no total release-size or bandwidth limit. ([About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)) |
| Dependency graph and Dependabot | Include | The dependency graph is on by default for public repositories. Dependabot alerts, security-update pull requests, and scheduled version updates are available without a paid security product; version updates support GitHub Actions and Docker. ([dependency graph](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-graph), [security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates), [version updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates)) |
| Secret scanning and push protection | Include the free public-repository protections | Secret scanning runs automatically for free on public repositories, and push protection is available for public repositories by default. Do not require the paid controls listed below. ([secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning), [GitHub security features](https://docs.github.com/en/code-security/getting-started/github-security-features)) |
| Private vulnerability reporting | Include | Repository owners can enable private vulnerability reporting for public repositories. ([Repository security advisories](https://docs.github.com/en/code-security/concepts/vulnerability-reporting-and-management/repository-security-advisories)) |
| CodeQL and merge protection | Include | Public repositories can use CodeQL default or advanced setup without GitHub Code Security. Python and JavaScript are supported, and a repository-level ruleset can require CodeQL results before merge. ([CodeQL code scanning](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning), [merge protection](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection)) |
| Provenance and SBOM attestations | Include | Artifact attestations are available to public repositories on GitHub Free and support container-image provenance plus signed SPDX or CycloneDX SBOM attestations. ([Artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)) |
| Repository presentation and intake | Include as needed | Issues, YAML issue forms, workflow-status badges, repository topics, and a social-preview image are available. Issue forms remain in public preview. GitHub Pages is also free for public repositories, but is optional and is not needed merely to make VDL GitHub-ready. ([issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms), [status badges](https://docs.github.com/en/actions/how-tos/monitor-workflows/add-a-status-badge), [repository customisation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository), [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages)) |

The implementation must exclude paid-only controls: partner-pattern validity
and extended-metadata checks, custom or AI-detected secret patterns, delegated
push-protection bypass, the **Require secret scanning alerts are resolved**
merge rule, security campaigns and organisation security overview, custom
Dependabot auto-triage rules, organisation-wide rulesets or required workflows,
and larger GitHub-hosted runners. In particular, the repository-level validity-
check setup requires an organisation-owned repository on GitHub Team with
GitHub Secret Protection, and secret-scanning merge protection requires Secret
Protection or Advanced Security. ([validity-check
availability](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/customize-leak-detection/enable-validity-checks),
[secret-scanning merge
protection](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/prevent-future-leaks/block-merges-with-secrets),
[GitHub Advanced
Security](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security))
