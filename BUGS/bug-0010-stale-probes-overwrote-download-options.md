## 10. [Resolved] Stale URL probes overwrite newer or cleared Download Options

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

Each URL edit starts an asynchronous `/api/probe` request, but responses are
not associated with the URL that initiated them. If probe A is slow and probe
B finishes first, A can later append its title, qualities, and containers to
B's options. Clearing the URL while a probe is in flight also allows the late
response to repopulate and re-enable the otherwise-empty Options panel.

The recheck delayed probe A and allowed probe B to return immediately. The
input still contained B, but the filename hint showed A and the Quality menu
contained results from both requests. In a second run, clearing the input was
followed by A's qualities reappearing in an enabled selector.

**Expected:** Only the latest probe may update Download Options. Clearing or
changing the URL must cancel or invalidate all earlier responses.

**Reproduction:** Enter URL A, wait for its probe to start, then enter URL B or
clear the input before A completes. Arrange for A to respond last and inspect
the title hint and quality selector.

Permanent coverage: `tests/browser/download-options.spec.cjs`.

Each scheduled probe now captures a generation number. URL edits, clearing,
pasting, and successful submissions invalidate the previous generation, and
probe callbacks update Download Options only while their generation remains
current.

