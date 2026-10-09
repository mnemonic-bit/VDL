## 46. [Resolved] History Info tag selection closed the popover and Escape exited macOS fullscreen

**Severity:** Medium

**Status:** Resolved in version `0.32.1`, deployed and verified on 2026-10-10.

The History Info popover allows users to edit a video's tags without leaving
its details. Two event-handling defects made that interaction unexpectedly
close UI state outside the tag editor: choosing an existing tag closed the
entire Info popover, and pressing Escape to close Info in Firefox on macOS also
allowed the browser to leave application fullscreen.

### Reproduction

#### Choosing a known tag closes Info

1. Attach a tag to any video so that it appears in the known-tag suggestions.
2. Open another video's three-dot menu and select **Info**.
3. Select **Add tags**.
4. Choose the known tag from the suggestion list.

**Actual:** The tag is saved, but the Info popover closes immediately.

**Expected:** The tag should be added while the Info popover remains open. The
user should decide when to close Info.

#### Escape also leaves macOS fullscreen

1. Put Firefox into macOS application fullscreen.
2. Open a video's **Info** popover.
3. Press Escape while focus is not in a tag-editing field.

**Actual:** Info closes, but Firefox also leaves application fullscreen and
returns to a smaller window.

**Expected:** Escape should close Info without triggering Firefox's default
fullscreen action. Escape within the tag input should continue to cancel only
the transient tag edit and leave Info open.

### Diagnosis

- A suggestion click called `tagCommit()`, which cleared the tag input and
  synchronously rebuilt the suggestion list. That detached the clicked button
  while its click event was still bubbling.
- The document-level outside-click handler subsequently evaluated the detached
  event target. Because the target no longer had the Info popover in its DOM
  ancestry, the handler treated the in-popover click as an outside click and
  closed Info.
- The document-level Escape handler closed Info without calling
  `preventDefault()`. Other application layers already canceled their handled
  Escape events, but the Info branch allowed Firefox to perform its native
  fullscreen action after the application handler returned.

### Resolution

- The known-tag suggestion click now stops propagation before committing the
  tag. The synchronous suggestion rebuild can no longer reach and confuse the
  outside-popover handler.
- The Info Escape branch now prevents the browser default before closing the
  popover. The existing tag-input Escape handler remains authoritative while a
  tag edit is active.
- Added browser regressions that select a known tag through the real Info UI
  and assert that the popover remains visible, and that verify a handled Info
  Escape event is canceled before it reaches the browser default action.

### Verification

- The focused Playwright regressions failed on both original behaviors and
  passed after the event-handling changes.
- The complete browser suite passed all 103 tests.
- The unit suite passed 173 tests with 5 expected media skips; `vdl.py` line
  coverage was 90.4%, above the enforced 90% minimum. The same result was
  confirmed with Python 3.12 in the project image.
- Podman deployment health reported UI and API version `0.32.1` on
  `0.0.0.0:5000`.
- The reporter confirmed that both interactions work in Firefox on macOS after
  deployment.

