## 63. Fullscreen playback crops non-widescreen videos

**Severity:** Medium — fullscreen playback hides part of the video image.

**Status:** Fixed locally in version `0.49.5` on 2026-10-28. Independently
reproduced in headless Chromium 153.0.8010.12 on Linux using a generated 4:3
fixture. The original deployment's browser, operating system, version, and
source video remain unspecified.

### Reported behavior

When playing a 4:3 video in full screen on a 16:9 display, the top and/or
bottom of the picture is cut off. The picture appears to scale to the
screen's width even though the resulting height exceeds the available
screen height.

Width-based scaling is the reported visual impression, not an established
implementation cause.

### Reproduction

1. Use a 16:9 display and a known 4:3 video, preferably with visible markers
   near all four edges so cropping is easy to identify.
2. Start playback in VDL and enter full screen.
3. Compare the visible image with the complete source frame, paying
   particular attention to its top and bottom edges.

**Reported actual:** The video fills the screen width and parts of its top
and/or bottom are outside the visible area.

**Expected:** Scale the video proportionally to fit entirely within the
fullscreen viewport, respecting both its width and height. Center the image
and show dark bars on the left and right for a 4:3 video on a 16:9 screen.
Preserve the source aspect ratio without cropping or stretching.

For example, on a 1920 × 1080 fullscreen viewport, a 4:3 picture should occupy
1440 × 1080 pixels, leaving a 240-pixel dark bar on each side.

### Cause and fix

Continuous playback expands `#playerMediaStage` into fullscreen. That element
used a grid with implicit, automatically sized tracks. A video's intrinsic
dimensions could expand the row beyond the viewport despite the stage's
explicit height and the video's `object-fit: contain`. The picture fit the
oversized grid cell, leaving its bottom outside the visible screen.

The fullscreen stage now explicitly defines its row and column as
`minmax(0, 1fr)`, allowing both tracks to fit the viewport. The existing
`object-fit: contain` then centers the complete proportional image with black
bars where needed. Single-video fullscreen uses the video element directly
and already fit correctly in the reproduction.

The deterministic reproduction used the pre-fix `0.49.4` styles, a 1600×1200
video with a white border around all four edges, and a 1280×720 fullscreen
viewport. `fullscreen-fit.spec.cjs` failed its rendered-edge and black-bar
checks for continuous playback and passed for single-video playback. The
same checks pass with the constrained grid. Both manual entry and the
start-fullscreen preference are covered.

### Acceptance criteria and regression coverage

- A 4:3 video on a 16:9 fullscreen viewport shows the complete source frame,
  centered with dark bars on both sides and no distortion.
- Fullscreen sizing respects both viewport dimensions for other aspect
  ratios too: portrait videos fit with side bars, and videos wider than the
  viewport fit with bars above and below.
- A matching 16:9 video continues to fit a 16:9 fullscreen viewport without
  unnecessary bars or clipping.
- Entering, leaving, and re-entering full screen, or changing viewport
  dimensions, recalculates the fit without retaining an oversized image.
- Add browser regression coverage using a known 4:3 fixture with edge markers.
  Verify the complete rendered picture and proportional fit, rather than
  merely asserting that a fullscreen request succeeded. Cover supported
  fullscreen entry paths and verify normal playback after exit.

### Regression coverage

`tests/browser/fullscreen-fit.spec.cjs` uses real fullscreen requests, decoded
WebM fixtures, and screenshot pixel checks for all four border markers, the
blue picture center, and expected black bars. It covers 4:3, portrait,
ultrawide, and 16:9 pictures in both single-video and continuous playback,
through manual entry and fullscreen launch. Each case exits, changes viewport
dimensions, re-enters, and verifies that normal overlay playback still runs
afterward. A Chromium CDP test also resizes the live fullscreen viewport
without exiting. Native controls are hidden only while taking test screenshots
so their overlay cannot obscure the edge markers.

Run the browser regression with:

```sh
python3 tests/browser/run.py fullscreen-fit.spec.cjs
```
