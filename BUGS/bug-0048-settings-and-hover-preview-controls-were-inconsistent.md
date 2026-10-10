## 48. [Resolved] Settings and hover-preview controls were inconsistent

**Severity:** Medium

**Status:** Resolved and deployed in version `0.32.5` on 2026-10-10.

Several related UI details made Settings and the video library feel internally
inconsistent. The account menu called the Settings destination **Preferences**,
the page repeated an unnecessary explanatory subtitle, its search field was
narrower than the option cards, and scrolling could move the Settings heading
and Back action out of reach. The library offered only fixed page sizes, while
hover previews waited too long, used lengthy excerpts, and continued showing
video quality when duration was more useful during playback.

Two layout regressions were identified while making the Settings header
persistent. The first implementation moved scrolling into the centered
Settings options container, which placed its scrollbar beside the cards rather
than at the browser's right edge. Returning scrolling to the document fixed
that, but the full-width sticky header then painted an empty background band
above the scrolling option cards, especially noticeable in the dark theme.

### Reproduction

#### Settings labeling and layout

1. Open the username menu in the application header.
2. Observe that the item leading to the Settings page is labeled
   **Preferences**.
3. Open it and compare the search field's right edge with the setting cards.
4. Scroll to the bottom of the page.

**Actual:** The destination label did not match the page title, the subtitle
added visual noise, the search field was narrower than the cards, and the
Settings heading and Back action scrolled away.

**Expected:** The menu and page should both say **Settings**, omit the redundant
subtitle, align the search field with the option column, and keep the heading
and Back action available throughout document scrolling.

During the first sticky-header revision, repeat step 4 and inspect the
scrollbar. It appeared at the right edge of the centered options area. During
the second revision, the browser scrollbar was restored, but scrolling option
cards passed beneath a full-width sticky background and left a dark empty band
to the right of the Settings heading.

The final layout keeps the heading as wide as the left section-navigation
column. Initially, the search row retains its full height between that heading
and the section labels. As the search field scrolls out, that gap collapses and
the labels stop beneath **Settings** while option cards continue scrolling in
the unobstructed right column.

#### Endless library scrolling

1. Open **Settings → General → Videos per page**.
2. Inspect the available values.

**Actual:** Only fixed sizes of 5, 10, 20, and 50 videos were available.

**Expected:** **Endless scrolling** should be available and should reveal the
next videos automatically as the user approaches the end of the library.

#### Hover-preview timing and labels

1. Return to the library and hover over a finished video with quality and
   duration metadata.
2. Observe the delay before its moving preview starts, the duration of each
   sampled excerpt, and the lower-right badge while it plays.

**Actual:** Preview loading waited 500 milliseconds, each of the seven excerpts
was three seconds long, and the quality badge remained visible during motion.

**Expected:** Preview loading should begin after 250 milliseconds, excerpts
should be two seconds long, and the video's total duration should replace
quality only while the moving preview is active.

### Diagnosis

- The account-menu label and Settings subtitle were static template text that
  had drifted from the page's established name and current content.
- `.settings-search` retained a 720-pixel maximum width even though the option
  column could grow wider.
- The Settings header participated in ordinary page flow, while only the
  section navigation was sticky. The initial fix combined a viewport-height
  Settings container with `body` overflow suppression and an inner
  `overflow-y: auto`, transferring scrollbar ownership away from the document.
- After restoring document scrolling, the sticky header remained a full-width
  block with an opaque themed background. Its stacking layer covered the
  otherwise usable space above the right option column.
- Page-size validation and rendering assumed that every preference was one of
  four numeric values and always sliced a single numbered page.
- The preview delay and excerpt duration were constants of 500 milliseconds
  and three seconds. History cards rendered quality but had no formatted media
  duration state to substitute while their preview video was playing.

### Resolution

- Renamed the account-menu item to **Settings** and removed the redundant page
  subtitle.
- Removed the search width cap so its edges match the settings-content column.
- Kept the browser document as the scroll owner and made the Settings heading
  sticky immediately below the fixed application header. The section labels
  retain their independent sticky stop beneath it.
- Limited the sticky heading's painted background to the desktop/tablet
  navigation-column width and to its content width on narrow screens. The
  search row remains in normal flow, preserving its initial vertical gap until
  it scrolls away.
- Added a persisted `endless` page-size value. The library initially renders
  ten videos, uses an intersection sentinel to request successive batches,
  falls back to a passive window-scroll check where needed, and hides the
  numbered pager. Search and preference changes reset the batch boundary, and
  sequential playback translates the visible position into bounded playback
  session coordinates.
- Reduced hover activation to 250 milliseconds and each of the seven generated
  excerpts to two seconds. Incremented the preview-cache version so existing
  three-second montages are not reused.
- Added compact `M:SS`/`H:MM:SS` duration formatting. Quality remains visible
  on the static thumbnail and is replaced by total duration only while the
  preview carries its active-playing state.

### Verification

- `tests/browser/preferences.spec.cjs` verifies the final menu copy, removed
  subtitle, search alignment, document-owned scrollbar, sticky Back action,
  navigation-column header width, initial search-height gap, and collapsed gap
  after the search field leaves the viewport.
- `tests/browser/history-pagination.spec.cjs` verifies that endless mode renders
  10 of 21 videos, reveals subsequent batches at the sentinel, hides numbered
  pagination, and removes the sentinel after all videos are visible.
- `tests/browser/history-actions.spec.cjs` verifies the 250-millisecond hover
  boundary, cache version, and quality-to-duration badge transition.
- Backend tests verify the persisted `endless` preference and two-second,
  seven-segment preview generation. The relevant browser suites passed 35
  tests.
- The Python 3.12 unit suite passed 173 tests with 5 expected media skips;
  `vdl.py` line coverage was 90.4%, above the enforced 90% minimum.
- Podman deployment health reports UI and API version `0.32.5` on
  `0.0.0.0:5000`.
