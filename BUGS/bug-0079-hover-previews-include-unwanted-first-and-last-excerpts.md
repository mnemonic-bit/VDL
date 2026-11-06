## 79. Hover previews include unwanted first and last excerpts

**Severity:** Low — opening and closing excerpts often show trailer, intro,
or outro material instead of the video's main content.

**Status:** Resolved in version `0.51.4`. Reported on 2026-11-06 against commit
`fd91eaf`, version `0.51.2`. The sampler now removes only the two outer
excerpts, and montage cache version 6 schedules existing previews for safe
background replacement. Videos below 16 seconds produce no new montage;
an existing valid preview stays available until a successful replacement.

**Related:** [Bug 0075](bug-0075-hover-preview-sampling-count-does-not-scale-with-duration.md)
introduced duration-based sampling with source start gaps of at most 30
seconds. This report supersedes its requirement to include the two endpoint
excerpts, while preserving all inner excerpts.
[Feature 0048](../FEATURES/feature-0048-upgrade-preview-caches-gradually-and-add-system-logs.md)
provides background upgrades, playable old previews, safe publication, and
retirement. [Bug 0078](bug-0078-obsolete-thumbnail-and-preview-caches-accumulate.md)
separately tracks broader obsolete-cache accumulation.

### Reported behavior and reproduction

1. Open Library with a video whose hover preview uses the duration-based
   sampling recipe introduced by Bug 0075.
2. Hover over its thumbnail and watch the full preview loop.
3. Inspect the generated excerpt timestamps to distinguish the first and
   last excerpts from the inner excerpts.

**Actual:** The montage includes the first and last eligible excerpts. For
normal-duration videos these begin at second 5 and second `duration - 7`,
respectively. The reporter finds that these outer excerpts often show
unhelpful trailer-like material.

**Expected:** Remove exactly the first and last excerpts from the current
recipe. Keep every inner excerpt at its existing source timestamp, with its
existing length and chronological order. Keep the duration-based sampling;
do not return to a fixed excerpt count, redistribute the remaining excerpts,
or replace this change with a larger fixed exclusion in seconds.

### Sampling contract

Treat the current sampler's output as the reference list, then remove its
outer entries:

```text
old_segments = current_duration_based_recipe(duration)
new_segments = old_segments[1:-1]
```

For the normal branch (`duration >= 16` seconds), the existing recipe uses:

```text
old_count = floor(duration / 30) + 3
spacing = (duration - 12) / (old_count - 1)
old_start[i] = 5 + i * spacing
```

The new montage keeps indices `1 .. old_count - 2`, each two seconds long.
Its count becomes `floor(duration / 30) + 1`. Compute spacing using the
original count before trimming; calculating spacing from the reduced count
would move the inner excerpts and violate the request. Retained adjacent
starts remain equally spaced and at most 30 source seconds apart.

| Source duration | Current starts (seconds) | Required retained starts (seconds) |
| --- | --- | --- |
| 16 | 5, 7, 9 | 7 |
| 19 | 5, 8.5, 12 | 8.5 |
| 29 | 5, 13.5, 22 | 13.5 |
| 30 | 5, 11, 17, 23 | 11, 17 |
| 31 | 5, 11.333…, 17.667…, 24 | 11.333…, 17.667… |
| 59 | 5, 20.667…, 36.333…, 52 | 20.667…, 36.333… |
| 60 | 5, 17, 29, 41, 53 | 17, 29, 41 |
| 600 | 23 excerpts from 5 through 593 | The same 21 inner excerpts, from 31.727… through 566.273… |

Use unrounded timestamps internally and retain the existing millisecond
rounding only when building ffmpeg arguments.

**Short-video boundary policy:** Applying the trimming rule literally leaves
no inner excerpts when the old recipe returns fewer than three. The proposed
behavior is to keep the static thumbnail for those videos rather than repeat
footage or retain an excluded outer excerpt. In the current recipe this
covers durations below 16 seconds, including the single-excerpt fallback
between 10 and 16 seconds. Exactly 16 seconds retains the middle two-second
excerpt. Invalid or unavailable duration retains the static fallback.

### Background regeneration and replacement

- Advance the montage recipe/cache identity so existing untrimmed previews
  are upgraded through the shared background queue, including videos already
  in Library. Keep static-thumbnail generation unchanged.
