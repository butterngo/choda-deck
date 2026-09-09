---
task: TASK-1787
title: Serve a workspace's whole tree, not only its .md files
verified: 2026-09-09
session: SESSION-1788919608515-78
note: verified retroactively — the code shipped in #258 and the task record never closed
---

# AC verification — TASK-1787

**Done: 7/7. Needs a human: none. Blockers: none.**

The work was already merged: `a397065` (PR #258), proven an ancestor of
`origin/main`. Nothing was implemented in this session. What was missing was the
verification, and that is what this report is.

## Criteria — all verified live against the running adapter, not against tests

The suite was not used as evidence. Every criterion below was exercised at its
own surface: an HTTP request to the adapter on 127.0.0.1:7338 serving the real
`choda-deck-companion` workspace.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | ✅ | `include=all` → **796** entries; no param → **58**. Strictly more, default unchanged |
| AC-2 | ✅ | `packages/web/src/api.ts` is in the listing; fetching it returns 200 and its real first line, not the old 400 |
| AC-3 | ✅ | `public/icon.png` listed as `{"binary":true,"size":21920}`, fetch → **415**. **Control:** `api.ts` → 200, so the refusal discriminates |
| AC-4 | ✅ | No `node_modules/`, `.git/`, `dist/` or `release/` path in the 796 |
| AC-5 | ✅ | `../../../Windows/win.ini` → 404; its percent-encoded form, `/etc/passwd`, `C:/Windows/win.ini` → 400. **Control:** a legitimate nested path → 200 |
| AC-6 | ✅ | See below — the stated proof target no longer existed |
| AC-7 | ✅ | `workspace-docs.ts:8-13` names the ADR-033 citation as a misattribution, corrected rather than deleted, and states the real reason |

## AC-6 — the proof target had expired, so one was rebuilt

The criterion says: *"Proven against the currently-running vendored bundle."*
That bundle now **has** the change — it answered `include=all` with 796. The
window the AC assumed closed at the 0.12.x releases, which was flagged when this
task was graded on 2026-09-08 and turned out to matter the very next day.

Rather than tick it on reasoning, the pre-change adapter was rebuilt:

```
git worktree add --detach /c/tmp/old-adapter a397065^      # add6a69
esbuild src/adapters/companion/index.ts …                  # 504.7 kB
CHODA_COMPANION_PORT=7399 node old-server.cjs              # same data dir
```

| adapter | request | answer |
|---|---|---|
| old (7399) | `include=all` | 200, **58** entries, all `.md` |
| old (7399) | no param | 200, **58** entries |
| new (7338) | `include=all` | 200, **796** entries |

The old bundle ignores the parameter and serves markdown — the degradation path
the `md` default exists to protect. The contrast against 796 in the same run is
what makes it discriminating rather than a coincidence of two equal numbers.

Torn down afterwards: process killed by port lookup (a `pkill` on Windows left it
running and holding the worktree's files), junction removed, worktree pruned,
temporary branch deleted. `git worktree list` shows only the main tree; 7399 is
down; the real adapter on 7338 is untouched.

## Findings — why this task was still open

The code shipped on 2026-08-26 in #258 and the task stayed TODO. Three of its
siblings did the same: TASK-1788 (#78), TASK-1789 (#80), TASK-1790 (#81).

On 2026-09-08 `/choda-plan` graded all four "ready", added two `blockedBy` edges
between them, and promoted them to READY — **without opening a single source
file**. The grounding step read ADRs and task bodies and never asked whether the
code existed. The dependency graph produced was an ordering of work that had
already been done, in the order it had already been done in.

The next morning's burn run caught it only because its §4 says to read the
sibling implementation before writing. Without that step it would have
"implemented" a feature that was already there, and ticked seven criteria on a
suite that passes because the behaviour already exists — every gate green, and
nothing anywhere reporting that the change was a no-op.

That is the failure family this whole chain of tasks has been about, reached from
a new direction: not a check that cannot fail, but a check that passes for the
wrong reason. **TASK-1734** — *"A session's record diverges from what happened,
and nothing announces it"* — is exactly this, and it is still in TODO.
