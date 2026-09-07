# Known Bugs

Issues 1-8 were found during the container feature audit performed on
2026-09-06 against commit `73214c1`. They were rechecked on 2026-09-07 against
commit `957d4c9`; issues 1 and 2 are resolved and issues 3-8 remain open.
Issues 9-13 were found during that recheck. The original audit and its limits
are in [`feature-audit/REPORT.md`](feature-audit/REPORT.md).

## 1. [Resolved] Merged downloads kept the deleted temporary audio filename

**Severity:** High

**Status:** Resolved by commit `aca3d58` and verified on 2026-09-07.

Before the fix, when yt-dlp downloaded separate video and audio streams,
ffmpeg successfully created the merged MP4. The download history row
nevertheless kept the path of the temporary audio stream, such as:

```text
/downloads/manifest_6b9f8195.f2.m4a
```

That temporary file no longer exists after merging. The actual finished file
is present at a path such as:

```text
/downloads/manifest_6b9f8195.mp4
```

This left the entry marked `finished`, but:

- playback through `/api/file/<id>` returns HTTP 404;
- inline rename returns HTTP 410, "Original file is missing on disk";
- deleting the history entry does not delete the merged MP4, leaving an
  orphaned file on disk;
- final size and resolution probing may operate on the wrong path.

The progress hook stored the filename reported when an individual stream
finished. The post-download recovery then removed only the stored extension
and tried common extensions. For a stored name ending in `.f2.m4a`, it looked
for paths beginning with `.f2`, while ffmpeg wrote the merged file without
that format suffix.

**Expected:** After post-processing, the history row must contain the actual
merged output path.

**Reproduction:** Download a source with separate video and audio streams,
such as the audit DASH fixture, and select a merged video format. Wait for the
entry to report `finished`, then try Play or Rename.

Evidence: [focused result](feature-audit/evidence/merge-evidence.json),
[failing reproduction](feature-audit/evidence/merge-repro.log), and
[orphaned-file result](feature-audit/evidence/deletion-evidence.json).

The fix now waits for post-processing to finish and stores the path reported
by the postprocessor. A current real DASH merge stored the resulting MP4 path;
playback returned HTTP 200, rename succeeded, and removal deleted the file.

## 2. [Resolved] Maximum concurrent downloads setting was not enforced

**Severity:** High

**Status:** Resolved by commit `a70d006` and verified on 2026-09-07.

Before the fix, the `max_concurrent` preference was saved and displayed, but
every accepted download started a new worker thread immediately. With the
value set to `1`, two test downloads simultaneously reached `downloading` at
9.9%.

**Expected:** At most the configured number of downloads should run; excess
downloads should remain queued until a worker slot is available.

Evidence: [browser audit results](feature-audit/evidence/results.json).

Workers now wait in FIFO order for a dynamically sized slot before entering
the probe and download phases. Focused tests verify that the configured limit
is enforced, queued downloads can be cancelled, and raising the limit wakes a
waiting download.

## 3. Download Options ignores the custom Title/Filename

**Severity:** Medium

The frontend sends the `filename` field in `POST /api/download`, but the
backend does not use it when building yt-dlp's output template. Entering
`requested-custom-name` produced a file named from the source title instead.

**Expected:** A valid custom filename entered in Download Options should be
used for the downloaded file while preserving the real output extension.

Evidence: [browser audit results](feature-audit/evidence/results.json).

## 4. Audio-only behavior is inconsistent

**Severity:** Medium

There are two related failures:

1. `bestaudio/best` downloads only audio when the source offers a separate
   audio stream, but falls back to the complete video when the source is a
   combined MP4. No post-processing step extracts audio from that fallback.
2. The per-download Quality menu treats the extractor label `audio only` as a
   numeric resolution and generates the invalid selector
   `bestvideo[height<=NaN]+bestaudio/best`.

**Expected:** Audio-only must produce an audio-only output for supported
sources, and nonnumeric resolution labels must never generate height filters.

Evidence: [browser audit results](feature-audit/evidence/results.json) and
[DASH supplemental results](feature-audit/evidence/supplement.json).

## 5. Clear History also removes cancelled and interrupted Current entries

**Severity:** Medium

The UI presents Clear History inside the Download History tab, but the backend
clears every terminal status. This includes `cancelled` and `interrupted`,
which the UI places in Current so they can be continued. A cancelled audit
entry disappeared from Current after Clear History was used.

**Expected:** Clear History should remove only statuses displayed in Download
History (`finished` and `error`), or the UI should clearly disclose and confirm
that resumable Current entries will also be removed.

Evidence: [supplemental results](feature-audit/evidence/supplement.json).

## 6. Cancelled downloads can leave partial files behind

**Severity:** Medium

Some cancelled downloads have no path saved in the history row. Removing the
entry or clearing history therefore cannot locate their `.part`, fragment, and
`.ytdl` files, which remain in the download directory.

**Expected:** Removing a cancelled download should remove all partial files
owned by that download, without affecting unrelated files.

Evidence: [deletion evidence](feature-audit/evidence/deletion-evidence.json).

## 7. History insertion animation does not make room before revealing the row

**Severity:** Low

