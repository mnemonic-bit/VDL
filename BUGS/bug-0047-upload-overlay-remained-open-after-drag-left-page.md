## 47. [Resolved] Upload overlay remained open after a file drag left the page

**Severity:** Medium

**Status:** Resolved in version `0.32.2`, deployed and verified on 2026-10-10.

Dragging a local video anywhere over the page displays a full-screen upload
overlay with the message **Drop video to add it**. Before this fix, withdrawing
the file from the browser without dropping it could leave that modal overlay
open indefinitely and block normal page interaction.

### Reproduction

1. Drag a local video file from the desktop over the application page.
2. Wait for the **Drop video to add it** overlay to appear.
3. Move the file back outside the browser page without dropping it.

**Actual:** The upload overlay remains visible even though the file is no
longer over the page.

**Expected:** The overlay should close as soon as the complete file drag leaves
the page. Moving between elements inside the page should not close it.

### Diagnosis

The document-level drag handlers used a depth counter so `dragleave` events
caused by movement between descendant elements would not dismiss the overlay.
Opening the modal and moving across page descendants could produce multiple
`dragenter` events before the final page exit. That exit produced one terminal
`dragleave`, decrementing the counter without reaching zero, so the overlay
remained open.

The terminal event already distinguishes a complete page exit: its
`relatedTarget` is null because the drag is not entering another document
element. The old handler ignored that boundary and treated it like an ordinary
descendant transition.

### Resolution

The `dragleave` handler now treats a missing related target as authoritative
when a file drag is active. It clears the entire drag depth and closes the
overlay immediately. Ordinary transitions with an in-document related target
continue to decrement the nesting counter, preserving the overlay while the
file moves within the page.

The exit cleanup runs before inspecting the event's current data-transfer
types, because browsers need not keep exposing those types after an external
drag has left the document.

### Verification

- A Playwright regression emits nested file `dragenter` events followed by a
  page-exit `dragleave` and verifies that the upload overlay is hidden. It
  failed before the fix and passes afterward.
- The complete upload browser spec passes all 3 tests.
- The unit suite passes 173 tests with 5 expected media skips; `vdl.py` line
  coverage is 90.4%, above the enforced 90% minimum under Python 3.12.
- Podman deployment health reports UI and API version `0.32.2` on
  `0.0.0.0:5000`.
- The reporter confirmed the deployed behavior on 2026-10-10.
