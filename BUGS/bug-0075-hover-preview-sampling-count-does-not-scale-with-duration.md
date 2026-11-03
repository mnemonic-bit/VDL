## 75. Hover-preview sampling count does not scale with video duration

**Severity:** Low — long videos have large unsampled intervals, reducing the
usefulness of the thumbnail's moving preview.

**Status:** Resolved in version `0.50.10`, validated on 2026-11-02. The report
was refined against commit `dd043fb`, version `0.50.9`; source inspection
confirmed the fixed-count behavior before implementation.

**Related:** [Bug 0041](bug-0041-history-video-previews-were-redundant-and-firefox-incompatible.md)
introduced evenly spaced hover excerpts and five-second edge exclusions;
[Bug 0048](bug-0048-settings-and-hover-preview-controls-were-inconsistent.md)
changed excerpt length to two seconds. This report supersedes their fixed
seven-excerpt count. [Feature 0044](../FEATURES/feature-0044-queue-thumbnail-and-hover-preview-generation.md)
owns background generation and cache readiness.

### Reported behavior and reproduction

1. Add a playable video with a known duration, such as 600 seconds, to Library.
2. Allow its hover-preview asset to become ready.
3. Hover over the thumbnail until the moving preview starts. Inspect the
   generated excerpt timestamps to measure source-timeline coverage; visual
   observation alone cannot establish exact spacing.

**Actual:** The sampler uses seven two-second excerpts for sufficiently long
videos, regardless of duration. Their starts are evenly spaced, but the gaps
grow with video length. A 600-second source produces starts at 5, 103, 201,
299, 397, 495, and 593 seconds: 98 seconds apart. Shorter sources with less
than 14 seconds inside the edge exclusions instead use one continuous excerpt.

**Expected:** Keep equally spaced excerpt starts, include the first and last
eligible excerpts, and choose the number of middle excerpts from duration.
Consecutive starts must be at most 30 seconds apart on the source timeline.

### Precise sampling rule

The following interpretation makes the requested count explicit: the two
endpoint excerpts are additional to the calculated middle-excerpt count.
`t` is the full source-video duration in seconds, before edge exclusions.
`div` means floor division, including when the probed duration is fractional.

For a video long enough to fit the requested non-overlapping excerpts:

```text
middle_count = floor(t / 30) + 1
total_count  = middle_count + 2
first_start  = 5
last_start   = t - 5 - 2
spacing      = (last_start - first_start) / (total_count - 1)
start[i]     = first_start + i * spacing, i = 0 .. total_count - 1
length[i]    = 2 seconds
```

Thus the first excerpt starts five seconds into the source and the last ends
five seconds before the source ends. All excerpts, including the endpoints,
participate in the same spacing calculation. Do not sample every 30 seconds
and then append a shorter final interval: every adjacent interval must be
equal. The formula gives `spacing <= 30` without a separate count cap.

The 30-second bound measures **start-to-start source time**, not the playback
time between cuts in the concatenated preview. Play excerpts chronologically
and consecutively without inserted waiting time. The montage's loop from its
last excerpt back to its first is excluded from the forward-spacing rule.

| Source duration `t` | Middle excerpts | Total excerpts | Source start times (seconds, rounded) | Spacing (seconds, rounded) |
| --- | --- | --- | --- | --- |
| 19 | 1 | 3 | 5, 8.5, 12 | 3.5 |
| 29 | 1 | 3 | 5, 13.5, 22 | 8.5 |
| 30 | 2 | 4 | 5, 11, 17, 23 | 6 |
| 31 | 2 | 4 | 5, 11.333, 17.667, 24 | 6.333 |
| 59 | 2 | 4 | 5, 20.667, 36.333, 52 | 15.667 |
| 60 | 3 | 5 | 5, 17, 29, 41, 53 | 12 |
| 600 | 21 | 23 | 5 through 593, equally spaced | 26.727 |

Compute from the unrounded duration and timestamps. Rounding for ffmpeg's
millisecond seek arguments may introduce at most one millisecond of difference
between adjacent intervals; do not accumulate rounding error across excerpts.

### Very short videos and unavailable duration

Retain the five-second exclusions at both ends. To avoid repeated or
overlapping footage when there is insufficient eligible content, use these
explicit exceptions to the normal count rule:

- `t <= 10`: no eligible footage; keep the static thumbnail.
- `10 < t < 16`: use one continuous excerpt from second 5 to second `t - 5`,
  without repeating it to fill the count. Its length may differ from two seconds.
- `t >= 16`: use the normal formula. At exactly 16 seconds, three adjacent
  two-second excerpts fit at seconds 5, 7, and 9.
