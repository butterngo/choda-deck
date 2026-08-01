# TASK-1555 — AC verification

**Task:** Element picker: point at broken UI, capture selector + computed styles + crop for Claude
**Session:** SESSION-1785559101427-31 · **Branch:** `feat/task-1555-element-picker` · **PR:** #232
**Commit:** `7cca20e`
**Run:** unattended, via `/choda-burn-backlog`

**Verdict: 5 of 8 criteria met.** Three are unticked, for three *different* reasons —
one needs a real browser, one needs a real human, and one sits in a file that has no
test harness at all. The task holds at **IMPLEMENTED**, not DONE.

---

## Per-criterion

| # | Criterion | Class | Verdict |
|---|-----------|-------|---------|
| AC-1 | Hover highlights, click freezes, Escape cancels cleanly | machine | ✅ ticked |
| AC-2 | Selector round-trips via `querySelector` | machine | ✅ ticked (shadow-root limit recorded) |
| AC-3 | Curated computed-style subset, asserted so it can't grow | machine | ✅ ticked |
| AC-4 | Screenshot cropped to the rect; **artifact pixel dimensions asserted** | mixed | ⬜ **not ticked** |
| AC-5 | Origin stamped at pick, not send | machine | ✅ ticked |
| AC-6 | Tab switch / Remove clears the pending pick | **untestable here** | ⬜ **not ticked** |
| AC-7 | Closed shadow root, no stylesheet added to the host page | machine | ✅ ticked |
| AC-8 | Live check in a signed-in Chrome | **human** | ⬜ not ticked |

---

## AC-4 — the maths is proven, the criterion is not

The criterion has two halves and only one is reachable here.

**Proven:** `cropRect` — 8 tests. DPR 1 passthrough, DPR 2 doubling, clamping against
the captured bitmap in both directions, negative-origin clamping for a partly
scrolled-off element, `null` for a fully off-screen element, `null` for a zero-area rect
(a zero-size crop throws in canvas), and a nonsense DPR treated as 1 rather than
collapsing the crop. One test asserts `crop.width === pick.rect.width`.

**Not proven:** *"Assert the artifact's pixel dimensions against the reported rect."* The
artifact only exists after `chrome.tabs.captureVisibleTab` → `createImageBitmap` →
`canvas.drawImage` → `toDataURL`. happy-dom's canvas is a stub; none of that chain runs
outside a real browser.

Ticking this on the maths alone would substitute a proxy for the stated check. The DPR
case is exactly why that matters: cropping with raw CSS pixels on a retina display yields
the **top-left quarter** of the element — an artifact that looks plausible until someone
measures it. The criterion asks for the measurement precisely because eyeballing fails.

## AC-6 — the code is written, the harness does not exist

`clearPick()` is called from `chrome.tabs.onActivated` and from the Clear button, and
resets `pendingPick`, `pickShotDataUrl`, the summary, the canvas and the button. That is
inspection, not verification.

`extension/popup.js` is 1,300 lines with **no test harness**, and TASK-1549's session
already named it as the place this class of bug keeps landing ("all four bugs in the
#224/#225 round lived in that untested space"). Ticking a criterion because the code
*looks* right is the exact habit that produced those four.

The underlying rule is enforced where it *can* be: the picker library stamps origin at
pick time and AC-5's test proves it discriminates. What is unverified is the panel-level
lifecycle — that a tab switch actually reaches `clearPick` before the next Send.

Fixing this properly means giving `popup.js` a harness, which is a task of its own and
well outside this one's scope. Carried forward.

## AC-8 — human-class

No human and no browser in an unattended loop. The untested surface is the whole
integration: `executeScript({ files: PICKER_FILES })` resolving `globalThis.ChodaPicker`
in a real page's isolated world, the overlay rendering above a real site's own
`z-index` stacking, and the promise-based pick channel surviving a real click.

---

## Gates

| Gate | Result |
|------|--------|
| `pnpm run typecheck` | exit 0, run bare |
| Extension suite | **18 files / 346 tests**, exit 0 (was 17 / 310) |
| Server-side | 9 new dispatcher tests for the `element` capture kind |
| Full suite | **127/127 files ran**, exit 0 |
| `pnpm run lint` | exit 0, run bare |
| `pnpm run build:mcp` / `build:companion` | both exit 0 |
| `node --check` | clean on `picker.js` and `popup.js` |
| CI (PR #232) | ubuntu-latest **pass**; windows-latest per PR record |

File coverage verified by diffing `findTestFiles()` against the JSON reporter, not by
reading the summary line.

---

## Findings worth keeping

**Three unticked criteria, three different causes — and the distinction matters.** AC-8
needs a person. AC-4 needs a browser but no judgement, so it could be automated later with
a headless-Chrome harness. AC-6 needs neither: it needs `popup.js` to become testable.
Collapsing all three into "deferred" would hide that two of them are fixable by
engineering rather than by scheduling someone's attention.

**A criterion that names its own evidence format is doing real work.** AC-4 says "assert
the artifact's pixel dimensions", not "crop correctly". That phrasing is what stopped a
tick here — the maths test passes, and without the explicit evidence requirement it would
have read as sufficient.

**`preventDefault` on a capture-phase click is load-bearing, not defensive.** Picking a
submit button or a link would otherwise navigate the page away mid-capture, destroying
the thing being reported. Easy to omit; impossible to notice until someone picks the
wrong element.

**Cloning/isolation keeps recurring as the correctness rule in this subsystem.**
TASK-1553's `cleanSubtree` clones before stripping; this task's overlay lives in a closed
shadow root and touches no page style. Both are the same principle — a capture tool must
not alter what it is capturing — and both are cheap to get wrong in a way that produces
plausible-looking output.
