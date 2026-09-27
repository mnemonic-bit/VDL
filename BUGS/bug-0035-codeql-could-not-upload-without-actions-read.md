## 35. [Resolved] CodeQL could not upload results without Actions read access

**Severity:** Medium

**Status:** Resolved in version `0.16.2` on 2026-09-27. The next hosted
GitHub Actions run must confirm the repository-specific permission change.

The CodeQL job failed for both Python and JavaScript/TypeScript during the
GitHub Actions run for commit `e522dd9`. Both matrix entries extracted their
languages, ran their queries, and post-processed their SARIF files successfully.
The failure occurred afterward when the action attempted to read its workflow
run:

```text
Error: Resource not accessible by integration -
https://docs.github.com/rest/actions/workflow-runs#get-a-workflow-run
```

The repeated telemetry warning was not the cause of the failed scan. The final
request used by `github/codeql-action/analyze` was denied for the same reason:
the job-level `permissions` block granted `contents: read` and
`security-events: write`, but omitted `actions: read`. Job-level permissions
replace unspecified token access with `none`, so the action could upload code
scanning data but could not inspect the workflow run associated with it.

**Expected:** Both language matrices should scan the repository and upload
their SARIF results without a `Resource not accessible by integration` error.
The workflow token should have only the documented permissions required for
that operation.

**Reproduction:** Push commit `e522dd9` to `main` and inspect the `Analyse`
step in either CodeQL matrix entry. The logs report complete source coverage,
then fail while calling the workflow-runs API during SARIF post-processing.

**Resolution:** The CodeQL job now grants `actions: read` alongside
`contents: read` and `security-events: write`. Python and JavaScript/TypeScript
share that job-level permission block, so the correction applies to both
matrix entries without broadening the repository-wide default token scope.

Hosted CodeQL execution cannot be reproduced by the local deterministic test
suite. The workflow structure and complete repository gate were validated
locally; successful SARIF upload remains the acceptance check for the next
GitHub Actions run.
