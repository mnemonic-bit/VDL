## 37. [Resolved] SSE bursts could cancel History insertion animations before they started

**Severity:** Low

**Status:** Resolved and verified in version `0.16.2` on 2026-09-27.

The Main GitHub Actions job intermittently failed the History insertion
animation regression:

```text
Expected: > 0
Received:   0
Timeout 3000ms exceeded while waiting on the predicate
```

Creating a test row performs an insert followed by an update. Each database
write publishes an SSE `change` event, so the client can receive two
`/api/history` responses in one rendering interval. The first response inserts
the History card, adds `item-fade-in`, and records the ID as rendered. The
second response can then replace the complete list before the browser emits
`animationstart`. Because the ID is already in `_renderedHistoryIds`, the
replacement is not animated. The original animation disappears with its
detached element and the final card becomes visible without the intended
space-expansion transition.

The race is observable outside the test whenever several lifecycle writes are
published faster than the browser can paint. Serialising all history requests
was rejected during diagnosis because it turned an event burst into a long
queue of repeated card animations and temporarily blocked interactions with
neighboring cards.

**Expected:** A newly inserted Current or History row must get one opportunity
to begin its entrance animation even if reconciliation replaces its first DOM
node before the next frame. Once `animationstart` has fired, later live updates
must not restart the animation.

**Reproduction:** Listen for `animationstart` on History cards, create one
finished fixture row, and wait for the recorded animation frames. Before the
fix, the insert/update SSE pair could replace the first animated node before
the event and leave the recorded animation count at zero.

**Resolution:** The client tracks pending insertion animations separately for
Current and History IDs. An ID remains pending until its card emits
`animationstart`; reconciliation during that narrow pre-start window reapplies
the animation to the replacement node. The pending marker is cleared on start,
completion, or removal, preventing already-running animations from being
restarted by later events. Multi-card Info tests now close each fixed-position
popover before opening the next one instead of depending on a canceled
animation's temporary clipping.

Permanent coverage: `tests/browser/live-updates.spec.cjs` and
`tests/browser/history-actions.spec.cjs`. The insertion and Stop regressions
passed 20 consecutive focused runs, the affected multi-card tests passed 10
consecutive runs, and `./tests/run-all.sh --all` passed the unit, 61-test
browser, real-media, and shipping-container tiers.
