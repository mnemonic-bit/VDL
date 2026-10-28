## 59. [Resolved] Download dialog remains open after a successful submission

**Severity:** Medium

**Status:** Fixed locally in version `0.49.1` on 2026-10-28. The equivalent-input
race below is independently reproduced; confirmation in the reporter's browser
remains outstanding.

After pasting a URL into the Download dialog and pressing **Download**, the
download starts and the active-download counter increases by one, but the
dialog remains open. The user must dismiss it manually even though the
submission has succeeded.

### Reproduction to confirm

1. Open the New download dialog and note the active-download count.
2. Paste a supported video URL into the URL field.
3. Wait until the URL probe completes and **Download** is enabled.
4. Press **Download** once.
5. Observe that the download starts and the active-download count increases
   by one, while the Download dialog remains visible.

**Reported actual:** The download is accepted and starts, but the dialog does
not close.

**Expected:** After the user enters a valid URL and presses **Download**, a
successful submission automatically closes the dialog. Closing must not wait
for the download to finish or require a second click or manual dismissal.

### Impact

The dialog obscures the page after its task is complete and leaves the user
unsure whether the button worked, despite the increased active-download count.
This can encourage repeated submission attempts.

### Reproduction and cause

The ordinary paste-and-click flow passes locally, with both immediate and
delayed acceptance. A deterministic browser reproduction holds the successful
response after the server accepts the job, observes the active count increase,
then adds trailing whitespace to the URL before delivering the response. The
URL input emits another input event although its trimmed URL is unchanged.
Previously that event scheduled a new probe and advanced `probeGeneration`.
The success handler treated this as a newer draft and returned before clearing
the accepted URL and closing the dialog. The regression failed with
`#newDownloadDialog` still visible after acceptance.

This confirms a path to the reported symptom, but the original report did not
include an equivalent-input event or browser diagnostics, so its exact trigger
has not been confirmed.

### Repair and regression coverage

- URL input events whose trimmed value matches the current probe URL no longer
  invalidate its generation or schedule redundant metadata requests. Accepted
  submissions therefore reach the existing clear-and-close path.
- Each opening of New download has a session counter. Success callbacks also
  check that counter, preserving a reopened dialog even when its URL matches
  the earlier submission. Actual URL changes retain the generation guard.
- Browser regressions paste through the clipboard and click the visible
  Download button, verifying immediate, delayed, and queued acceptance, exactly
  one new job, the active count, closure without opening Current Downloads, and
  continued completion after closure. Further coverage preserves reopened and
  edited drafts, rejects invalid URLs, and checks immediate and delayed failure
  feedback with retained options.
- Both the equivalent-input and reopened-dialog regressions failed before
  their fixes and passed afterward.

Validation: all 42 form and options browser checks passed. The wider browser
run passed 50 checks and hit one Library retry-count timing failure; that
check then passed three consecutive isolated reruns. The required
`./tests/run-all.sh --unit` gate passed on Python 3.12.14: 374 tests,
five optional skips, and `vdl.py` line coverage of 91.6% (90% required).

### Acceptance criteria

- Pasting a supported URL and clicking **Download** once creates exactly one
  download and automatically closes the dialog after successful acceptance,
  including when the download is queued.
- The active-download count reflects the accepted job, and the job continues
  after the dialog closes.
- Closing the dialog does not automatically open Current Downloads.
- Invalid URLs and rejected submissions keep the dialog open with useful
  feedback and preserve the entered URL and options for correction or retry.
- A delayed response must not erase a newer URL draft or dismiss a newly
  reopened dialog belonging to a different submission attempt.
- Add a browser regression that pastes a URL, submits through the visible
  **Download** button, and verifies both job acceptance and dialog closure.
  Include delayed acceptance and failure cases.
