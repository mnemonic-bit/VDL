## 68. [Resolved] Redundant Plus button in the download header

**Severity:** Low — unnecessary header control; the existing paste workflow
must remain available when the control is removed.

**Status:** Fixed in `0.50.3` on 2026-10-30. Reported against repository
version `0.50.2`. A browser regression first failed because the redundant
header button was present.

**Related:** [Bug 0039](bug-0039-header-download-actions-occupied-space-without-useful-state.md)
introduced the compact circular New download button. This request supersedes
that report's requirement to keep the button visible.

### Reported behavior

The green **Plus (+)** button for **New download** is no longer needed and
should disappear from the header. All other application functionality should
stay the same. In particular, users must still be able to paste a URL while
the application is visible and open the same Download dialog with that URL.

### Reproduction

1. Sign in and view the main application page.
2. Observe the circular Plus button in the header, labeled **New download**
   for assistive technology.
3. Copy a supported video URL, focus the application outside an editable
   control, and press **Ctrl+V** (or **Cmd+V** on macOS).
4. Confirm that the existing New download dialog opens with the pasted URL.

**Actual:** The header still presents the redundant Plus button alongside
the existing paste entry point.

**Expected:** The Plus button is absent. Pasting a URL into the focused main
application page still opens the same dialog, fills its URL field, and retains
the existing probing, options, and download submission behavior.

### Source evidence and repair scope at report creation

- [`templates/index.html`](../templates/index.html#L281) renders
  `#newDownloadButton` with the shared `#i-plus` icon and calls
  `openNewDownload()`. Remove this header control and its layout footprint.
  Other uses of the shared plus icon, including playlist actions, remain.
- The page's [`keydown` handler](../static/app.js#L6644) already recognizes
  Ctrl/Cmd+V outside editable controls and calls `openNewDownload()`.
  Preserve this path and native paste into the focused URL field. Existing
  editable-control and modal guards remain part of the behavior.
- [`openNewDownload()`](../static/app.js#L6664) and the dialog's close handler
  directly update the button's `aria-expanded` attribute. The Current
  downloads close handler also uses the button as a focus fallback. Removing
  the markup alone would leave these references broken. Remove or adapt
  those dependencies and return focus to an appropriate surviving control.
- Browser helpers and expectations currently click or measure the button,
  including `tests/browser/support.cjs`, `history-actions.spec.cjs`,
  `tags.spec.cjs`, and `upload-drop.spec.cjs`. Update affected coverage to use
  surviving entry points and verify the resulting header layout.

### Acceptance criteria and regression coverage

- The New download Plus button is absent visually and from keyboard navigation
  and the accessibility tree, with no empty header slot at desktop or mobile
  widths, in light and dark themes. No replacement header control is added.
- With the main page focused outside an editable control, one Ctrl+V or Cmd+V
  opens the existing Download dialog and pastes the clipboard URL into its
  focused URL field. Opening and closing produces no missing-element errors.
- Metadata probing, download options, validation, submission, success closure,
  error feedback, and draft preservation keep their existing behavior.
- Paste inside an input, textarea, or contenteditable element retains its
  normal editing behavior. Existing guards against stacking modal workflows
  remain intact; the page does not need background clipboard monitoring.
- Escape, backdrop dismissal, and explicit close continue to work. Focus
  returns to a usable surviving target after closing either Download or
  Current downloads, including when the Current downloads button disappears.
- Other entry points, including the empty-library action, and unrelated
  controls such as Current downloads and playlist creation keep working.
- Add browser regression coverage using actual clipboard paste, rather than
  invoking `openNewDownload()` directly, for the supported Ctrl/Cmd shortcuts,
  dialog population, one successful submission, editable-control behavior,
  and focus restoration without the Plus button. Adapt existing tests that
  require the removed control.

### Resolution

Removed the header button and its dedicated styles, including its mobile and
Settings rules. The shared plus icon remains available to playlist actions.
Removed the dialog's attribute updates against the deleted button. Both
Download and Current downloads restore their original focus target when it
is usable, or focus the surviving account menu button when the target is the
page, hidden, or removed.

The existing paste shortcut and download form behavior remain in place.
Browser helpers use the surviving shortcut, and affected header, search, and
upload tests no longer depend on the Plus control.

`tests/browser/download-entry.spec.cjs` covers absence and header spacing at
desktop/mobile widths in light/dark themes, native clipboard population and
submission, editable controls, modal guards, all three dismissal paths,
draft preservation, and focus restoration when a trigger disappears. Native
paste uses `ControlOrMeta+v`, selecting Ctrl on Linux/Windows and Cmd on macOS.

Validation on 2026-10-30: all 116 affected browser tests passed in Chromium
on Linux (the 17 new entry-point regressions plus existing download form,
options, header/history, search/tags, upload, and live-refresh tests).
`./tests/run-all.sh --unit` passed under Python 3.12: 391 tests, six skipped,
with `vdl.py` line coverage of **91.6%** (5,064/5,527 lines; minimum 90%).
