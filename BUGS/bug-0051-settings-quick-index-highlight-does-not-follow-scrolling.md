## 51. [Open] Settings quick-index highlight does not follow scrolling

**Severity:** Low — navigation feedback is misleading

**Status:** Open; reported on 2026-10-21. Not yet independently reproduced.

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

This report changes documentation only and does not change `VERSION`.
