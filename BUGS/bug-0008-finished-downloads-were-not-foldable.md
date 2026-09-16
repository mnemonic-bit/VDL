## 8. [Resolved by product decision] Finished-download section is not foldable

**Severity:** Low

Finished downloads correctly move to the Download History tab, but that
section has no disclosure control and cannot be folded despite the TODO being
marked complete.

**Status:** Resolved on 2026-09-14. The separate Download History tab is the
accepted replacement for the older foldable-section design. `TODOs.md` and
`tests/README.md` record this contract.

Permanent coverage: `tests/browser/live-updates.spec.cjs` verifies movement
between Current and Download History.

