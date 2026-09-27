## 33. [Resolved] Current Downloads opens unexpectedly and retains a stale count

**Severity:** Low

**Status:** Resolved in version `0.14.1` on 2026-09-27.

The redesigned Current Downloads drawer has three related presentation
regressions. Starting a new download opens the drawer automatically, the drawer
begins below the fixed header even though it already covers the footer, and its
count badge remains visible after the final active download finishes.

The finished download itself moves into the main Download History pane without
a page reload. The stale badge therefore contradicts the content already shown
elsewhere in the same UI.

### Reproduction

1. Open the main page with no active downloads.
2. Submit a valid download URL.
3. Observe the Current Downloads drawer immediately after the request is
   accepted.
4. Close and reopen the drawer, then compare its top and bottom edges with the
   browser viewport.
5. Allow the only active download to finish and move into Download History.
6. Observe the count badge in the **Current downloads** button.
7. Repeat the drawer geometry check at a mobile viewport width.

### Actual

- A successful submission opens the Current Downloads drawer without the user
  selecting its button.
- The drawer covers the footer but starts below the fixed header: 64 pixels
  below the viewport top on desktop and 56 pixels below it on mobile.
- After the last active row moves to Download History, the count badge still
  displays `1` even though the drawer contains no active rows.

### Expected

- Starting a download should leave the main pane visible. The new download
  should be represented by the count in the Current Downloads button until the
  user chooses to open the drawer.
- The drawer should span the full viewport height, covering both the fixed
  header and footer, on desktop and mobile layouts.
- When no Current rows remain, the count badge should be removed rather than
  displaying a stale value.

### Root cause

`startDownload()` explicitly called `openCurrentDownloads()` after a successful
request. The drawer CSS fixed its top edge to the desktop or mobile header
height and subtracted the same value from its viewport height. Finally,
`fetchHistory()` correctly set the badge's `hidden` attribute when the active
count reached zero, but the author `.badge { display: inline-block; }` rule
overrode the user-agent `[hidden]` presentation, so the old text remained
visible.

### Resolution

Successful submissions now refresh history state without opening the drawer.
The drawer is anchored at the top of the viewport and uses the full dynamic
viewport height, with the mobile layout inheriting the same height behavior.
A `.badge[hidden]` rule ensures that the recalculated zero state removes the
badge visually as well as semantically.

Browser regressions verify that submitting a download leaves the drawer closed,
that the drawer reaches both viewport edges at desktop and mobile widths, and
that SSE reconciliation hides the badge after the final active download moves
to History.
