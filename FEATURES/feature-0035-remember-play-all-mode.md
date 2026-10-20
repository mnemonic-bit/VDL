# Remember the last Play All mode

**Source:** User-requested feature  
**Status:** Implemented
**Last refined:** 2026-10-16  
**Extends:** Feature 0030, Add shuffle playback to the Play All control

## Decision summary

Make the History header's split button remember whether the signed-in user last
started **Play All** or **Shuffle** from that control. Pressing its main segment
again starts the remembered mode. The main segment shows the play icon and
**Play All** label for sequential playback, or the shuffle icon and **Shuffle**
label for shuffle playback. The dropdown continues to offer both explicit
choices and provides the way to switch modes.

Remember the choice per signed-in user in the current browser, including across
page reloads and later sign-ins. A user with no saved choice starts with **Play
All**. This changes the launch choice only: sequential playback still follows
the current History selection and ordering, and Shuffle still uses Feature
0030's authorized library pool, filters, and random handoff rules.

## User flow

1. On first use, the main segment says **Play All**, displays `#i-play`, and
   starts sequential playback.
2. The user opens the dropdown and chooses **Shuffle**. Shuffle starts
   immediately, and the main segment changes to **Shuffle** with `#i-shuffle`.
3. The next press of the main segment starts another Shuffle session without
   opening the dropdown. Reloading the page preserves this choice.
4. Choosing **Play All** from the dropdown starts sequential playback and
   changes the main segment back to **Play All** with `#i-play`. Later presses
   follow the current History selection in its existing sequence.

## Behavior contract

- Treat a main-segment press and either dropdown choice as explicit mode
  actions. The selected mode becomes the remembered mode when the action is
  invoked, even if session creation later fails or finds no playable item. A
  later press retries the chosen mode; a failed Shuffle attempt never silently
  starts Play All.
- Merely opening, closing, or navigating the dropdown does not change the
  remembered mode. Automatic video handoffs, retry/stop/player controls,
  direct video playback, and playlist playback do not change it either.
- The main segment dispatches to the same sequential or Shuffle start path as
  the corresponding dropdown item. Keep session creation, fullscreen launch,
  player error handling, and view counting defined by Feature 0030.
- Use the existing `#i-play` and `#i-shuffle` symbols in
  `templates/index.html`. Update the main segment's visible label, icon,
  accessible name, and tooltip together. Its accessible name is **Play All**
  or **Shuffle**, matching the action a press will start. The dropdown toggle
  retains **Choose playback mode** and its existing keyboard behavior.
- At narrow widths, where the visible label is hidden, the icon and accessible
  name still identify the selected action. The dropdown menu keeps both
  entries and their existing icons.

## Availability and errors

The main segment's enabled state follows its remembered mode:

| Remembered mode | Main segment is enabled when |
| --- | --- |
| Play All | The current History selection has a sequential candidate, as today. |
| Shuffle | The client has a potential Shuffle candidate under Feature 0030's existing availability check. |

The dropdown toggle is enabled whenever either mode may be attempted. Each
menu item keeps its own availability check. If the remembered mode is
unavailable while the other is available, leave the main segment disabled and
leave the dropdown enabled so the user can select the other mode. Do not
silently change the remembered choice or make the main segment start a mode
that its icon does not show. If the server rejects a Shuffle start after the
client enabled it, retain the Shuffle choice and show Feature 0030's existing
actionable error.

## Persistence

- Store one value, `sequential` or `shuffle`, in browser storage under a key
  scoped to the authenticated account's stable user ID. Do not use username,
  which can change. A different account using the same browser starts with
  its own saved choice or the Play All default.
- Read and apply the value during page initialization before the control is
  made interactive. An absent, malformed, or obsolete value defaults to
  `sequential` without preventing playback.
- Update the in-memory mode immediately on an explicit action, then attempt
  storage. If browser storage is unavailable or throws, keep the choice for
  the current page and allow playback; a later reload may use the default.
- No playback session ID, queue, History filter, private library data, or
  account name is stored with this choice. This is a per-browser preference;
  synchronizing it across devices is outside this feature.

## Implementation touchpoints

- `templates/index.html`: expose the current user's stable ID for the
  account-scoped storage key; keep the shared icon symbols.
- `static/app.js`: load and render the remembered mode, route the main action,
  update it after explicit starts, and compute the main button's mode-specific
  disabled state during History reconciliation.
- Existing playback-session APIs and server-side Shuffle preferences need no
  behavior change.

## Verification and acceptance criteria

1. With no saved choice, the main button shows **Play All** and starts the
   current sequential session.
2. Choosing **Shuffle** starts Shuffle, changes the main button's icon,
   visible label, tooltip, and accessible name, and makes its next press start
   Shuffle again.
3. Choosing **Play All** reverses those changes and makes later main-button
   presses sequential, using the current History selection and ordering.
4. The choice survives reload and signing out and back in on the same browser;
   two accounts on that browser retain independent choices.
5. Opening or dismissing the menu, automatic advancement, stopping, direct
   playback, and playlist playback leave the choice unchanged.
6. If the chosen mode is unavailable, the main segment is disabled, the other
   available menu action remains reachable, and no implicit fallback occurs.
7. Failed session creation leaves the chosen mode visible and retryable.
8. Keyboard and pointer activation, screen-reader names, mobile icon-only
   layout, and unavailable browser storage behave as specified.

Before marking implementation complete, run `./tests/run-all.sh --unit` and
verify the required 90% `vdl.py` line coverage, then run the relevant browser
tests for the split button. Implementation bumped `VERSION` from `0.38.0` to
`0.39.0` under `AGENTS.md`.
