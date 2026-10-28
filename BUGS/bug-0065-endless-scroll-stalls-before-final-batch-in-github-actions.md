## 65. Endless scrolling stalls before the final batch in GitHub Actions

**Severity:** Medium — blocks the browser-test CI gate; production impact is
not established.

**Status:** Open. Reported on 2026-10-28 from GitHub Actions output. Not
independently reproduced. The failing commit, application version, workflow
URL, browser, and failure frequency were not supplied.

**Related:** [Bug 0055 — Hidden card animations trigger endless scrolling](bug-0055-hidden-card-animations-trigger-endless-scroll.md)
and [Bug 0057 — Visible card animations trigger endless scrolling](bug-0057-visible-card-animations-trigger-endless-scroll.md).
Those failures loaded 20 cards instead of the initial 10. This failure occurs
later: the final batch never appears within the assertion timeout.

### Reported behavior

The GitHub Actions browser suite finished with **1 failed, 278 passed (5.0m)**
and process exit code **1**. The failing test is
`endless scrolling reveals the next batch at the end of the library`, starting
at [`tests/browser/history-pagination.spec.cjs:68`](../tests/browser/history-pagination.spec.cjs#L68).

```text
Error: expect(locator).toHaveCount(expected) failed

Locator:  locator('#historyList [data-row-id]')
Expected: 21
Received: 20
Timeout:  3000ms

Call log:
  - Expect "toHaveCount" with timeout 3000ms
  - waiting for locator('#historyList [data-row-id]')
    10 × locator resolved to 20 elements
       - unexpected value "20"

  93 |         await sentinel.evaluate(element => element.scrollIntoView());
  94 |     }
> 95 |     await expect(cards).toHaveCount(21);
     |                         ^
  96 |     await expect(sentinel).toBeHidden();
```

The earlier assertions passed: the initial batch contained 10 cards and
scrolling loaded at least 20. The final assertion continued to see 20 cards.
The subsequent sentinel-hidden assertion was not reached, so the log does
not establish the sentinel's final visibility or viewport position.

### Reproduction scenario

The existing browser test performs these steps in the isolated fixture:

1. Set the viewport to **800 × 400** and seed **21 finished entries** with IDs
   `endless0001` through `endless0021`.
2. Refresh, open Settings, select the `endless` page-size preference, save,
   and return using **Back to videos**.
3. Verify 10 cards, a hidden numbered pager, and a visible endless sentinel.
4. Call `scrollIntoViewIfNeeded()` on `#historyEndlessSentinel` and wait for
   at least 20 cards.
5. If the sentinel is visible, call its DOM `scrollIntoView()` method.
6. Expect all 21 cards, then expect the sentinel to be hidden.

**Expected:** Scrolling to the end reveals the remaining entry, bringing the
rendered count to 21, and hides the sentinel once the Library is exhausted.

**Actual in CI:** The rendered count remains 20 throughout the final
three-second assertion window, causing the browser-test job to fail.

After installing the documented browser-test dependencies, run this focused
reproduction from the repository root:

```bash
python3 tests/browser/run.py history-pagination.spec.cjs \
    --grep '^endless scrolling reveals the next batch at the end of the library$' \
    --repeat-each=10
```

Set `VDL_PYTHON` if the fixture dependencies are in another Python environment.
This command was not run while writing the report; repeatability and any
dependence on full-suite execution remain unknown.

### Evidence and investigation needed

The supplied log lists these artifacts:

```text
test-results/history-pagination-endless-7d584-h-at-the-end-of-the-library/test-failed-1.png
test-results/history-pagination-endless-7d584-h-at-the-end-of-the-library/error-context.md
test-results/history-pagination-endless-7d584-h-at-the-end-of-the-library/trace.zip
```

Their contents were not supplied or inspected. After downloading them, open
the trace from the browser-test directory with:

```bash
npx playwright show-trace test-results/history-pagination-endless-7d584-h-at-the-end-of-the-library/trace.zip
```

The current `loadNextEndlessHistoryBatch()` in
[`static/app.js`](../static/app.js) ignores triggers while a load is pending,
waits for entrance animations, rechecks the sentinel's current bounds, then
increases the visible count and awaits `fetchHistory()`. An IntersectionObserver
triggers it, with a scroll-event fallback when that API is unavailable.
These are investigation points, not an established explanation of this failure.

- Capture sentinel bounds, scroll position, active entrance animations,
  `historyEndlessLoadPending`, visible-count state, and total count around
  the transition from 10 to 20 cards and the second scroll.
- Check observer delivery and whether a second trigger arrives during a
  pending load or before the new layout settles. Determine whether a later
  trigger or recheck occurs after that load completes.
- Inspect Library requests and responses to distinguish a missing trigger,
  delayed or failed request, incorrect limit/total, and rendering failure.
- Compare repeated focused runs with the full CI suite. Establish whether
  the application misses a valid scroll or the test scrolls before the
  next batch's layout is ready. The log alone does not prove either cause.

### Acceptance criteria

- Capture and explain the 20-versus-21 failure using the CI artifacts or an
  equivalent controlled reproduction.
- The existing test passes repeatedly and within the full browser suite,
  preserving its initial-10, final-21, and exhausted-sentinel assertions.
- Both observer and scroll-fallback paths can load successive batches,
  including a final partial batch, without duplicate or missing entries.
- Preserve bugs 0055 and 0057's protections against premature loading during
  hidden or visible card animations.
- Correct the demonstrated cause without skipping the test, weakening its
  assertions, or adding arbitrary sleeps.
- Any eventual code fix receives its own version bump and passes
  `./tests/run-all.sh --unit` with at least **90% `vdl.py` line coverage**,
  plus the relevant browser checks, before this report is marked resolved.

This report changes documentation only; no fix or version bump is included.
