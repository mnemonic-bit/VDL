## 58. [Resolved] Current Downloads confirms copying without filling the clipboard

**Severity:** Low

**Status:** Fixed locally in version `0.46.8` on 2026-10-25.

Choosing Copy URL in an active download's three-dot menu showed the check icon
and Copied label, but pasting into another tab produced nothing. The submitted
URL was still stored and correctly present on the menu button.

### Reproduction and cause

Run the browser regression against the isolated fixture:

```bash
VDL_PYTHON="$PWD/.venv/bin/python" python3 tests/browser/run.py clipboard.spec.cjs
```

The test seeds an active download, opens Current Downloads, clears the actual
browser clipboard, and clicks Copy URL. Before the fix, the native Clipboard
API case passed, while both an unavailable API and a rejected write produced
Copied with an empty clipboard:

```text
Expected: "https://fixture.invalid/watch?v=active&title=Tom%27s"
Received: ""
```

The fallback appended its temporary textarea to the document body, outside
the modal drawer. The browser makes elements outside a modal inert, so the
textarea could not receive focus or selection. The code also ignored the
boolean result of `document.execCommand('copy')` and showed success even when
the command returned false.

Changing only the textarea's parent to the active modal made all three
clipboard-content checks pass, confirming the cause.

### Repair and regression coverage

The fallback now appends its textarea inside the active modal, or to the body
when no modal is open. It removes the temporary field and restores focus after
the attempt. Only a successful copy shows the existing tick and Copied label;
a false return or exception shows an error in the drawer instead.

Browser regressions check the actual clipboard contents for native copying,
an unavailable API, a rejected write, and Library Info's fallback. Forced false
returns and exceptions check visible failure feedback, retained clipboard
contents, and focus restoration.

Validation passed all **37 relevant Chromium browser tests** across
`clipboard.spec.cjs`, `history-actions.spec.cjs`, and `action-errors.spec.cjs`.
The Python 3.12 unit gate ran **319 tests**, with five skipped, and passed
with **91.4%** `vdl.py` line coverage (4,884/5,342 executable lines; required
minimum 90%).
