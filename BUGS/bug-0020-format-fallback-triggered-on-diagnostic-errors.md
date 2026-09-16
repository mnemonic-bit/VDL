## 20. [Resolved] Format fallback triggers on noncanonical diagnostic errors

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

Before the fix, `_is_format_unavailable_error()` accepted any error containing
`--list-formats`, in addition to yt-dlp's literal `Requested format is not
available` message. A network, authorization, or extractor error that merely
suggested that diagnostic command could therefore cause VDL to retry with a
different format, masking the original request and doing unnecessary work.

A deterministic fake raised `HTTP 403; run --list-formats for diagnostics` on
the `best` attempt. VDL selected format `v1`, persisted that replacement, and
made a second download attempt.

**Expected:** Only the literal `Requested format is not available` condition
may trigger automatic format fallback. Other failures must surface unchanged.

Permanent coverage: `tests/test_formats.py`.

Format fallback now recognizes only yt-dlp's canonical `Requested format is
not available` message. Errors that merely mention `--list-formats` retain the
original selector, make no second download attempt, and surface unchanged.