- While an upgrade is queued, running, or waiting for retry, keep the last
  valid preview for the unchanged source on disk and playable. Requests and
  intentional hover must not wait for ffmpeg. Preserve existing scheduling,
  deduplication, resource limits, and the single active generator.
- Generate and validate the complete replacement in a separate temporary
  file. Only after successful publication and durable serving selection may
  new hover sessions select the trimmed preview. Do not expose partial output
  or delete the working old preview to trigger regeneration.
- An already playing hover continues on its selected old asset without a
  restart, blank frame, or broken range request. The next hover uses the new
  asset. Remove the obsolete preview after publication, once existing reader
  leases allow safe deletion; retry failed cleanup without another encode.
- Failure, timeout, invalid output, or shutdown before publication keeps the
  previous valid preview available. Restart recovery must resume unfinished
  work and cleanup without losing the last playable preview. Preserve source
  identity and authorization checks throughout the existing lifecycle.
- When trimming produces no excerpts, do not publish an empty MP4 or count a
  failed encode as a replacement. Use the static-thumbnail fallback; the
  successful-replacement condition for deleting an old preview is not met.

These are requirements for this recipe upgrade using Feature 0048's existing
mechanism, not a claim that background replacement is currently broken.

### Original source evidence and repair scope

- [`_preview_segments()`](../vdl.py#L5117) currently returns the full list,
  including both endpoints. Its normal branch uses `floor(duration / 30) + 3`
  excerpts; its short-video branch returns a single continuous excerpt.
- [`generate_video_preview()`](../vdl.py#L5145) builds ffmpeg inputs and concat
  counts from that list and validates temporary output before publication.
  Preserve its silent browser-compatible MP4 format and output quality.
- [`AssetQueue._finish_montage()`](../asset_generation.py#L534) and
  [`PreviewMaintenance.delivery()`](../preview_maintenance.py#L269) already
  support validated publication and selected current/legacy assets.
  [`PreviewMaintenance.cleanup()`](../preview_maintenance.py#L304) retires
  recorded obsolete montages after replacement and lease expiry. Reuse this
  lifecycle for the recipe change, respecting provenance requirements.

### Acceptance criteria and verification

1. For representative normal durations, assert that the new list equals the
   previous recipe's list with only its first and last entries removed.
   Include the table above, fractional durations, exact 30-second multiples,
   long sources, and the 10-/16-second boundaries. Verify unchanged inner
   timestamps, lengths, order, and spacing rather than count alone.
2. Verify ffmpeg inputs and concat counts match the trimmed list, and decode
   a real montage to confirm that only the outer excerpts disappeared.
3. Start with a known valid old montage and block its queued upgrade. It must
   still play while generation is pending. After publication, the current
   hover continues on the old asset and a subsequent hover uses the new one.
   Old files are removed after reader leases expire.
4. Inject generation/publication failures and restart during an upgrade.
   Verify the old preview survives, retries deduplicate, and cleanup happens
   only after successful replacement. Cover restart after publication but
   before old-file removal and the no-inner-excerpts fallback.
5. Extend the relevant hover-preview, maintenance queue/API, and native-media
   browser checks. Before completing implementation, run
   `./tests/run-all.sh --unit` and verify at least **90% `vdl.py` line coverage**,
   using Python 3.12 when close to the threshold, plus relevant media and
   Chromium/Firefox handoff checks. The code fix requires its own PATCH bump
   in `VERSION`; the original documentation-only report left `VERSION`
   unchanged.

### Implementation and validation

Version `0.51.4` preserves the original sample count when calculating spacing
and generates only indices `1 .. old_count - 2`. The montage identity advances
from version 5 to 6; the thumbnail recipe and shared publication, retry,
recovery, and reader-lease lifecycle are unchanged. Below 16 seconds, no encode
or empty replacement is attempted, so an existing valid preview is not retired.

Regression checks failed against the old recipe before the fix. Validation
passes all 9 native-media tests, including decoded comparisons with the old
montage's inner excerpts, and 12 selected checks in each of Chromium and
Firefox (`asset-demand`, `system-logs`, and `preview-handoff-media`). The native
handoff check distinguishes the untrimmed six-second asset from its two-second
replacement and verifies that the active old preview continues decoding.
`./tests/run-all.sh --unit` passes with `VDL_PYTHON` selecting Python 3.12.14:
462 tests, 9 intentional media skips, and **92.1% `vdl.py`
line coverage** (5244/5692 executable lines; minimum 90%). The separate media
run enables all 9 native-media tests.
