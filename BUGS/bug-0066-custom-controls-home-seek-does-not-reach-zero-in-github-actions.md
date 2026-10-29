## 66. [Resolved] Custom-controls Home seek does not reach zero in GitHub Actions

**Severity:** Medium — blocks the browser-test CI gate; production impact is
not established.

**Status:** Fixed and verified locally in version `0.50.1` on 2026-10-29.
The original workflow URL, failing commit, browser, and failure frequency
were not supplied. Equivalent local Chromium reproductions confirm the
cause; the original CI artifacts remain uninspected.

### Reported behavior

The browser suite finished with **1 failed, 351 passed (6.8m)** and process
exit code **1**. The failing test is
`pointer dragging previews once and pointer cancellation leaves the real clock alone`,
starting at [`tests/browser/custom-controls.spec.cjs:79`](../tests/browser/custom-controls.spec.cjs#L79).

```text
Error: expect(received).toBeCloseTo(expected)

Expected: 0
Received: 0.03502

Expected precision:    2
Expected difference: < 0.005
Received difference:   0.03502

Call Log:
- Timeout 3000ms exceeded while waiting on the predicate

  93 |     expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(before, 1);
  94 |     await range.press('Home');
> 95 |     await expect.poll(() => page.locator('#playerVideo').evaluate(video => video.currentTime)).toBeCloseTo(0);
```

The failure is at the Home-key reset after the synthetic pointer cancellation.
The preceding preview and cancellation assertions passed. The later checks
for one seek per completed drag and release outside the range were not reached.
This log does not establish a failure of pointer cancellation itself.

### Reproduction scenario

The original test used real media in the isolated browser fixture:

1. Seed a finished video using the `crossfade` media fixture, open its player,
   and wait for playback and a positive `currentTime`.
2. Pause playback and record the media clock as `before`.
3. Dispatch a touch `pointerdown` on `#playerSeek`, set its value to `8`,
   and dispatch `input`.
4. Verify that the label previews `0:08` while the media clock stays near
   `before` (precision 1).
5. Dispatch `pointercancel` and verify again that the media clock stays near
   `before`.
6. Press Home on the seek range and poll `#playerVideo.currentTime` for zero
   (precision 2, requiring an absolute difference below 0.005 seconds).

**Expected by the test:** Home resets the paused media clock to zero within
the three-second assertion window, establishing the baseline for the following
pointer-drag checks.

**Actual in CI:** The assertion times out and reports `0.03502` seconds
(35.02 ms), outside its 5 ms tolerance.

After installing the documented browser-test dependencies, run from the
repository root:

```bash
python3 tests/browser/run.py custom-controls.spec.cjs \
    --grep 'pointer dragging previews once and pointer cancellation leaves the real clock alone' \
    --repeat-each=20
```

Set `VDL_PYTHON` if the fixture dependencies are in another Python environment.
The repaired test uses the same command and pins the near-zero clock rather
than depending on playback timing to reach the rounding edge case.

### Evidence and investigation

The supplied log lists these artifacts:

```text
test-results/custom-controls-pointer-dr-b61b6-leaves-the-real-clock-alone/test-failed-1.png
test-results/custom-controls-pointer-dr-b61b6-leaves-the-real-clock-alone/error-context.md
test-results/custom-controls-pointer-dr-b61b6-leaves-the-real-clock-alone/trace.zip
```

Their contents were not supplied or inspected. After downloading them, open
the trace from `tests/browser` with:

```bash
npx playwright show-trace test-results/custom-controls-pointer-dr-b61b6-leaves-the-real-clock-alone/trace.zip
```

### Confirmed cause and repair

A controlled Chromium reproduction sets the real paused media clock to
`0.03502`, waits for `seeked`, then runs the original pointer preview,
cancellation, and Home sequence. Both repeated runs failed with the reported
residual. Capturing the range events and media-clock writes showed:

```text
before Home: clock=0.03502, range.value="0", seekable=[[0, 14.008]]
after Home: keydown(Home), keyup(Home), no input/change, no currentTime writes
```

`#playerSeek` has `step="0.1"`. On cancellation, `syncPlayerControls()` restores
the accepted media clock into that range, which rounds `0.03502` to zero.
Home on a range already at its minimum does not change its value, so the
browser emits no `change` event and `commitPlayerSeek()` is never called.
The nonzero residual is the unchanged paused clock. Neither pointer-guard
suppression nor a media seek boundary caused this failure.

The deterministic regression retains the `0.03502` clock and waits for the
real seek to complete. Before the repair, that test failed at the original
Home assertion. The repair presses ArrowRight to move the native range one
step before Home, guaranteeing a value change and a seek to zero. This
corrects the test's setup assumption while retaining native application
keyboard behavior.

Seek-write instrumentation now starts before the pointer preview. It asserts
zero writes through preview and cancellation, two writes for ArrowRight/Home,
and paused playback after reset. The counter then resets for the existing
one-write-per-drag checks, including release outside the range. The zero-clock
assertion retains its original precision and timeout.

### Validation

- Focused Chromium regression: **20/20 passed** with the controlled residual.
- Python 3.12 `VDL_PYTHON=<python312> ./tests/run-all.sh --unit`: **384 tests,
  OK (6 skipped)**; `vdl.py` line coverage **91.6% (5064/5527)**, above the
  enforced **90%** minimum.
- Full Chromium suite, `./tests/run-all.sh --browser`: **352 passed (8.8m)**.
- Firefox and WebKit: **6/6 passed on each engine**, repeating both the
  direct-control keyboard test and pointer-drag regression three times with
  `--grep 'pointer dragging previews once|direct controls follow real media'
  --repeat-each=3` and `VDL_TEST_BROWSER=firefox` / `webkit`.

### Acceptance criteria

- Explain the observed 35.02 ms residual using the CI trace or an equivalent
  controlled reproduction, including the range value and whether Home writes
  to the media clock.
- Make the reset and subsequent drag setup deterministic while preserving
  native keyboard range behavior and paused playback.
- Preserve verification that pointer input previews without seeking,
  cancellation leaves the accepted clock alone, and a completed drag commits
  exactly once, including release outside the range.
- Pass the focused test repeatedly and within the full browser suite without
  skipping assertions, adding arbitrary sleeps, or merely increasing timeouts
  or loosening tolerances to hide the cause.
- Any eventual code fix receives its own version bump and passes
  `./tests/run-all.sh --unit` with at least **90% `vdl.py` line coverage**,
  plus the relevant browser checks, before this report is marked resolved.
