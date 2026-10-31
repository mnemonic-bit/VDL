## 74. Fullscreen player idle-slide endpoint fails in GitHub Actions

**Severity:** Medium — blocks the browser-test CI gate; incomplete hiding
of the toolbar in normal use is not established.

**Status:** Resolved locally in version `0.50.9`, validated on 2026-10-31.
Reported on 2026-10-31. Hosted GitHub Actions confirmation remains outstanding.

Source reviewed at local commit `6777fba`, version `0.50.7`. The workflow
URL and failing commit SHA were not supplied, so the CI revision has not
been independently confirmed. Failure frequency is unknown.

**Related:** [Bug 0072 — Player idle-transition sampling](bug-0072-player-idle-transition-sampling-fails-in-github-actions.md)
records a different assertion failure in the overlay variant and its local
repair. This report concerns the fullscreen slide's final displacement,
before the intermediate-sample assertions. It does not establish a recurrence
of the original Bug 0072 sampling failure.
[Bug 0070](bug-0070-player-controls-stay-visible-and-lack-direct-playback-actions.md)
introduced the behavior. [Bug 0073](bug-0073-player-playback-event-sequence-fails-in-github-actions.md)
records the other failure from this run: **2 failed, 407 passed (7.6m)**,
with process exit code **1**.

### Reported behavior

