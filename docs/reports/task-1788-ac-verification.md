---
task: TASK-1788
title: Files tab, and a way back out of every detail view
verified: 2026-09-09
session: SESSION-1788920681005-91
note: verified retroactively — the code shipped in companion #78 and the task record never closed
---

# AC verification — TASK-1788

**Done: 6/7. Needs a human: 1 (AC-7). Blockers: none.**
Held at IMPLEMENTED — an unticked criterion blocks DONE even on a proven merge.

Merged long before this session: `d0d3ae4` (companion #78), asserted an ancestor
of `origin/main`. Nothing was implemented here.

## Criteria

| AC | Class | Verdict | Evidence |
|---|---|---|---|
| AC-1 | machine | ✅ | `api.ts:418` sends `include=all` unconditionally; the live adapter answers it with 796 entries carrying both `api.ts` and `.md` files |
| AC-2 | machine | ✅ | A `.ts` renders verbatim; a `.png` renders `doc-binary`. **Two controls** beside them: a `.md` DOES go through the renderer, and a real failure is still `error-state` |
| AC-3 | machine | ✅ | Breadcrumb href `/workspaces/remote-workflow`, text names it. **Control:** with an origin carried it does NOT read "Projects" |
| AC-4 | machine | ✅ | Four shapes of the no-origin case: cold deep link, malformed state, empty `to`, and destination-without-name — each falls back to a working, non-empty link |
| AC-5 | machine | ✅ | "closes the commit panel without needing the row it came from" — close, assert idle, row never touched; a second test proves another panel still opens |
| AC-6 | machine | ✅ | Three links, proven separately — see below |
| **AC-7** | **human** | **⬜ not done** | No human in this loop. Carried forward |

Fresh run of the three files carrying these criteria: 64 tests, 3 files, green.

## AC-6 — assembled from three separate proofs

The criterion spans a client, an old server and a rendering, and no single test
covers all three. Each link was proven at its own surface:

1. **The client always asks for everything** — `api.ts:418`, whose comment names
   this exact degradation and the vendored-bundle lag behind it.
2. **An old adapter answers markdown** — proven live today by rebuilding the
   adapter at `a397065^` and running it on port 7399: `include=all` → 200 with 58
   entries, all `.md`, against 796 from the current one.
3. **The UI renders a markdown-only list as a tree, not an error** —
   `workspace-docs.test.tsx`, whose `DOCS` fixture is three `.md` paths, with
   `error-state` asserted absent.

## A correction worth recording

The first pass of this verification reported AC-5 as untested. That was wrong:
the search was for the string `Close commit detail` — the button's `aria-label` —
while the test drives the control by its `data-testid`. The test was there all
along, and named the property almost verbatim.

Worth writing down because the failure mode is the interesting one: a grep for
the wrong attribute reports *absence of a test* just as confidently as a real
gap, and the honest-looking next step is to write a duplicate.

## AC-7 — what remains

*"Butter opens a workspace, clicks a task, and gets back to that workspace's Tasks
tab in one click."* AC-3 and AC-4 prove the breadcrumb computes the right
destination; only a person can say whether the way back is actually findable in
the packaged window, which has no address bar and no browser back button.

The task's own Test Plan asks for it to be batched with TASK-1782 AC-5,
TASK-1764 AC-6 and TASK-1786 AC-1. Carried forward as its own task, which should
be run in the same sitting as TASK-1916 and TASK-1917.
