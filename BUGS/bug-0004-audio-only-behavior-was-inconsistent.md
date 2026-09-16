## 4. [Resolved] Audio-only behavior is inconsistent

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-16.

There are two related failures:

1. `bestaudio/best` downloads only audio when the source offers a separate
   audio stream, but falls back to the complete video when the source is a
   combined MP4. No post-processing step extracts audio from that fallback.
2. The per-download Quality menu treats the extractor label `audio only` as a
   numeric resolution and generates the invalid selector
   `bestvideo[height<=NaN]+bestaudio/best`.

**Expected:** Audio-only must produce an audio-only output for supported
sources, and nonnumeric resolution labels must never generate height filters.

Expected-behavior coverage: `tests/test_formats.py`,
`tests/integration/test_real_media.py`, and
`tests/browser/download-options.spec.cjs`.

Audio-only requests now attach yt-dlp's audio extraction postprocessor, so a
combined video fallback is converted to an M4A audio output. Probe responses
derive qualities only from positive numeric heights, and the browser also
rejects malformed quality labels before constructing a format selector.

