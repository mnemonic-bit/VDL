## 65. [Resolved] Endless scrolling stalls before the final batch in GitHub Actions

**Severity:** Medium — blocks the browser-test CI gate; production impact is
not established.

**Status:** Fixed locally in version `0.49.7` on 2026-10-28. The original
failing commit, application version, workflow URL, browser, and failure
frequency were not supplied. The full browser gate has a separate
live-refresh request-count failure, detailed below.

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
    --grep 'endless scrolling reveals the next batch at the end of the library' \
    --repeat-each=10
```

Set `VDL_PYTHON` if the fixture dependencies are in another Python environment.

### Original CI evidence

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

### Controlled reproductions and causes

There are two timing cases with the same 20-versus-21 symptom.

**Scrolling before the second batch has expanded.** A local full-suite run
captured the original failure even after fixing the pending-refresh case
below. Its trace shows the second batch still carrying `item-fade-in` when
the count first reaches 20, immediately followed by the test's raw DOM
`scrollIntoView()`. The failure screenshot shows the viewport above the settled
end of the Library. DOM insertion does not mean the entrance animation's layout
is ready: the sentinel moves farther down as the new cards expand. The loader
correctly rejects that transient intersection once the layout has settled.

The deterministic layout regression pauses only the second batch's real
entrance animations, scrolls into its collapsed end, and then finishes them.
It verifies that the settled sentinel is below the prefetch margin and the
Library still contains 20 cards, then scrolls to the expanded end and requires
all 21 cards. Both observer and fallback paths are covered.

**A valid scroll during a pending refresh.**

`fetchHistory()` waits for both Library and Current Downloads. Library can
render its next ten cards before Current Downloads finishes. A scroll to the
new end during that interval reaches `loadNextEndlessHistoryBatch()` while
`historyEndlessLoadPending` is still true, so the loader discards it. Once
Current Downloads completes, the guard clears, but nothing checks the sentinel
again. An observer need not deliver another entry while the sentinel remains
intersecting; the fallback likewise requires another scroll event.

The new browser regression holds the Current Downloads response after Library
renders 20 cards, waits for their real entrance animations to finish, then
scrolls to the new sentinel. It confirms delivery through the native observer
or dispatches the fallback scroll event, verifies the load is still pending,
and releases Current Downloads. Before the fix, both cases fail at the final
assertion with **Expected: 21, Received: 20**, matching the reported symptom.
This is an equivalent controlled reproduction; the original CI artifacts were
not available to establish the exact ordering in that run.

Run the controlled reproductions with:

```bash
VDL_PYTHON="$PWD/.venv/bin/python" python3 tests/browser/run.py \
    history-pagination.spec.cjs --grep 'final-batch trigger|second batch'
```

### Repair

The original browser test now waits for the inserted cards' entrance animations
to finish before its final scroll, then uses Playwright's stable-element
`scrollIntoViewIfNeeded()`. Its initial-10, final-21, and exhausted-sentinel
assertions remain intact; no arbitrary sleep or timeout increase is used.

The loader also rechecks the sentinel after every completed batch while retaining
the pending guard. Each iteration waits for entrance animations and checks the
current mode, remaining count, layout box, and viewport bounds. It stops when
the sentinel leaves the prefetch region or the Library is exhausted. This
recovers a scroll delivered during the pending refresh without overlapping
loads, arbitrary delays, or premature loads from collapsed cards.

The pending-refresh regressions require the initial ten cards, all 21 final
cards in order without duplicates, and a hidden exhausted sentinel. Bugs
0055/0057's animation assertions are unchanged.

### Validation

The Python 3.12 unit gate passes **384 tests** (six skipped) with **91.6%**
`vdl.py` line coverage (5,064/5,527 executable lines; minimum 90%). All ten
pagination tests pass three consecutive Chromium runs (**30 pagination checks**).
The focused run also includes three passing repeats of the tag-dialog test
that timed out in the first full run (**33 total checks**).

The final full Chromium run passes all ten pagination tests, including the
original failure and both observer/fallback timing regressions. Overall it
finishes with **320 passed, one failed**: the unchanged test `initial Library
failures show loading then error, preserve Current, and recover` observes four
requests where it expects three. A comparison serving unchanged baseline
JavaScript from commit `3a4ea79` in the original fixture reproduces that same
failure in three of five runs. An isolated baseline worktree passes 25 repeats,
so that separate failure also depends on fixture/environment timing. The full
browser gate is therefore still red; it is not reported as passing here.

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
