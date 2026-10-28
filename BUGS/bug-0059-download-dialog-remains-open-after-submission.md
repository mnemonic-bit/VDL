## 59. [Open] Download dialog remains open after a successful submission

**Severity:** Medium

**Status:** Open; reported on 2026-10-28. Not yet independently reproduced.

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

### Investigation notes

- In `static/app.js`, `startDownload()` submits to `/api/download` and calls
  `closeNewDownload()` in the success handler. That helper closes the native
  dialog when it is open. The intended close path therefore exists; source
  inspection alone does not establish why the reported dialog stays open.
- The success handler returns before closing if the probe generation has
  changed. Check whether that guard is involved in the reported sequence,
  and capture any response failure or client-side exception that prevents
  execution from reaching the close call. These are investigation leads,
  not confirmed causes.
- Capture the browser and application version, submission response, console
  errors, and probe state during a controlled reproduction. The reporter has
  not supplied those details.

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

This report changes documentation only and does not change `VERSION`.
