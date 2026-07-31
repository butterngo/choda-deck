# TASK-1553 — AC verification

**Task:** Grab text: readability extraction + DOM→markdown instead of whole-page dump
**Session:** SESSION-1785495848690-1 · **Branch:** `feat/task-1553-readability-markdown` · **PR:** #230
**Commits:** `52137de` (feature), `251d84f` (AC-1: route candidate collection through dom-walk)
**Run:** unattended, via `/choda-burn-backlog`

**Verdict: 5 of 7 criteria met.** One criterion (AC-3) is **not met and cannot be met as
written** — it is a specification defect, established by measurement, not an
implementation shortfall. One (AC-7) is human-driven and structurally unprovable by an
unattended runner. The task therefore holds at **IMPLEMENTED**, not DONE.

---

## Per-criterion

| # | Criterion | Class | Verdict |
|---|-----------|-------|---------|
| AC-1 | `dom-walk.js` exists, dual-mode, only traversal | machine | ✅ ticked |
| AC-2 | INBOX-1642 page: chrome removed, starts at article heading | machine | ✅ ticked |
| AC-3 | ≥70% size reduction, article intact | machine | ❌ **not met — AC is wrong** |
| AC-4 | Serializer round-trips structure | machine | ✅ ticked |
| AC-5 | `{ readability: false }` returns pre-change text verbatim | machine | ✅ ticked |
| AC-6 | No main content → full body, never empty | machine | ✅ ticked |
| AC-7 | Live check in a signed-in Chrome | **human** | ⬜ **not ticked** |

---

## AC-3 — the criterion is wrong, and this is the finding of the run

AC-3 asked for **"at least 70%"** size reduction. It was written from an estimate in the
task body — *"roughly 10KB of chrome wrapped around the actual article"*, with the
article guessed at ~2.5KB. Nobody had measured it.

Measured directly against the real `INBOX-1642` row in SQLite:

```
total chars       : 12065
article start idx :  2128   (marker "APR 15, 2025")
article end idx   : 10769   (marker "…in our developer documentation.")
chrome BEFORE     :  2128   (cookie banner + mega-menu)
article region    :  8641
chrome AFTER      :  1296   (recirculation + footer)
--- article share : 71.6%
--- max reduction : 28.4%
```

**The estimate was inverted.** The article is 71.6% of that capture; *all* chrome
together is 28.4%. A 70% reduction is unreachable by any correct implementation — it
would require deleting 42% of the article, which is the precise opposite of this task's
purpose.

Achieved: **32.2%** reduction (10,096 → 6,844 chars on the reconstructed fixture), with
every article paragraph, both pull quotes, the feature list and both `<h2>`s intact.
Slightly above the 28.4% text-region ceiling because markdown also collapses the runs of
blank lines `innerText` emitted between nav items.

**Not ticked, and the number in the test was not quietly restated to something the code
clears.** `readability.test.js` asserts against `MEASURED_CHROME_SHARE = 0.284` under a
renamed test, with a comment recording that AC-3's 70% is not being asserted and why.
Carried forward as a follow-up rather than closed.

The substantive intent behind AC-3 — *the chrome goes and the article survives* — **is**
proven, by AC-2's removal assertions plus the first-and-last-sentence survival test. It
is only the numeric threshold that is wrong.

## AC-7 — human-class, deliberately unticked

Requires reloading the unpacked extension in a signed-in Chrome and grabbing two real
pages. No human is in this loop. Ticking it on green unit tests is exactly how an unrun
check becomes an invisible one — the failure mode TASK-1551 → TASK-1552 exists to
prevent. Left unticked and carried forward.

Everything below AC-7 in the stack *is* proven: extraction, cleaning, serialization and
the fallback are all unit-covered. What is unproven is the wiring — that
`chrome.scripting.executeScript({ files })` injects the three libs into a real page's
isolated world and that `globalThis.ChodaReadability` resolves there. That path has no
test harness and is the specific thing a live check would establish.

---

## Gates

| Gate | Result |
|------|--------|
| `pnpm run typecheck` | exit 0, run bare |
| Extension suite | **15 files / 237 tests**, exit 0 (was 12 / 158) |
| Full suite | **124/124 files ran**, 1322 passed, 1 todo |
| `pnpm run lint` | exit 0, run bare |
| `pnpm run build:mcp` | exit 0 |
| `node --check` | clean on all new libs + `popup.js` |
| CI (PR #230) | **ubuntu-latest pass 1m13s · windows-latest pass 4m26s** |

File count rose 12 → 15, matching the three added test files — the TASK-1514 guard
confirms nothing was silently skipped.

### One pre-existing failure, investigated rather than assumed

The local full suite exits **1** on a single unhandled `Worker forks emitted error`,
with **zero test failures**. Discriminator run: excluding the three new test files, the
same error still occurs (120 passed of 121, exit 1). It therefore reproduces without
this change and is not attributable to it. CI is green on **both** runners, including
windows-latest, so it is local-environment-specific. Same class as **INBOX-1607**
(already filed). Noted and continued past, not silently swallowed.

---

## Findings worth keeping

**An unmeasured number in an AC is a liability.** AC-3's 70% survived task filing,
READY approval and a human review because it *sounded* plausible. One SQL query against
the row the task itself cited would have caught it. When a criterion cites a magnitude,
the filing session should measure it — the source was sitting in the database the whole
time.

**A criterion about how code is built needs a source-level assertion.** AC-1 says
dom-walk must be the only traversal. Nothing about the *output* differs between a
`dom-walk` traversal and a `querySelectorAll` one, so no behavioural test could ever
fail on it — and the first implementation did in fact still use `querySelectorAll` while
every test passed. `251d84f` fixes the code and adds a source-text guard.

**Cloning before cleaning is a correctness requirement, not tidiness.** A content script
shares the live DOM with the page. Stripping chrome in place would visibly dismantle the
user's page as a side effect of capturing it. Covered by a test that asserts the
original DOM still holds the `<nav>` after extraction.
