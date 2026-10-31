## 73. Player playback-event sequence fails in GitHub Actions

**Severity:** Medium — blocks the browser-test CI gate; a user-visible
playback defect is not established.

**Status:** Fix implemented locally in version `0.50.8` on 2026-10-31.
Focused playback validation and the unit coverage gate pass. Full-browser
acceptance remains pending because of the separate Library retry failure
recorded below; hosted GitHub Actions confirmation is also outstanding.

Source reviewed at local commit `6777fba`, version `0.50.7`. The workflow
URL and failing commit SHA were not supplied, so the CI revision has not
been independently confirmed. Failure frequency is unknown.

**Related:** [Bug 0070 — Player controls and playback actions](bug-0070-player-controls-stay-visible-and-lack-direct-playback-actions.md)
introduced this behavior and test. [Bug 0074](bug-0074-fullscreen-player-idle-slide-endpoint-fails-in-github-actions.md)
records the other failure from the same run: **2 failed, 407 passed (7.6m)**,
with process exit code **1**.

### Reported behavior

The test `one video-surface click uses the Space playback action exactly once`
starts at [`tests/browser/player-interactions.spec.cjs:22`](../tests/browser/player-interactions.spec.cjs#L22)
and fails at its final event-sequence assertion:

```text
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 0

  Array [
    "pause",
    "play",
    "pause",
-   "play",
  ]

  38 |     await page.keyboard.press('Space');
  39 |     await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.paused)).toBe(false);
> 40 |     expect(await page.evaluate(() => window.__interactionEvents)).toEqual(['pause', 'play', 'pause', 'play']);

at /home/runner/work/VDL/VDL/tests/browser/player-interactions.spec.cjs:40:67
```

The earlier click assertions passed: one click paused playback and recorded
`pause`; another resumed it and recorded `play`. Space then paused playback,
and the final Space changed `video.paused` back to `false`. At the final
snapshot, the listener had recorded only `['pause', 'play', 'pause']`.
The log shows a missing final event at assertion time, with no extra toggle
recorded. It does not show that the last Space failed to resume playback or
that the `play` event never arrived afterward.

### Reproduction scenario

1. Seed the finished `interaction-one` video using the real `crossfade`
   fixture, open it, and wait for playback and a positive media clock.
2. Attach `play` and `pause` listeners to `#playerVideo`, recording event
   names in `window.__interactionEvents`.
3. Click the video once, wait for `paused === true`, and assert `['pause']`.
4. Click again, wait for `paused === false`, and assert `['pause', 'play']`.
5. Focus `#playerContainer`, press Space, and wait for `paused === true`.
6. Press Space again, wait for `paused === false`, then immediately compare
   the recorded array with `['pause', 'play', 'pause', 'play']`.

**Expected:** Each click and Space action toggles playback exactly once,
and the test reliably observes the corresponding four media events.

**Actual in CI:** The final state check passes, but the immediate event-array
comparison lacks the last `play` event.

After installing the dependencies in [`tests/README.md`](../tests/README.md),
run from the repository root:

```bash
python3 tests/browser/run.py player-interactions.spec.cjs \
    --grep 'one video-surface click uses the Space playback action exactly once' \
    --repeat-each=20
```

Set `VDL_PYTHON` if fixture dependencies are in another Python environment.
The checked-in validation workflow installs Chromium; the Playwright config
defaults to headless Chromium and one worker.

### Evidence and investigation

The supplied log lists these artifacts; their contents were not supplied or
inspected:

```text
test-results/player-interactions-one-vi-c8145-layback-action-exactly-once/test-failed-1.png
test-results/player-interactions-one-vi-c8145-layback-action-exactly-once/error-context.md
test-results/player-interactions-one-vi-c8145-layback-action-exactly-once/trace.zip
```

After downloading the artifacts, open the trace from `tests/browser`:

```bash
npx playwright show-trace test-results/player-interactions-one-vi-c8145-layback-action-exactly-once/trace.zip
```

**Investigation hypothesis:** The immediate array assertion may run after
the media state changes but before the corresponding media event is
dispatched. Polling `paused` does not explicitly wait for the event recorder
to update. The same observation pattern appears after the two clicks.
This is a suspected synchronization race, not a confirmed root cause.

In [`static/app.js`](../static/app.js#L4304), the primary video-surface click
handler calls `togglePlayerPlayback`, as does the Space branch of
`handlePlayerShortcut`. The resume path ultimately calls `video.play()`
through `playPlayerVideo`. Capture timestamps for input, action calls,
`paused`, media events, and assertion snapshots to establish whether dispatch
is merely delayed, an action is duplicated, or playback changes again.

### Acceptance criteria

- Establish event/state ordering using the CI trace or an equivalent
  controlled reproduction before classifying this as a test or player bug.
- Synchronize event assertions with observed media events while retaining
  the exact sequence and real playback-state checks after both clicks and
  both Space actions. Verify that duplicate toggles still fail the test.
- Pass repeated focused runs and the complete browser suite without
  arbitrary sleeps, skipped coverage, or weakened event-count assertions.
- Any eventual code fix receives its own version bump and passes
  `./tests/run-all.sh --unit` with at least **90% `vdl.py` line coverage**,
  plus relevant browser checks, before this report is marked resolved.

### Controlled reproduction and fix

The original focused test passed **20/20** local Chromium runs. A temporary
real-media probe then dispatched the final Space `keydown` through the actual
player shortcut handler and took the state/event snapshot in the same browser
task. All **3/3** runs reproduced the reported mismatch:

```text
paused: false
events: ["pause", "play", "pause"]
```

The native final `play` event arrived **0.5–3 ms later**, completing the exact
four-event sequence. This establishes that playback state can change before
the queued media event reaches the recorder. It confirms a test
synchronization defect under controlled scheduling; the hosted CI artifacts
remain unavailable, and no player behavior change is needed.

The test now polls for the exact cumulative event array after **each** of the
two clicks and two Space presses, including a new three-event assertion after
the first Space. All four real `paused` checks remain. No sleeps, event-count
relaxation, or expected-failure markers were added.

The controlled probe passes with event polling. Temporary mutation checks
injected two extra calls to the real playback toggle on the first click and
the final Space respectively. Both preserved the expected final paused state
but failed the exact event-array assertions, confirming that the test still
rejects duplicate actions. The temporary probe and mutations were removed.

Local validation uses Python 3.12 and the locked headless Chromium tooling:

```text
python3 tests/browser/run.py player-interactions.spec.cjs \
    --grep 'one video-surface click uses the Space playback action exactly once' \
    --repeat-each=20
20 passed (41.6s)

./tests/run-all.sh --unit
Ran 397 tests; OK (skipped=6)
vdl.py line coverage: 92.0% (5139/5588; minimum 90.0%)

./tests/run-all.sh --browser
1 failed, 408 passed (10.9m)
```

All player-interaction cases passed in the full run. Its sole failure was
`initial Library failures show loading then error, preserve Current, and recover`
in `live-refresh-overload.spec.cjs:182`: the retry count was **4**, expected
**3**. That unchanged test runs before the modified player-interaction test;
the application code is also unchanged. An isolated five-run repeat reproduced
the same failure **2/5** times (**3 passed**). No tests were skipped or relaxed
to obtain a clean browser result. Complete-browser acceptance remains pending
until this separate retry failure is addressed.
