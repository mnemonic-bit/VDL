## 7. [Resolved] History insertion animation does not make room before revealing the row

**Severity:** Low

**Status:** Resolved and verified on 2026-09-15.

The item animation changes opacity only. The list layout changes immediately,
so existing rows jump rather than moving smoothly to make room before the new
entry fades in.

**Expected:** Animate the inserted row's occupied space and visibility, as
described by the TODO marked complete.

Permanent coverage: `tests/browser/live-updates.spec.cjs`.

New rows now expand from zero to their measured height while hidden, then
fade in after the surrounding list has made room. The temporary height limit
is removed when the animation finishes so row content remains unconstrained.

