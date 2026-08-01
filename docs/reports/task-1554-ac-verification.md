# TASK-1554 — AC verification

**Task:** Design discovery: extract computed-style tokens from any site into a design.md
**Session:** SESSION-1785557730894-16 · **Branch:** `feat/task-1554-design-tokens` · **PR:** #231
**Commit:** `61f5ba1`
**Run:** unattended, via `/choda-burn-backlog`

**Verdict: 6 of 8 criteria met.** The two unticked are both human-class live checks
against real websites — structurally unprovable by an unattended runner with no browser.
The task holds at **IMPLEMENTED**, not DONE.

---

## Per-criterion

| # | Criterion | Class | Verdict |
|---|-----------|-------|---------|
| AC-1 | Works when stylesheets are cross-origin; `collectCss` returns near-nothing | machine | ✅ ticked (partial — see below) |
| AC-2 | Top-8 palette + type scale match a real site's visible design | **human** | ⬜ not ticked |
| AC-3 | Near-duplicate colours merge into one swatch | machine | ✅ ticked |
| AC-4 | Spacing clusters to a detected step; no grid when there isn't one | machine | ✅ ticked |
| AC-5 | Breakpoints re-sampled, not guessed from a framework | machine | ✅ ticked |
| AC-6 | `design.md` carries an explicit limits section | machine | ✅ ticked |
| AC-7 | Lands as knowledge with token JSON referenced by path | machine | ✅ ticked |
| AC-8 | Live check in a signed-in Chrome, two structurally different sites | **human** | ⬜ not ticked |

---

## AC-1 — ticked, with a stated partial

The criterion asks for extraction against a page whose stylesheets are *entirely
cross-origin*. **That exact scenario cannot be reproduced in this harness**, and the
reason is worth recording because it is counter-intuitive:

> happy-dom implements `getComputedStyle` **by walking `cssRules`**.

So patching a sheet to throw — the obvious way to simulate cross-origin — breaks
happy-dom's computed styles outright. No real engine behaves that way: a browser resolves
computed values internally, and a cross-origin sheet styles the page perfectly well while
`sheet.cssRules` throws. Verified empirically before writing the test, not assumed.

What is proven instead: **the two paths are independent.** The page's styles apply while
`document.styleSheets` gives `collectCss` nothing, and extraction still returns a full
palette and type scale. Three tests, with a discriminator in each direction:

- extraction succeeds on that page → the computed path works
- `serializeDom(document).css` is `''` on **that same page** → the authored path sees zero
- `collectCss` **does** return content for a same-origin `<style>` → the empty result
  above is caused by the sheet being unreachable, not by a broken serializer

A fourth test forces the extreme case (every computed read throwing) and asserts the walk
degrades to a partial token set with an `unreadable` count rather than aborting.

The real cross-origin case belongs to AC-8 and is unticked. Ticking AC-1 as fully proven
would have overstated a harness limitation as a verification.

## AC-2 and AC-8 — human-class, deliberately unticked

Both require looking at real websites and judging whether the extracted palette and type
scale match what the site visibly uses. There is no human in this loop, and no browser.

A green unit suite proves the clustering maths and the rendering; it says nothing about
whether the tokens pulled off `cohere.com` actually resemble Cohere. Ticking these on
test output is precisely how an unrun check becomes an invisible one.

The untested surface, specifically:

- `chrome.scripting.executeScript({ files: DESIGN_FILES })` resolving
  `globalThis.ChodaDesignTokens` in a real page's isolated world
- `getComputedStyle` returning `rgb()` in Chrome where happy-dom returns hex — both are
  handled by `parseColor` and unit-tested, but only against synthetic input
- Whether `COLOR_MERGE_DISTANCE = 12` is tuned correctly against a real design system.
  It merges the AC's stated trio and separates three clearly-distinct brand colours;
  whether it also keeps `blue-500` and `blue-600` apart on a real Tailwind site is
  **unknown**
- Whether the breakpoint probe's `documentElement.style.width` actually triggers a real
  site's media queries. It drives the layout viewport, which many responsive layouts
  follow, but a site keyed on the *visual* viewport will not respond — in which case the
  probe honestly reports no breakpoints rather than wrong ones

---

## Gates

| Gate | Result |
|------|--------|
| `pnpm run typecheck` | exit 0, run bare |
| Extension suite | **17 files / 310 tests**, exit 0 (was 15 / 237) |
| Full suite | **126/126 files ran**, exit 0 |
| `pnpm run lint` | exit 0 (caught an unused `el` binding on first run; fixed) |
| `pnpm run build:mcp` / `build:companion` | both exit 0 |
| `node --check` | clean on both new libs + `popup.js` |
| CI (PR #231) | ubuntu-latest **pass**; windows-latest per PR record |

File coverage was verified by diffing `findTestFiles()` against the JSON reporter's
`testResults`, not by reading vitest's summary line — the TASK-1514 lesson.

The unhandled worker-fork error seen locally during TASK-1553 **did not recur** here
(full suite exit 0), consistent with that run's finding that it was environmental rather
than caused by any change.

---

## Findings worth keeping

**A test harness can implement a browser API by a completely different mechanism than a
browser does, and that changes what your test proves.** happy-dom resolving computed
styles through `cssRules` inverts the exact relationship AC-1 is about. Worth probing the
environment's actual behaviour before designing a test around a simulated failure — a
five-line script settled it in seconds and would otherwise have produced a test that
looked rigorous and proved the opposite of its name.

**"No answer" has to be a first-class result.** Both `detectGrid` (returns `null` for
arbitrary spacing) and `detectBreakpoints` (returns `[]` with no resize hook) were written
to refuse rather than guess, and both have tests asserting the refusal. The `1px` grid
case is the sharpest: it would "detect" a grid on literally any page of integer values,
passing a naive test while telling the reader nothing.

**A "references the artifact" assertion needs an absence check.** The AC-7 test asserts
the entry body contains the `.design.json` path *and* does not contain `"usedOn"` /
`"merged"`. Without the second half, a body that inlined the entire token payload
alongside the path would pass — satisfying the letter of "referenced by path" while
defeating its purpose.
