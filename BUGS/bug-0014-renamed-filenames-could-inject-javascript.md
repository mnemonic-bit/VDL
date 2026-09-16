## 14. [Resolved] Renamed filenames could inject JavaScript into the Play action

**Severity:** High

**Status:** Resolved and verified on 2026-09-15.

Before the fix, the rename endpoint permitted HTML entity text such as
`&apos;`, and the History renderer interpolated the resulting filename into an
inline `onclick` attribute. `escapeJs()` escaped literal apostrophes but did
not HTML-escape ampersands. The browser decoded the entity before compiling
the handler, so a filename could close the JavaScript string and append script
that ran when Play was clicked.

A deterministic Chromium reproduction renamed a finished file to an otherwise
valid basename containing encoded apostrophes and a harmless marker assignment.
Clicking Play set the marker on `window`.

**Expected:** Filenames must remain data. Bind Play through a delegated event
handler or another non-executable data channel; do not interpolate filenames
into inline JavaScript.

**Reproduction:** Rename a finished file to a basename containing an HTML-
encoded apostrophe and JavaScript expression, then click Play. The expression
runs in the VDL origin.

Permanent coverage: `tests/browser/history-actions.spec.cjs`.

The Play action now carries the filename in HTML-escaped data attributes and
uses the delegated click handler to pass it to the player as data. No filename
is compiled as inline JavaScript.

