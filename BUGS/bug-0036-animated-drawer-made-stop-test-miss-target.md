## 36. [Resolved] Animated drawer made the Stop reconciliation test miss its target

**Severity:** Low

**Status:** Resolved and verified in version `0.16.2` on 2026-09-27.

The Main GitHub Actions job failed the deterministic regression for Bug 28:

```text
Expected: 1
Received: 0
Timeout 3000ms exceeded while waiting on the predicate
```

The application guard was not bypassed. The test opened Current Downloads and
immediately read the Stop button's bounding box while the 280 ms drawer
entrance was still moving in from the right. In the failing trace, the button's
centre was at approximately `x=1375` in a 1280-pixel-wide viewport. The raw
mouse sequence therefore never pressed the visible Stop control, so no browser
click was synthesized and no cancellation request could be observed.

This became visible after the drawer entrance was added. A locator assertion
can find the button while an ancestor is still moving; it does not guarantee
that a manually calculated pointer coordinate represents the button's settled
position.

**Expected:** The regression must begin its raw pointer sequence on the settled
Stop button, force reconciliation between pointer down and pointer up, and
observe exactly one `POST /api/stop/<id>` request. It must continue to exercise
the application behavior fixed by Bug 28 rather than pass through an ordinary
locator click.

**Reproduction:** Open the animated Current Downloads drawer, immediately take
the Stop button's bounding box, move the raw pointer to that early centre, then
perform pointer down, `fetchHistory()`, and pointer up. On a sufficiently slow
CI runner, the early coordinate remains outside the viewport and the request
counter stays at zero.

**Resolution:** The test now uses `stop.hover()` before the raw `mouse.down()`
and `mouse.up()` sequence. Playwright waits for the locator to be actionable
and stable, placing the pointer over the settled button while preserving the
forced mid-press reconciliation that the regression is intended to cover.

Permanent coverage: `tests/browser/live-updates.spec.cjs`. The two originally
failing Main-job tests passed 20 consecutive focused runs, and the complete
61-test browser suite passed as part of `./tests/run-all.sh --all`.