The item animation changes opacity only. The list layout changes immediately,
so existing rows jump rather than moving smoothly to make room before the new
entry fades in.

**Expected:** Animate the inserted row's occupied space and visibility, as
described by the TODO marked complete.

Evidence: [browser audit results](feature-audit/evidence/results.json).

## 8. Finished-download section is not foldable

**Severity:** Low

Finished downloads correctly move to the Download History tab, but that
section has no disclosure control and cannot be folded despite the TODO being
marked complete.

**Expected:** Either make the finished section foldable or update the TODO to
record the tab-based design as the accepted replacement.

Evidence: [supplemental results](feature-audit/evidence/supplement.json).

## 9. [Resolved] Download URLs could inject JavaScript into row actions

**Severity:** High

**Status:** Resolved and verified on 2026-09-07.

Before the fix, download URLs were HTML-escaped and then interpolated into
inline `onclick` handlers for Open URL, Continue, Reload, and Copy URL. HTML
entity decoding happened before the JavaScript handler was compiled, so an
apostrophe in a URL broke the handler. A crafted URL could append and execute
arbitrary JavaScript when one of these actions was clicked.

The recheck used a harmless payload that set a marker on `window`. Clicking
Reload executed the marker, confirming stored script execution in the VDL
origin. A URL containing only an apostrophe also produced a JavaScript syntax
error and prevented Reload from sending a request.

**Expected:** Treat URLs as data rather than executable markup. Row actions
must work for valid URLs containing apostrophes, and no URL text may execute as
JavaScript.

**Reproduction:** Submit a URL containing an apostrophe and allow it to reach a
terminal state. Open its action menu and click Reload, Continue, Open URL, or
Copy URL. Inspect the inline handler and the browser's page errors.

URL actions now store the URL in an escaped data attribute and a delegated
click handler reads it as data. Open URL additionally accepts only HTTP and
HTTPS URLs. Apostrophes and markup characters round-trip without becoming
executable JavaScript.

## 10. Stale URL probes overwrite newer or cleared Download Options

**Severity:** Medium

Each URL edit starts an asynchronous `/api/probe` request, but responses are
not associated with the URL that initiated them. If probe A is slow and probe
B finishes first, A can later append its title, qualities, and containers to
B's options. Clearing the URL while a probe is in flight also allows the late
response to repopulate and re-enable the otherwise-empty Options panel.

The recheck delayed probe A and allowed probe B to return immediately. The
input still contained B, but the filename hint showed A and the Quality menu
contained results from both requests. In a second run, clearing the input was
followed by A's qualities reappearing in an enabled selector.

**Expected:** Only the latest probe may update Download Options. Clearing or
changing the URL must cancel or invalidate all earlier responses.

**Reproduction:** Enter URL A, wait for its probe to start, then enter URL B or
clear the input before A completes. Arrange for A to respond last and inspect
the title hint and quality selector.

## 11. An open row menu can leave live download state stale

**Severity:** Medium

`fetchHistory()` returns immediately whenever any row action menu is open.
SSE change events received during that interval are discarded, and closing
the menu does not schedule a reconciliation. If a download finishes while its
menu is open, the UI can continue showing it in Current indefinitely even
though the API reports `finished`.

The recheck held a menu open until a slow download completed. The API reported
`finished`, but the item stayed in Current after the menu closed. Calling
`fetchHistory()` manually moved it to History.

**Expected:** Defer one refresh while a menu is open and run it when the menu
closes, or update the row without disrupting the open menu.

**Reproduction:** Start a slow download, open its action menu, and keep it open
until `/api/history` reports `finished`. Close the menu and observe that the
row remains in Current until another refresh occurs.

## 12. Failed download submissions silently clear the form

**Severity:** Medium

The submit handler parses every `/api/download` response and resets the URL and
options without checking `response.ok`. An HTTP error response is therefore
treated like a successful start. The user's URL disappears, no error is shown,
and the unavailable-server banner stays hidden because the server did respond.

The recheck intercepted `/api/download` with an HTTP 500 JSON response. The URL
field was cleared and the response's error message was absent from the page.

**Expected:** Preserve the entered URL and options after a rejected request and
show the server-provided error message.

**Reproduction:** Make `/api/download` return HTTP 400 or 500 with a JSON error,
then submit a valid-looking URL through the form.

## 13. Special characters are double-escaped in the filename hint

**Severity:** Low

The title returned by `/api/probe` is HTML-escaped before being assigned to the
input's `placeholder` property. Property assignment does not need HTML
escaping, so characters such as `&` and `<` appear as literal `&amp;` and
`&lt;` text.

**Expected:** The filename hint should display the title's original text.

**Reproduction:** Probe a source whose title contains `&` or `<` and inspect
the Title/Filename placeholder.

## Minor UI differences

- In inline rename mode, Cancel appears to the right of Save, while the TODO
  specifies an X to the left of the tick.
- With no URL entered, Download Options shows the explanatory message as an
  overlay over visible disabled fields rather than showing an empty section.

The Debian package-server DNS failure seen while building `Dockerfile.vdl` is
not listed as an application bug. The same hosts were unreachable from the
test host, and the Dockerfile could not be assessed on a network with working
Debian repositories.
