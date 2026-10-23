## 51. [Resolved] Settings quick-index highlight does not follow scrolling

**Severity:** Low — navigation feedback is misleading

**Status:** Resolved in version `0.46.4` on 2026-10-23. Independently reproduced
in the deterministic browser fixture before the fix.

The left-hand quick-index on the Settings page scrolls upward until it sits
directly below the **Settings** title, then remains there while the user
continues through the options. However, its highlighted section does not
update to reflect the section currently at the top of the visible settings
list. This leaves the index indicating an earlier section after the user has
scrolled into another one.

### Reproduction to confirm

1. Open **Settings** at the top of the page and note the highlighted entry in
   the left-hand quick-index.
2. Scroll down until the quick-index reaches its sticky position below the
   **Settings** title.
3. Continue scrolling until a different options section occupies the top of
   the visible settings content.
4. Compare that section's name with the highlighted quick-index entry.
5. Continue across several section boundaries, then scroll back upward and
   repeat the comparison.

**Reported actual:** After the quick-index reaches its sticky position,
further scrolling does not update the highlighted section to match the
topmost visible options section.

**Expected:** The quick-index should continuously highlight the section that
occupies the top of the visible settings content as the user scrolls in either
direction. A section remains current while its options are at the top, even
if its own heading has already scrolled out of view. Once the next section
reaches that position, the highlight should move to that section.

### Scope and verification notes

- The sticky position beneath the **Settings** title is expected behavior;
  this report concerns the highlighted entry becoming stale during scrolling.
- Determine the current section from the visible options area, accounting for
  any fixed or sticky elements that obscure its top edge.
- Browser, browser version, operating system, and application version were
  not supplied with this report. Record them during independent reproduction.
- The cause has not been established. Confirm the behavior before choosing
  an implementation change.

### Acceptance criteria

- Exactly one quick-index entry is highlighted whenever settings sections
  are visible, matching the topmost visible options section.
- The highlight updates when scrolling down or up across section boundaries,
  both before and after the quick-index reaches its sticky position.
- A section taller than the viewport remains highlighted while its content
  still occupies the top of the visible options area.
- Clicking a quick-index entry still navigates to its section, and subsequent
  manual scrolling updates the highlight again.
- Verify the beginning and end of the settings list and different viewport
  heights. Include a browser regression covering downward and upward
  scrolling across multiple sections.

### Resolution

The active entry previously changed only on navigation clicks and searches;
no scroll listener kept it synchronized with the visible options. Scrolling
from General into Playback left General marked `aria-current="page"`.

The index now updates once per animation frame during document scrolling,
resizing, and Settings content size changes. It identifies the section at the
top of the options area, accounting for headers that overlap the content and
the mobile index. Tall sections remain current after their headings leave
view. At the page bottom, the highlight still reflects the topmost visible
section. Hidden search results are excluded; no match clears the active
entry. Opening Settings and changing search results also reconcile the index.
Section buttons and the player's Playback Settings action scroll to the same
visible-content boundary, preserving subsequent manual scroll tracking.

### Verification

- `tests/browser/settings-regressions.spec.cjs` reproduces the original failure
  and covers upward/downward scrolling, tall sections, page start/end, section
  navigation followed by manual scrolling, search/no-results, and reopening.
- Viewports: desktop `1000x500` and `1000x800`, mobile `390x650`.
- Existing `tests/browser/preferences.spec.cjs` remains covered, including
  section navigation, searching, sticky-header layout, and saving preferences.
- Smooth navigation and same-page resizing across desktop/mobile layouts are
  covered, including the 560px breakpoint and short final sections.
- All 16 combined Settings controls, navigation, and Preferences browser checks
  pass in Chromium, Firefox, and WebKit (48 passing cases).
- Required unit gate passed with Python 3.12.14: 319 tests, five optional media
  tests skipped, and `vdl.py` line coverage of 91.4% (minimum 90%).
