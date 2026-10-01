## 42. [Resolved] UI cleanup left navigation, preview, pagination, and authorization gaps

**Severity:** High

**Status:** Resolved incrementally in versions `0.24.0` through `0.24.5` on
2026-10-01.

A UI cleanup review found several small but related usability defects in the
header, service-status presentation, History previews, and pagination. The
same review also exposed an authorization defect: the destructive Danger Zone
was rendered for normal users, and its clear-history endpoints accepted their
requests.

The reported behavior comprised:

- The header presented the username, Preferences, and Sign out as separate
  controls alongside the global search and New download actions.
- The account control was not the rightmost header item.
- Server-unavailable information occupied a separate banner instead of the
  persistent footer status area.
- A UI/API version mismatch split its explanation and refresh action across
  multiple lines.
- Moving the pointer from a History preview onto its overlaid favorite star
  stopped the moving preview.
- The number of History videos per page was fixed rather than configurable.
- First- and last-page controls appeared when there were only three pages.
- Normal users could see the Danger Zone and could call both
  `/api/clear/preview` and `/api/clear`; the latter could remove finished and
  failed download entries and their files.

### Reproduction

1. Sign in and inspect the header. Observe the separate username,
   Preferences, and Sign out controls and their ordering relative to the
   primary actions.
2. Stop or replace the server while the page remains open. Observe the
   unavailable-server message away from the footer.
3. Load a page whose UI version differs from `/api/health`. Observe the
   mismatch explanation and refresh link wrapping as separate content.
4. Hover a finished video's thumbnail until its montage starts, then move the
   pointer onto the favorite star without leaving the card. Before the fix,
   the preview stops.
5. Populate History with more than ten entries. Observe that ten entries per
   page is fixed and that the first/last controls are visible at exactly three
   pages.
6. Sign in as a normal user and open Preferences. Before the fix, the Danger
   Zone and Clear History action are visible.
7. As that normal user, request `GET /api/clear/preview` and
   `POST /api/clear`. Before the fix, both return success instead of 403.

**Actual:** Secondary account actions crowded the header, transient service
status was detached from the footer, preview hover treated the overlaid star
as leaving the preview, pagination was inflexible and overexposed jump
controls, and a normal user could access a destructive administrator surface.

**Expected:** The username should open a rightmost account menu containing
Preferences and Sign out. Operational and version status should remain compact
in the footer. A preview should continue while the pointer is anywhere within
its thumbnail region, including the favorite star. Page size should be a
persisted choice, with long-range page controls reserved for more than three
pages. The Danger Zone and every backing endpoint must be administrator-only.

### Diagnosis

- Header actions had accumulated independently without a single account-menu
  boundary or explicit right-edge placement.
- Server availability and version mismatch used separate presentation paths
  instead of the existing persistent footer.
- The hover-preview `pointerout` handler used the preview button as its leave
  boundary. The absolutely positioned favorite control is a sibling inside
  the same wrapper, so entering it incorrectly looked like leaving the
  preview.
- History pagination used a constant page size, and the jump-control threshold
  compared the zero-based maximum page index as though it were a page count.
- The template's `is_admin` guard surrounded only Users, leaving the Danger
  Zone navigation and section unconditional. The clear-history routes also
  lacked the existing `@admin_required` decorator.

### Resolution

- Replaced the separate account actions with a username-triggered menu that
  contains Preferences and Sign out, and placed it at the far right of the
  header.
- Moved server-unavailable reporting into the footer and kept the version
  mismatch explanation and refresh link on one line.
- Made the preview wrapper the stable hover boundary, while leaving preview
  startup attached to the thumbnail itself. Moving over the favorite star no
  longer releases the preview.
- Added a persisted **Videos per page** dropdown with choices of 5, 10, 20,
  and 50. Changing it resets History to the first page.
- Kept first/last navigation hidden at three pages or fewer and exposed it
  only for longer result sets.
- Rendered the Danger Zone navigation and content only for administrators, and
  protect both clear-history endpoints with `@admin_required` so direct HTTP
  requests from normal users receive 403.

### Verification

- Browser coverage verifies account-menu placement and keyboard behavior,
  footer server/version status, preview continuity over the favorite star,
  page-size persistence, page clamping, and the first/last-control threshold.
- Backend coverage verifies page-size defaults and validation, plus absence of
  the Danger Zone markup and 403 responses from both clear-history endpoints
  for a normal user.
- The complete deterministic suite passed with 122 backend tests and 80
  browser tests. Five opt-in real-media tests remained skipped.
- The Podman deployment was rebuilt after each completed fix; the final health
  response reports version `0.24.5`.
