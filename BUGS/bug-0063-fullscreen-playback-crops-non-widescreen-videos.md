## 63. Fullscreen playback crops non-widescreen videos

**Severity:** Medium — fullscreen playback hides part of the video image.

**Status:** Open. Reported on 2026-10-28. Recorded from the user's
observation; not independently reproduced. The affected browser, operating
system, application version, and source video have not been supplied.

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

### Investigation needed

Record the browser and operating system, deployed application version,
fullscreen viewport dimensions, source display aspect ratio, and how full
screen was entered. Inspect video and player-container sizing in full screen,
including fit rules and overflow, to establish which constraint causes the
cropping. Compare fullscreen entry at playback launch with entry from an
already-open player where those paths are supported.

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

This report changes documentation only; no application fix or version bump
is included.
