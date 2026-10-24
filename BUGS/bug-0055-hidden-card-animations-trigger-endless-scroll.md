## 55. [Resolved] Hidden card animations trigger endless scrolling on return from Settings

**Severity:** Low

**Status:** Resolved in version `0.46.5` on 2026-10-24.

GitHub Actions intermittently failed the endless-scroll browser test because
the Library already contained 20 cards when the first batch should contain 10.

Cards can arrive through live refreshes while Settings hides the Library.
`animateInsertedItem()` measured those cards without a layout box and stored
`0px` as their expanded animation height. Returning to the Library started
their collapsed entrance animations, briefly exposing the endless-scroll
sentinel. Its observer then loaded another batch before the user scrolled.

The reproduction enables endless scrolling, opens Settings, seeds finished
downloads while the Library is hidden, refreshes the collections, and returns
to the Library. Before the fix, all ten initial cards had `0px` animation
targets and the settled card count was 20 instead of 10.

`animateInsertedItem()` now skips elements without layout boxes and clears
their pending animation markers. Cards received while hidden appear at their
natural size when the Library returns. Visible insertions keep their entrance
animations.

Permanent coverage is in `tests/browser/history-pagination.spec.cjs`. The new
regression checks that hidden cards have no pending entrance animation, that
returning shows ten cards, and that scrolling still loads the next batch.
All four pagination tests passed five consecutive Chromium runs, and the full
Chromium suite passed all 233 tests. The Python 3.12 unit gate passed 319 tests
(five skipped) with **91.4%** `vdl.py` line coverage (4,882/5,342 executable
lines; required minimum 90%).
