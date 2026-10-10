## 41. [Resolved] History video previews were redundant and Firefox-incompatible

**Severity:** Medium

**Status:** Resolved incrementally in versions `0.20.2` through `0.21.5` on
2026-10-01.

History cards initially placed a play icon in the center of every video
thumbnail even though the entire thumbnail was already the playback target.
The static image also offered no indication of the video's contents before
opening the full player. The subsequent hover-preview implementation exposed
several smaller usability and compatibility defects during browser review:

- The redundant center play icon obscured the thumbnail.
- Hovering provided no moving preview of the video's contents.
- The first generated MP4 montages could not be decoded by some Firefox
  installations.
- The thumbnail button's native **Play** tooltip covered part of the hover
  preview, while the separate favorite-star tooltip remained useful.
- Sampling the beginning and end of the source overrepresented title cards,
  credits, and other frames that were difficult to recognize at thumbnail
  size.
- Full playback repeated the filename above the video and kept its close
  button outside the video frame, where both controls remained visible even
  after pointer activity stopped.

### Reproduction

1. Open History with at least one finished video.
2. Observe the center play icon even though clicking anywhere on the thumbnail
   starts playback.
3. Hover over the thumbnail for more than 500 ms.
4. In the initial implementation, observe either no moving preview or, in an
   affected Firefox installation, the static image remaining visible while
   the console reports `NS_ERROR_DOM_MEDIA_DECODE_ERR` and an
   `avcodec_send_packet` failure.
5. Keep the pointer over the thumbnail and observe the native **Play** tooltip.
6. Inspect the generated montage and note that its first and last samples come
   from the source video's opening and closing frames.
7. Open the full player and observe the repeated title and persistent close
   button above the video.

**Actual:** The thumbnail repeated its play affordance, did not initially
provide a content preview, produced an incompatible H.264 stream in affected
Firefox environments, displayed an unnecessary tooltip over the preview, and
sampled title-heavy edges of the source timeline.
The full player also spent space on a repeated title and separated its close
control from the video it dismisses.

**Expected:** The unobscured thumbnail should remain the single playback
target. After an intentional hover delay, it should show a compact,
Firefox-compatible montage that represents the body of the video. The
thumbnail itself should not show a native tooltip, while the favorite star
must retain its **Add to favorites** or **Remove from favorites** tooltip.
Full playback should omit the repeated title and place its close control inside
the video's top-right corner, visible during mouse activity but hidden after
two seconds of inactivity.

### Diagnosis

The first montage encoder applied `fps=12` to each excerpt before joining the
seven streams with FFmpeg's `concat` filter. The concatenated stream inherited
a microsecond time base. libx264 interpreted that time base as an extreme
macroblock rate, warned that the rate exceeded every supported level, and
declared the 480-pixel preview as H.264 level 6.2. The resulting files decoded
with the container's FFmpeg 7 build and one automated Firefox environment, but
Firefox installations using a different FFmpeg decoder rejected their packet
stream.

HTTP range reconstruction of the failing responses matched the complete files
byte-for-byte, ruling out Flask's conditional response handling. Explicitly
pinning the encoder output to 12 fps produced H.264 level 2.1, an exact 12 fps
rate, and no macroblock-rate warning.

### Resolution

- Removed the center play icon while preserving the thumbnail button's
  keyboard focus and accessible `aria-label`.
- Added a muted, looping hover montage after a 500 ms delay. No preview URL is
  loaded before that delay, only one montage plays at a time, leaving the
  thumbnail releases its media request, and touch or reduced-motion clients
  retain the static image.
- Generate seven 3-second excerpts at 480 pixels and 12 fps, joined into one
  silent H.264 MP4. Pin the output cadence so libx264 emits level 2.1 instead
  of level 6.2.
- Version both the sidecar filename and browser request URL when the encoding
  contract changes. This bypasses server-side and Firefox media caches that
  may still contain an incompatible or differently sampled preview.
- Removed only the thumbnail's native **Play** title. The favorite star keeps
  its state-specific native title and accessible label.
- Restrict sampling to the source timeline after the first 5 seconds and
  before the final 5 seconds. Videos with at least 21 seconds of interior
  footage receive seven evenly spaced 3-second excerpts; shorter videos use
  their available trimmed interior once, and videos of 10 seconds or less
  remain static because no interior footage remains.
- Removed the title from the full playback overlay. Its close button now sits
  inside the video's top-right corner, appears when the mouse moves, and fades
  after two seconds without movement. Escape and backdrop-click closing are
  unchanged; keyboard focus keeps the button visible, and coarse-pointer
  clients keep the control available without requiring mouse movement.

### Verification

- Unit coverage verifies the seven evenly spaced starts, short-video behavior,
  versioned cache path, lazy generation, byte ranges, atomic publication, and
  artifact cleanup in `tests/test_hover_previews.py`.
- Real-media coverage verifies a cached, silent H.264 preview at level 3.0 or
  below with the expected trimmed duration in
  `tests/integration/test_real_media.py`.
- Browser coverage verifies the 500 ms load delay, one-at-a-time playback,
  reduced-motion behavior, absence of the thumbnail title, retained favorite
  title, and unchanged click-to-play behavior in
  `tests/browser/history-actions.spec.cjs`.
- Player coverage verifies that the title is absent, the close button stays
  inside the video, mouse movement reveals it, inactivity hides it, and
  keyboard focus reveals it in `tests/browser/playback.spec.cjs`.
- The two previews that produced the reported Firefox decoder errors were
  regenerated as H.264 level 2.1 and confirmed to play and advance in a real
  Firefox runtime against the deployed Podman container.
