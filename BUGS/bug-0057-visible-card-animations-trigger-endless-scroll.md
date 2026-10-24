## 57. [Resolved] Visible card animations trigger endless scrolling before user scrolling

**Severity:** Low

**Status:** Fixed locally in version `0.46.7` on 2026-10-24. Confirmation on
the hosted GitHub Actions runner remains outstanding.

GitHub Actions again failed the original endless-scroll test with 20 Library
cards where it expected the initial batch of 10. The run included the
hidden-card fix from [bug 0055](bug-0055-hidden-card-animations-trigger-endless-scroll.md)
and finished with one failed and 232 passed browser tests.

### Reproduction and cause

Visible cards can also briefly expose the sentinel. Their entrance animation
starts at zero height even when the expanded height was measured correctly.
An observer callback during that frame immediately increased the visible count
to 20. The earlier fix only covered cards first measured while hidden.

The deterministic browser reproduction pauses the real entrance animations at
their collapsed first frame and waits for a native observer to see the
sentinel. It then finishes the animations and checks the settled card count.
Before this fix, two consecutive runs failed with the reported 10-versus-20
assertion. A targeted probe captured valid expanded card heights of about
195 pixels, current card heights of zero, and the sentinel inside the viewport
after the loader had already increased the count to 20.

Run the regression with:

```bash
VDL_PYTHON="$PWD/.venv/bin/python" python3 tests/browser/run.py \
    history-pagination.spec.cjs --grep 'visible card animations'
```

### Repair

The endless-scroll loader waits for Library entrance animations to settle,
including animations introduced by a concurrent refresh. It then rechecks
endless mode, remaining items, the sentinel's layout box, and its current
position before increasing the visible count. This also rejects stale
intersection entries after navigation or layout changes. The pending-load
guard covers the wait and refresh and is always cleared in `finally`.

Both the observer and scroll-event fallback use this check and the same
160-pixel prefetch margin. The browser regressions exercise both paths and
verify that subsequent scrolling still loads another batch.

The Python 3.12 unit gate passes 319 tests (five skipped) with **91.4%**
`vdl.py` line coverage (4,882/5,342 executable lines; required minimum 90%).
All six pagination tests pass five consecutive runs (30 checks), including the
original GitHub failure and both animation regressions. The full Chromium
browser suite passes all **235 tests**.
