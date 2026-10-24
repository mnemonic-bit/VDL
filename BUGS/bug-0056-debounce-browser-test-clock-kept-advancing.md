## 56. [Resolved] Debounce browser test clock kept advancing between explicit time steps

**Severity:** Low

**Status:** Resolved and verified locally in version `0.46.6` on 2026-10-24.
The next GitHub Actions run must confirm the fix on the hosted runner.

GitHub Actions failed `download-options.spec.cjs` in the test
`checking starts during debounce and stays busy until metadata arrives`.
The probe request had already arrived when the test expected it to remain
unsent immediately before the 500 ms debounce deadline:

```text
Error: expect(received).toBeUndefined()
Received: {"_type": "Route", ...}
```

The reported run finished with one failed and 232 passed browser tests.

### Reproduction and cause

Run the focused test repeatedly against the isolated browser fixture:

```bash
VDL_PYTHON="$PWD/.venv/bin/python" python3 tests/browser/run.py \
    download-options.spec.cjs --grep 'checking starts during debounce' \
    --repeat-each=10
```

Before the fix, this reproduced the reported assertion failure in two of ten
local runs. The test installed Playwright's clock but did not pause it. Time
continued advancing during browser interactions and assertions between
`runFor(100)` and `runFor(399)`. The test therefore could cross the application's
500 ms deadline before checking that no probe request existed.

**Expected:** Only explicit clock steps advance the debounce deadline during
this test. No probe is sent after 499 ms; advancing the final millisecond
starts the request, and dependent controls remain disabled until it completes.

**Actual:** Elapsed time depended on how long the intervening test operations
took, allowing a correctly timed probe to fail the pre-deadline assertion.

### Resolution and validation

The test now installs the clock at a fixed timestamp and explicitly pauses it
before filling the URL. Its existing `runFor()` calls control the entire
debounce interval. The application's 500 ms debounce is unchanged.

The corrected test passed **20 consecutive Chromium runs** and also passed
within the full browser run. The Python 3.12 unit gate ran 319 tests with five
skipped and passed with **91.4%** `vdl.py` line coverage (4,882/5,342 executable
lines; required minimum 90%).

The full browser run finished with **232 passed and one separate failure**:
`History info is wider on desktop and points back to its menu` timed out
opening the Info menu. That test passed five consecutive isolated reruns.
Its timeout was not fixed by this change, and the full browser run was not
completely green.
