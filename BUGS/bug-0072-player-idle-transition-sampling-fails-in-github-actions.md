## 72. Player idle-transition sampling fails in GitHub Actions

**Severity:** Medium — blocks the browser-test CI gate; impact on visible
player animations is not established.

**Status:** Open. Reported on 2026-10-30 after pushing the committed version
to GitHub. Source reviewed at local commit `1674bbe`, version `0.50.5`.
The workflow URL and failing commit SHA were not supplied, so that commit
has not been independently confirmed as the CI revision. No local browser
reproduction was performed for this report; failure frequency is unknown.

**Related:** [Bug 0070 — Player controls and playback actions](bug-0070-player-controls-stay-visible-and-lack-direct-playback-actions.md)
introduced the idle fade/slide behavior and its browser coverage.

### Reported behavior

GitHub Actions finished the browser suite with **1 failed, 392 passed
(8.6m)** and process exit code **1**. The reported failure is
`idle controls fade and slide, reveal and reset, with no-preference motion (overlay)`,
starting at [`tests/browser/player-interactions.spec.cjs:76`](../tests/browser/player-interactions.spec.cjs#L76).

```text
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false

  128 |             for (const target of ['header', 'playerControls']) {
  129 |                 expect(transitions.some(([name, kind, value]) => name === target && kind === 'sample'
> 130 |                     && value > 0 && value < 1)).toBe(true);
      |                                                 ^
  131 |             }
  132 |         }
  133 |         // Hit testing at the old bar position must reach the media beneath it.

at /home/runner/work/VDL/VDL/tests/browser/player-interactions.spec.cjs:130:49
```

The test requires an intermediate value strictly between zero and one for
both the header fade and the bottom controls' normalized slide distance.
At least one target had no qualifying sample. The log does not identify
which target failed or show the recorded `window.__idleAnimations` array.

Earlier assertions reached the hidden state: the idle visibility class was
removed, header opacity reached zero, both areas stopped intercepting pointer
events, and the bottom controls moved down by at least their own height.
The test also recorded `transitionrun` entries for the header's `opacity`
and the bottom controls' `transform`. These checks passed before the failure.
The subsequent hit-testing, pointer reveal/timer reset, and keyboard-focus
checks were not reached in this case.

### Reproduction scenario

The existing test performs these steps in its isolated real-media fixture:

1. Emulate `prefers-reduced-motion: no-preference` and seed a finished video
   using the `fit-16-9` fixture.
2. Open the video, wait for playback, focus `#playerContainer`, and keep the
   player in overlay mode.
3. Hover over `#playerVideo` and install a `transitionrun` listener for
   `.player-chrome` and `#playerControls`.
4. For each transition event, record its target/property, then schedule two
   nested `requestAnimationFrame` callbacks. In the second callback, sample
   the header's opacity or the bottom bar's vertical translation divided by
   its height.
5. Wait 2.2 seconds, verify both areas are still visible, and wait for the
   idle visibility class to disappear. Verify hidden styles and displacement.
6. Require the expected transition events and at least one sample strictly
   between zero and one for each target.

**Expected:** With motion enabled, both areas animate through intermediate
states and the browser test reliably verifies that behavior in CI.

**Actual in CI:** The intermediate-sample assertion returns false for at
least one target, failing the browser gate despite the preceding event and
hidden-state checks passing.

After installing the documented browser-test dependencies, run from the
repository root:

```bash
python3 tests/browser/run.py player-interactions.spec.cjs \
    --grep 'idle controls fade and slide, reveal and reset, with no-preference motion \(overlay\)' \
    --repeat-each=20
```

Set `VDL_PYTHON` if the fixture dependencies are in another Python environment.
The checked-in CI workflow uses headless Chromium on Ubuntu 24.04, Python
3.12, Node.js 24.8.0, and the locked Playwright dependency. Its complete
deterministic gate runs `./tests/run-all.sh --all`.

### Evidence and investigation

The supplied log lists these artifacts:

```text
test-results/player-interactions-idle-c-62b99--preference-motion-overlay-/test-failed-1.png
test-results/player-interactions-idle-c-62b99--preference-motion-overlay-/error-context.md
test-results/player-interactions-idle-c-62b99--preference-motion-overlay-/trace.zip
```

Their contents were not supplied or inspected. After downloading them, open
the trace from `tests/browser` with:

```bash
npx playwright show-trace test-results/player-interactions-idle-c-62b99--preference-motion-overlay-/trace.zip
```

**Cause remains unconfirmed.** The nested animation-frame sampling assumes
its callbacks run while each transition is still between endpoints. Delayed
frame delivery on a busy runner could miss that interval; this is an
investigation hypothesis, not a demonstrated CI timing defect. A real
animation regression must also be considered. Transition events and final
styles alone do not establish that intermediate frames rendered correctly.

Capture the failing target, full sample array, transition durations, and
event/sample timestamps in a reproduction. Determine whether the sample is
missing, reaches an endpoint, or has another out-of-range value. Use the
trace or equivalent controlled timing evidence to distinguish a rendering
defect from an observation race before choosing a repair.

### Acceptance criteria

- Explain the missing intermediate sample using the CI artifacts or an
  equivalent controlled reproduction, identifying the affected target and
  event/frame ordering.
- Verify real intermediate fade and slide states reliably without assuming
  that a fixed number of animation frames lands inside a transition.
  Preserve the three-second idle behavior, hidden-state styles, hit testing,
  pointer reveal/reset, and keyboard access checks.
- Pass repeated focused runs and the full browser suite, including overlay
  and fullscreen with both normal and reduced motion. Do not resolve this
  by skipping the test, dropping intermediate-state coverage, or merely
  adding arbitrary sleeps or increasing timeouts.
- Any eventual code fix receives its own version bump and passes
  `./tests/run-all.sh --unit` with at least **90% `vdl.py` line coverage**,
  plus the relevant browser checks, before this report is marked resolved.
