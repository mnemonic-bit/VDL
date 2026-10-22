## 52. [Resolved] Dependabot CodeQL updates can desynchronize action versions

**Severity:** Medium — CodeQL analysis fails after a partial dependency update

**Status:** Fixed in version `0.45.1` on 2026-10-22; hosted verification and
confirmation of the live required-check ruleset remain outstanding. The
mismatched pins and introducing commit are confirmed from the repository and
Git history. The hosted failure is user-reported; the complete run logs and
run URL have not been inspected.

After pushing commits to GitHub, the user reported that the CodeQL analysis
step fails with:

```text
Error: Loaded a configuration file for version '4.38.0', but running version '4.38.2'
```

The workflow pins initialization and analysis to different releases of the
same CodeQL Action. Initialization creates configuration tagged with its
version; analysis loads that configuration using another version and rejects
the mismatch. Re-running the unchanged workflow retains the incompatible pins.

### Confirmed configuration and history

Before the fix, [the CodeQL workflow](../.github/workflows/codeql.yml) used:

| Step | Pinned SHA | Release |
| --- | --- | --- |
| `github/codeql-action/init` | `b96794f015dfd88f77b49b1c93e0fa7110f94c63` | `4.38.0` |
| `github/codeql-action/analyze` | `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2` | `4.38.2` |

- Commit `c494e30` on 2026-09-17 introduced both steps at the same `4.38.0`
  SHA.
- Dependabot commit `cadc995` on 2026-10-01, titled
  `build(deps): bump github/codeql-action/analyze from 4.38.0 to 4.38.2`,
  changed only the analysis pin.
- Immediately before `cadc995`, both steps still used the identical `4.38.0`
  SHA. That commit introduced the mismatch.
- [The Dependabot configuration](../.github/dependabot.yml) scheduled GitHub
  Actions updates but defined no group for the related CodeQL actions.

The job uses one shared step definition for its Python and
JavaScript/TypeScript matrix entries, so both entries contain the mismatch.
The supplied error does not establish which hosted matrix entries failed.

### Reproduction

1. Run the current CodeQL workflow on GitHub, for example by pushing to
   `main` or opening a pull request targeting `main`.
2. Initialization uses the pinned `4.38.0` action.
3. The subsequent analysis step uses the pinned `4.38.2` action and loads the
   configuration produced by initialization.
4. Inspect the analysis log for the version-mismatch error above.

The two pins and their previous synchronized state can be checked locally:

```bash
git blame -L 37,44 -- .github/workflows/codeql.yml
git show cadc995 -- .github/workflows/codeql.yml
git show cadc995^:.github/workflows/codeql.yml
```

**Actual:** A dependency-update commit can advance one CodeQL action while
leaving another at the previous release. The inconsistency reaches the
workflow and causes a failed analysis run requiring a manual repair.

**Expected:** All CodeQL action steps in the job use the same immutable
revision. Routine updates move those references together, and a partial update
is rejected before it can merge into `main`.

### Proposed correction and prevention

1. Align `init` and `analyze` to the same reviewed release SHA. The existing
   `4.38.2` analysis pin is the immediate alignment candidate.
2. Add a Dependabot group under the existing `github-actions` entry matching
   `github/codeql-action*`, so related action updates arrive in one pull
   request. Preserve immutable SHA pins.
3. Add a lightweight validation check that all `github/codeql-action/*`
   references in the CodeQL job use the same SHA. Compare the actual refs,
   rather than version comments. Require that validation before merging;
   grouping alone does not enforce equality against manual edits or merges.

The desired invariant is one CodeQL revision per job. GitHub Actions does not
support expressions in a step's `uses` field, so a shared environment variable
cannot supply the SHA to both remote action paths. YAML anchors cannot append
one shared SHA to different action-path strings either. Grouped updates plus
enforced equality retain native Dependabot support without introducing a
workflow generator or a custom dependency updater. A literal single-pin design
would need a separately evaluated implementation and update mechanism.

### Acceptance criteria

- All CodeQL action steps in the job use the same full commit SHA, with
  matching release comments.
- Dependabot groups the related CodeQL action updates into one pull request.
- Validation accepts matching pins and rejects a deliberate one-step
  mismatch with a diagnostic naming the conflicting steps and refs.
- The validation runs on dependency-update pull requests and is required
  before merging into `main`.
- Both hosted CodeQL matrix entries complete analysis and upload their
  results without the reported configuration-version error.
- Unrelated dependency-update schedules and workflow permissions remain
  unchanged.

### References and verification limits

- [GitHub Dependabot groups reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups--)
- [GitHub Actions expression-context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
- [CodeQL Action configuration source at v4.38.2](https://github.com/github/codeql-action/blob/v4.38.2/src/config-utils.ts)

### Resolution and validation

Both `init` and `analyze` now use the existing full `4.38.2` commit SHA
`2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2`, verified against the upstream
release tag. Dependabot groups `github/codeql-action*` updates under `codeql`
without changing update schedules or workflow permissions.

[`scripts/check-codeql-pins.cjs`](../scripts/check-codeql-pins.cjs) parses YAML
and compares every CodeQL subaction's actual ref within each job. It rejects
non-full-SHA refs and differing revisions, naming the job, steps, and action
refs. Independent jobs may use different revisions. Release comments do not
affect the result.

The checker reproduced the original mismatch before alignment. Its permanent
regression suite covers matching pins, quoting and comments, additional
subactions, independent jobs, invalid refs, malformed or empty workflows, and a
CLI test that changes only one step and asserts the failure diagnostic.
The existing `Validation / Deterministic gate` runs the checker and tests on
all pull requests to `main`, including Dependabot PRs, and through the reusable
validation workflow on main pushes. Keep that status required as documented
in [repository settings](../.github/REPOSITORY_SETTINGS.md).

Local verification passed: all six Node regression tests, YAML configuration
checks for grouping and unchanged schedules/permissions, and
`./tests/run-all.sh --unit` using `VDL_PYTHON` set to a Python 3.12.14
environment (282 tests, five skipped; `vdl.py` line coverage 91.2%,
4754/5210 lines, exceeding the 90% minimum).

Hosted CodeQL analysis and SARIF upload cannot be established by the local
suite. No GitHub connector or authenticated GitHub CLI is available in this
workspace to inspect runs or verify/change the live ruleset. Confirm that
`Validation / Deterministic gate` is required in the active `main` ruleset,
record the failing run URL, and verify both CodeQL matrix entries on the next
hosted run.
