## 34. [Resolved] Download workflow redesign left modal and visual-hierarchy regressions

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-27.

Moving the URL form into the New download dialog made downloaded content the
page's primary focus, but the follow-up interaction pass exposed three UI
regressions:

- Opening the native quality selector could immediately dismiss the dialog.
  The backdrop-click handler inferred an outside click from viewport
  coordinates, while native select popups can bubble a click with synthetic
  zero coordinates.
- The Current Downloads drawer appeared abruptly instead of entering from its
  anchored right edge.
- The visible `Download History` heading repeated the meaning of the main
  content pane and weakened the intended content-first hierarchy.

The URL draft also needed an explicit lifecycle: closing the dialog before a
download starts must preserve the draft, while an accepted download must clear
the form before the next opening.

**Expected:** Controls inside New download never dismiss it; cancelled or
accidental closure preserves the draft; accepted submissions clear it; Current
Downloads slides in from the right unless reduced motion is requested; and the
main content begins directly with its useful controls and downloaded content.

**Reproduction:** Paste a URL into New download and open the quality selector.
Before the fix, the selector click could close the dialog. Reopen the dialog to
inspect the draft lifecycle, open Current Downloads to observe its abrupt
appearance, and compare the redundant History heading with the surrounding
page context.

The dialog now treats only clicks whose target is the dialog element itself as
backdrop clicks. Drafts survive Escape and other pre-submission closure, while
successful submissions continue to reset the form. Current Downloads uses a
280 ms right-edge entrance with a fading backdrop and a
`prefers-reduced-motion` fallback. The visible History heading and its spacing
were removed, while the content region retains an accessible name.

Permanent coverage: `tests/browser/download-form.spec.cjs`,
`tests/browser/download-options.spec.cjs`, and
`tests/browser/history-actions.spec.cjs`.
