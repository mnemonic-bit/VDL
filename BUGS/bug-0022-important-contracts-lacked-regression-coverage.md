## 22. [Resolved] Important backend, UI, and container contracts lacked regression coverage

**Severity:** Medium

**Status:** Resolved and verified on 2026-09-15.

The permanent suite is broad and all four tiers currently pass under the
documented expected-failure policy, but the coverage ledger overstates several
areas. In addition to Bugs 14-21 having no permanent red-capable tests, these
important contracts are unprotected:

- atomic and rejected backend transitions for pause, unpause, stop, resume, and
  remove (the browser test only proves which URL is called);
- upgrades from an older SQLite schema through every migration;
- history pagination and page-boundary behavior;
- UI rendering for matching, mismatched, missing, and malformed API versions;
- failed Preferences, Clear, Reload, Continue, Pause, Stop, and Delete requests;
- shipping-container parity for pause/unpause/cancel/resume and partial cleanup;
  the container tier runs only the real DASH merge lifecycle test; and
- cleanup failure behavior when a file cannot be removed.

There is also no coverage report or minimum threshold in the release gate, so
future code can silently introduce additional unexercised paths.

**Expected:** Add focused unit/browser/container tests at the real seams above,
give each open behavior bug an expected-failure regression until fixed, and
enforce a reviewed coverage baseline without treating line coverage alone as
proof of correctness.

Permanent coverage now includes:

- `tests/test_download_lifecycle.py` for accepted/rejected transitions,
  simultaneous Resume, and Resume/Remove races;
- `tests/test_migrations.py` for upgrades from the initial schema through every
  current migration;
- `tests/browser/history-pagination.spec.cjs` for ordering and page-boundary
  clamping;
- `tests/browser/version-status.spec.cjs` for matching, mismatched, missing,
  malformed, and unavailable API versions;
- `tests/browser/action-errors.spec.cjs` and
  `tests/browser/preferences.spec.cjs` for rejected UI actions;
- `tests/container/smoke.sh` for shipping-image lifecycle and partial cleanup
  parity;
- `tests/test_cancelled_cleanup.py` for cleanup failures; and
- `tests/coverage_gate.py` for a dependency-free reviewed 90% `vdl.py` line
  baseline in the unit/release gate.

The remaining expected failures were retired after rejected Pause, Stop,
Continue, Delete, Reload, and Clear actions began showing the server's error
without losing their rows or continuing a failed action chain. Artifact cleanup
now runs before its database row is removed; a filesystem failure returns an
error and retains the row so cleanup can be retried.

