## 13. [Resolved] Special characters were double-escaped in the filename hint

**Severity:** Low

**Status:** Resolved and verified on 2026-09-15.

The title returned by `/api/probe` was HTML-escaped before being assigned to
the input's `placeholder` property. Property assignment does not parse HTML,
so characters such as `&` and `<` appeared as literal `&amp;` and `&lt;` text.

**Expected:** The filename hint should display the title's original text.

**Reproduction:** Probe a source whose title contains `&` or `<` and inspect
the Title/Filename placeholder.

Permanent coverage: `tests/browser/download-options.spec.cjs`.

The filename hint now assigns the probe title directly to the DOM property,
preserving the original text without introducing an HTML-injection sink.

