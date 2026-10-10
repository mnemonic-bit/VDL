## 39. [Resolved] Header download actions occupied space without useful state

**Severity:** Low

**Status:** Resolved and verified in version `0.17.3` on 2026-09-29.

The fixed header always rendered two large, labeled download actions. **New
download** used a green pill even though its plus icon already communicated
the action, and **Current downloads** remained visible when its drawer had no
rows to show. Together they consumed prominent header space without adding
useful information.

### Reproduction

1. Open the application with no active, paused, cancelled, or interrupted
   downloads.
2. Inspect the actions at the right side of the fixed header.
3. Observe that New download includes both a plus icon and its text label.
4. Select Current downloads and observe an empty drawer.

**Actual:** New download rendered as a wide labeled pill, and Current downloads
was always present even when its drawer was empty.

**Expected:** New download should be a compact green circular plus action with
an accessible name. Current downloads should be absent when it has nothing to
show and should appear as soon as a current download exists.

### Acceptance criteria

- Render New download as a 40-by-40-pixel green circle containing the shared
  `#i-plus` icon, without a visible text label.
- Preserve the New download button's `aria-label`, dialog relationship, focus
  return, hover state, and keyboard focus indicator.
- Hide Current downloads before the first history response so the empty action
  does not flash during page load.
- Reconcile Current downloads visibility after every History/SSE refresh.
- Show the action for active or paused downloads and for cancelled or
  interrupted rows that still expose the existing Continue workflow.
- Hide the action when the Current drawer has no rows, including after its last
  row moves to History.
- Preserve the current count badge, accessible item count, drawer behavior,
  reduced-motion handling, and responsive mobile layout whenever the action is
  visible.

### Resolution

The New download label was removed from the page shell, and its button now has
equal width and height with a circular radius while retaining its accessible
name. Current downloads starts with the native `hidden` attribute and has an
explicit CSS hidden-state rule because its flex display would otherwise
override the browser default. History reconciliation now removes that hidden
state only when the Current drawer contains rows and restores it when the list
becomes empty. If the button disappears while its drawer is closing, focus
falls back to New download rather than targeting a hidden control.

Cancelled and interrupted downloads intentionally keep Current downloads
visible: those resumable rows live only in that drawer, so hiding the action
would make Continue unreachable.

Permanent coverage: `tests/browser/history-actions.spec.cjs` verifies the
circular icon-only action, initial hidden state, current-row visibility, and
transition back to hidden. The affected History-actions, live-update,
action-error, Tags, and search interaction coverage passed in the browser
suite.