The test `idle controls fade and slide, reveal and reset, with no-preference motion (fullscreen)`
starts at [`tests/browser/player-interactions.spec.cjs:76`](../tests/browser/player-interactions.spec.cjs#L76)
and fails when checking the hidden toolbar's vertical displacement:

```text
Error: expect(received).toBeGreaterThanOrEqual(expected)

Expected: >= 95.9
Received:    95.6286

  136 |             duration: getComputedStyle(bar).transitionDuration,
  137 |         }));
> 138 |         expect(hidden.translateY).toBeGreaterThanOrEqual(hidden.height - 0.1);

at /home/runner/work/VDL/VDL/tests/browser/player-interactions.spec.cjs:138:35
```

The reported threshold implies a toolbar height of **96 CSS pixels**.
Its measured translation is **95.6286 pixels**, about **0.3714 pixels** short
of its full height and **0.2714 pixels** below the allowed threshold.
This is a single sample; the log does not show whether the transform later
reached its endpoint or remained short.

The preceding assertions passed: the idle visibility class was removed,
header opacity reached zero, and both header and controls had
`pointer-events: none`. The later transition-property, intermediate-sample,
hit-testing, reveal/reset, and keyboard-focus assertions were not reached
in this failing case.

### Reproduction scenario

1. Emulate `prefers-reduced-motion: no-preference`, seed a finished video
   using the real `fit-16-9` fixture, and open it during playback.
2. Focus `#playerContainer`, press `f` to enter fullscreen, verify the
   fullscreen element, and focus the container again.
3. Hover over `#playerVideo`. Install transition-event recording and the
   current midpoint-sampling observer, which temporarily pauses/seeks each
   relevant CSS transition before restoring its time and resuming it.
4. Wait 2.2 seconds, check visibility, and wait for the idle visibility class
   to disappear. Wait for header opacity zero and check pointer-event styles.
5. Read `#playerControls`' computed transform and bounding height once.
   Require `translateY >= height - 0.1`.

**Expected:** The toolbar slides completely outside the media area, and the
test waits for that toolbar transition to finish before verifying its endpoint.

**Actual in CI:** The one-time displacement sample is just below the expected
endpoint even though the earlier hidden-state checks passed.

After installing the dependencies in [`tests/README.md`](../tests/README.md),
run from the repository root:

```bash
python3 tests/browser/run.py player-interactions.spec.cjs \
    --grep 'idle controls fade and slide, reveal and reset, with no-preference motion \(fullscreen\)' \
    --repeat-each=20
```

Set `VDL_PYTHON` if fixture dependencies are in another Python environment.
The checked-in validation workflow installs Chromium; the Playwright config
defaults to headless Chromium and one worker.

### Evidence and investigation

The supplied log lists these artifacts; their contents were not supplied or
inspected:

```text
test-results/player-interactions-idle-c-c3daf-eference-motion-fullscreen-/test-failed-1.png
test-results/player-interactions-idle-c-c3daf-eference-motion-fullscreen-/error-context.md
test-results/player-interactions-idle-c-c3daf-eference-motion-fullscreen-/trace.zip
```

After downloading the artifacts, open the trace from `tests/browser`:

```bash
npx playwright show-trace test-results/player-interactions-idle-c-c3daf-eference-motion-fullscreen-/trace.zip
```

**Investigation hypothesis:** The test may read the transform while the
toolbar transition is still running. In [`static/styles.css`](../static/styles.css#L1188),
the header fades over **150 ms**, while the controls slide over **200 ms**
to `translateY(100%)`. Waiting for header opacity zero does not explicitly
wait for the longer toolbar animation. Removing the idle class and disabling
pointer events likewise do not prove that the slide has finished.

The current test also restores and resumes each sampled transition
independently. Capture toolbar animation time, play state, computed timing,
height, and transform at the failed assertion and after completion to
distinguish early observation from a persistent layout or transform defect.
The supplied log alone does not establish the cause or implicate that observer.

### Acceptance criteria

- Establish whether the failing transform is an intermediate value or a
  settled endpoint, using CI artifacts or an equivalent controlled reproduction.
- Verify the toolbar's own completion before asserting its final displacement.
  Retain a strict full-hide check; merely increasing the pixel tolerance
  must not conceal a toolbar that remains partly over the video.
- Preserve intermediate fade/slide checks, the three-second idle behavior,
  hit testing, pointer reveal/reset, keyboard access, reduced-motion behavior,
  and stable fullscreen video bounds.
- Pass repeated runs of all four overlay/fullscreen and normal/reduced-motion
  idle scenarios, plus the full browser suite, without arbitrary sleeps or
  skipped assertions. A deliberately incomplete slide must still fail.
- Any eventual code fix receives its own version bump and passes
  `./tests/run-all.sh --unit` with at least **90% `vdl.py` line coverage**,
  plus relevant browser checks, before this report is marked resolved.

### Local reproduction and repair — 2026-10-31

The unmodified fullscreen scenario passed one local run. A controlled run then
held the real toolbar transform at **175 ms of its 200 ms duration**, after the
midpoint observer restored it. The existing header-opacity and pointer-events
checks passed, but the displacement assertion failed: **95.133 px**, below the
**95.9 px** minimum for the **96 px** toolbar. Finishing that same transition
produced a translation of exactly **96 px**. This reproduces an intermediate
measurement rather than a persistent transform or layout defect; the original
hosted failure's animation state remains unavailable.

The shared idle-scenario test now awaits the toolbar's own transform transition
through its Web Animations `finished` promise before reading the endpoint. If
the transition has already finished, or reduced motion disables it, there is
no active transform to await. The original strict displacement assertion and
all intermediate-sampling, idle-delay, reveal/reset, hit-testing, keyboard,
reduced-motion, and video-bound checks remain unchanged. No sleep or larger
pixel tolerance was added.

Two temporary fault injections checked the repair:

- Slowing the real toolbar transition to **0.2× playback rate** still passed
  the entire fullscreen idle scenario with the new completion wait.
- Changing the settled transform to `translateY(99%)` still failed the strict
  endpoint assertion: **95.04 px**, below **95.9 px**. Waiting for completion
  does not conceal an incomplete slide.

Both injections and the diagnostic logging were removed before validation.

Validation:

- Python 3.12: `VDL_PYTHON=/path/to/python3.12 ./tests/run-all.sh --unit`
  passed, **397 tests**, six expected skips, **92.0% `vdl.py` line coverage**
  (5,139 of 5,588 executable lines; minimum 90%).
- `python3 tests/browser/run.py player-interactions.spec.cjs
  --grep 'idle controls fade and slide' --repeat-each=5` passed **20/20**
  scenarios: five runs each of overlay/fullscreen and normal/reduced motion.
- `./tests/run-all.sh --browser` passed the full suite: **409 tests** (11.1m).