- Missing, non-finite, or otherwise invalid duration: retain the current
  unavailable-preview behavior and static-thumbnail fallback.

These short-video rules are the refinement's proposed fallback; the user's
19-, 31-, and 59-second examples all follow the normal rule.

### Source evidence and repair scope

- [`_preview_segments()` in vdl.py](../vdl.py#L5115) already calculates equal
  spacing, but uses `_PREVIEW_SEGMENT_COUNT = 7` and the fixed 14-second
  `_PREVIEW_TOTAL_SECONDS` threshold. Replace the fixed count and adapt the
  short-video threshold to the rule above.
- [`generate_video_preview()`](../vdl.py#L5139) consumes the segment list and
  already builds its input and concat counts dynamically. Preserve the silent,
  480-pixel, 12-fps browser-compatible MP4 output and atomic publication.
- The current cache version is 4. Increment the preview generation/cache
  identity so existing seven-excerpt assets are regenerated through the shared
  background queue and readiness flow. Repeated hovers must reuse a ready
  current-version montage. Static-thumbnail caches need no sampling change.
- Preserve existing hover activation, reduced-motion handling, source-path
  protections, and single-worker generation. Do not silently cap the count
  at seven or another value that violates the spacing/count requirements.
- The new count grows with duration. Verify representative long sources
  against the existing generation timeout and resource limits; a sampling
  calculation alone does not demonstrate successful montage generation.

### Acceptance criteria and verification

1. Extend [`tests/test_hover_previews.py`](../tests/test_hover_previews.py)
   with the table above, exact 30-second multiples, fractional durations just
   below and above them, and the 10-/16-second fallback boundaries.
2. Assert the count, endpoint placement, two-second lengths, monotonic starts,
   absence of overlapping footage, equal intervals, and maximum 30-second
   start spacing across representative short and long durations.
3. Verify generated ffmpeg seek/length arguments and concat counts use the
   dynamic segment list. Confirm the encoded montage plays excerpts in order
   and retains browser-compatible playback.
4. Verify old-cache invalidation, background generation for an existing Library
   item, readiness updates, and reuse on repeated hovers. A browser check must
   confirm a ready montage starts on intentional hover without affecting full
   video playback or view counts.
5. Before marking the fix complete, run `./tests/run-all.sh --unit` and verify
   at least 90% `vdl.py` line coverage, using Python 3.12 when close to the
   threshold. Run relevant browser/media checks. Implementation requires its
   own PATCH version bump, recorded in `VERSION` as `0.50.10`.

### Resolution and validation

The fixed seven-excerpt count and 14-second interior threshold were replaced
with the duration-based count and six-second minimum interior above. Invalid
durations remain unavailable. The encoder still uses the returned list for
millisecond seeks, two-second lengths, and chronological concatenation. Preview
cache version 5 is mirrored in the browser URL and shared queue identity;
static-thumbnail versioning is unchanged.

Regression coverage includes all table examples, exact and fractional
30-second boundaries, the 10-/16-second fallbacks, a 24-hour sampling
calculation, dynamic ffmpeg arguments, and an existing Library item with a
version-4 montage. That item queues a new montage, emits an asset-readiness
notification, and reuses the ready version-5 asset without regenerating its
thumbnail or recording a view.

Validation on Python 3.12.14:

- `VDL_PYTHON=/tmp/vdl-bug0075-venv/bin/python ./tests/run-all.sh --unit`
  passed with **92.0%** `vdl.py` line coverage (**5143/5590**; minimum 90%).
- `./tests/run-all.sh --media` with that interpreter passed all seven media
  checks. The long-source regression additionally passed after its final
  color-range-independent frame assertion was added. A decoded grayscale
  timeline verifies chronological, equally spaced cuts, and stream inspection
  verifies silent H.264/yuv420p MP4 output at 12 fps, at most 480 pixels wide,
  with browser-compatible codec level.
- Synthetic 600-second and 7200-second sources produced 23 and 243 excerpts.
  The final focused run encoded them in 0.61 and 6.00 seconds, within the
  unchanged 180-second timeout and with the existing single-thread decoder,
  encoder, and filter options. Peak child RSS reached approximately 138 MiB
  and 1.35 GiB respectively. The multi-input encoder's memory use still grows
  with excerpt count; these measurements are synthetic fixtures, not a bound
  for arbitrary resolutions, codecs, or durations.
- The targeted hover/readiness/reduced-motion browser checks passed in
  Chromium and Firefox (three checks per browser). A separate native-media
  check generated a real eight-second montage from a 31-second source through
  the shared queue. Both browsers decoded and played it on two intentional
  hovers, left view counts unchanged, and then played the full source and
  recorded one view. The ready montage's modification time stayed unchanged.
