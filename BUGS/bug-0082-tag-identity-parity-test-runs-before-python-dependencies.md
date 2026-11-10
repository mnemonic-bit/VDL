## 82. Tag identity parity test runs before Python dependencies in GitHub Actions

**Severity:** Medium — blocks the deterministic validation gate and dependent
publication jobs.

**Status:** Open, pending hosted validation; repair implemented in version `0.64.1`.
Reported on 2026-11-10; the missing-dependency failure was reproduced locally
on the same date. The bug remains open until the corrected hosted
deterministic validation gate passes (AC-4).

Source reviewed at local commit `0285001`, version `0.64.0`. The reporter
described a GitHub Actions run containing the accumulated changes since
`0.53.0`, except for the latest local commit. The workflow URL and failing
commit SHA were not supplied, so the exact hosted revision remains unconfirmed.
Version `0.53.0` is background context, not an established affected version.

### Reported behavior

The JavaScript test `normalization agrees with the actual server across Unicode folds and category boundaries`
at [`tests/tag-identity-parity.test.cjs:34`](../tests/tag-identity-parity.test.cjs#L34)
fails before comparing any client/server normalization results:

```text
Traceback (most recent call last):
  File "<string>", line 4, in <module>
  File "/home/runner/work/VDL/VDL/vdl.py", line 9, in <module>
    from flask import (
ModuleNotFoundError: No module named 'flask'

1 !== 0

at TestContext.<anonymous> (.../tests/tag-identity-parity.test.cjs:62:12)
Error: Process completed with exit code 1.
```

**Expected:** The validation workflow installs the Python runtime dependencies
before running tests that import the actual server. The parity test compares
the JavaScript normalization results against the server's results and exits
with code 0 when the results agree.

**Actual:** The Python subprocess exits with code 1 while importing `vdl`.
The JavaScript test fails its subprocess-exit assertion. This failure does not
establish a Unicode normalization defect.

### Evidence and cause

Before the correction, the [validation workflow](../.github/workflows/validation.yml)
ran the relevant steps in this order:

1. `Set up Python` selects Python 3.12.
2. `Set up Node.js` selects Node.js 24.8.0.
3. `Install workflow and extension tooling` runs `npm ci`.
4. `Validate CodeQL action pins` runs `node scripts/check-codeql-pins.cjs`
   and then `node --test tests/*.test.cjs`.
5. `Install native dependencies` installs ffmpeg and the Python packages
   from [`requirements.txt`](../requirements.txt), including Flask and yt-dlp.

The parity test is included by `tests/*.test.cjs`. Its second test starts
Python and imports `vdl`, which requires Flask. Python setup alone does not
install the application's requirements; the installation step came after
the test that needs those requirements.

The test selects `VDL_PYTHON` when set, otherwise `.venv/bin/python` when that
file exists, otherwise `python3`. An existing developer environment can supply
the dependencies and hide the workflow ordering defect. The selected
interpreter must receive the dependencies before the parity test runs.

The [Main workflow](../.github/workflows/main.yml) calls this validation
workflow. Its `sign-extension` and `publish` jobs depend on successful
validation, so this failure prevents those jobs from proceeding. The supplied
log does not independently establish their hosted job statuses.

### Local reproduction

From the repository root, run the existing test with a temporary Python
environment that has no application packages:

```bash
python3 - <<'PY'
import os
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix='vdl-tag-parity-') as directory:
    subprocess.run(['python3', '-m', 'venv', '--without-pip', directory], check=True)
    result = subprocess.run(
        ['node', '--test', 'tests/tag-identity-parity.test.cjs'],
        env={**os.environ, 'VDL_PYTHON': directory + '/bin/python'},
    )
    raise SystemExit(result.returncode)
PY
```

**Result: failed**, exit code 1. The first test passed; the server parity
test failed with `ModuleNotFoundError: No module named 'flask'` at the same
import and assertion as the supplied CI log. Local versions were Python
3.11.2 and Node.js 22.23.4. This controlled reproduction establishes the
missing-dependency failure; the complete hosted workflow was not run locally.
The temporary environment was removed automatically after the command.

### Correction in version `0.64.1`

The validation workflow retains the early CodeQL pin check and moves
`node --test tests/*.test.cjs` into a separate step after native dependency
installation. The JavaScript step sets `VDL_PYTHON=python`, selecting the same
interpreter used by `python -m pip install -r requirements.txt` instead of
allowing a local `.venv` to override that interpreter.

The actual-server parity test is unchanged. The new
[`tests/validation-workflow.test.cjs`](../tests/validation-workflow.test.cjs)
checks dependency installation precedes the suite and verifies its interpreter
selection. The regression failed against the original workflow with
`JavaScript tests must run after server dependency installation`, then passed
after the correction.

### Acceptance criteria

- **AC-1:** In a clean validation environment using Python 3.12 and Node.js
  24.8.0, install `requirements.txt` before the JavaScript suite. Verify that
  the interpreter selected by the test can import `flask`, `yt_dlp`, and `vdl`.
- **AC-2:** `node --test tests/tag-identity-parity.test.cjs` passes both tests
  with exit code 0. Retain the actual server import, Unicode fold/category
  comparisons, and subprocess-exit assertion; do not skip the test when
  dependencies are missing.
- **AC-3:** `node scripts/check-codeql-pins.cjs` and
  `node --test tests/*.test.cjs` both pass in the corrected workflow.
- **AC-4:** Before marking the bug resolved, run the corrected hosted
  deterministic validation gate and record its workflow URL and commit SHA.
  Run `./tests/run-all.sh --unit` with Python 3.12 and verify at least 90%
  `vdl.py` line coverage. Apply the repository's version-bump rule to the fix.

### Verification on 2026-11-10

Local checks used an isolated Python 3.12.14 environment with `requirements.txt`
installed and Node.js 24.8.0. The working tree is based on commit
`0285001fad188eb2616b8a68339466b5ef5e04e3`.

- **AC-1: passed locally.** The selected Python interpreter imported `flask`,
  `yt_dlp`, and `vdl` after dependency installation.
- **AC-2: passed.** `node --test tests/tag-identity-parity.test.cjs` exited
  with code 0; both tests passed. The server import, Unicode comparisons, and
  subprocess-exit assertion remain intact.
- **AC-3: passed locally.** `node scripts/check-codeql-pins.cjs` exited with
  code 0. `node --test tests/*.test.cjs` exited with code 0; all 247 tests passed.
- **AC-4: hosted gate not_run; local unit gate passed.**
  `VDL_PYTHON=/tmp/vdl-bug-0082-WHk88Z/python/bin/python ./tests/run-all.sh --unit`
  exited with code 0 under Python 3.12.14: 851 tests ran, 9 were skipped, and
  `vdl.py` line coverage was 92.6% (7788/8412; minimum 90.0%). `VERSION` is
  incremented from `0.64.0` to `0.64.1`. The corrected hosted deterministic
  validation gate is `not_run`: the working-tree changes have not been pushed,
  so no hosted workflow URL or tested commit SHA is available. Record that
  evidence before marking the bug resolved.
