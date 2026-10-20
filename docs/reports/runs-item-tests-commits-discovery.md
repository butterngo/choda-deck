---
requirement: Runs screen — an item row shows its tests and its commit's code change
started: 2026-10-20
workspace: Main
status: converged
---

# Discovery — Runs screen: an item row shows its tests and its commit's code change

Butter, 2026-10-20, on the companion Runs screen: "chưa thể hiện được cái test" and
"nếu có thể thì thấy được commit và code change". Mockup:
https://claude.ai/artifact/MZcAdez2hWLewKveSrBhsS · Thread: CONV-1792499678127-174

## Round 1 — Runs item tests + commits

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread opened at round 0, no messages yet | [conversation CONV-1792499678127-174] |
| user | the two problems, in Butter's words | chat 2026-10-20 |
| code | the Tests cell renders only the first passed line | choda-deck-companion/packages/web/src/views/RunsView.tsx:130 |
| code | the Commit cell renders only the short sha, no link | RunsView.tsx:120-122 |
| code | the adapter keeps only the newest handoff's first commit, and no workspace id | choda-deck/src/adapters/companion/runs.ts:183-197 (`toItem`) |
| data | 33 of 33 completed sessions under TASK-2501/2513/2534 carry `testResults`; 32 of 33 carry `commits` | live DB query 2026-10-20 |
| code | a commit detail route ALREADY exists: `GET /workspaces/:id/commits/:sha?patch=1` → files with insertions/deletions, hunks, binary/too-large omission, 404 for an unknown sha, 409 for a non-repo cwd, sha pattern guard | choda-deck/src/adapters/companion/workspace-commits.ts:418-520 |
| code | the companion ALREADY has the client and the diff renderer: `fetchWorkspaceCommit`, `useWorkspaceCommit`, `FileDiff`, `CommitFileView`, `CommitDetailPanel` | companion api.ts:1063-1071, hooks/use-workspace-commit.ts, components/FileDiff.tsx |
| code | the task page already lists a task's commits per session with their workspace id (provenance) | choda-deck/src/adapters/companion/task-provenance.ts:6-12, companion components/TaskProvenance.tsx:122-133 |
| code | no adapter code reads a git remote URL; a GitHub link is new | grep `remote get-url` in both repos: no git hit |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter's words + RunsView.tsx:130 shows passed[0] while 33/33 sessions hold full test lines | — |
| 2 | Scope & boundary | 7 | in: in-place row expansion, all test lines, commits with files and diff, GitHub link. Out not yet named | name what is out (test-case parsing languages, multi-repo items, editing) |
| 3 | Technical contract | 7 | commit detail route exists (workspace-commits.ts); gap: RunItem has no workspaceId and only commits[0]; GitHub URL not served | decide the RunItem additions and where the GitHub URL comes from |
| 4 | Prior art | 8 | TASK-1783/1791/1792 commit panel, TASK-1748 provenance, TASK-2531/2532 Runs | knowledge_search for ADRs on companion git reads / model calls |
| 5 | Edges & failure | 6 | known: 404 orphan, 409 non-repo, binary/too-large, commit null | multiple sessions per item, multiple commits, no suite line, non-GitHub remote, other machine |
| 6 | NFR | 5 | defaults apply; diff only on click, staleTime Infinity (use-workspace-commit.ts) | walk all 12 |
| 7 | Acceptance criteria | 3 | none written | blocked on #3 and #5 |

**TOTAL = MIN = 3** (dimension 7)
Previous round: — → this round: 3. New evidence? **YES** (9 sources) → may continue.

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 9 |
| 2 | Scope & boundary | 7 |
| 3 | Technical contract | 7 |
| 4 | Prior art | 8 |
| 5 | Edges & failure | 6 |
| 6 | NFR | 5 |
| 7 | Acceptance criteria | 3 |
| | **MIN** | **3** |

### Round 2 will look for exactly this
- RunItem contract: which sessions, which commits, the session's workspaceId (#3)
- Remote URL formats across registered workspaces → GitHub commit link rule (#3, #5)
- The formats of suite lines and test-class lines across every stored handoff (#5)
- Test-declaration shapes in the real repos' diffs: xUnit, vitest (#2, #5)
- ADRs on git reads and companion routes (#4)

## Round 2 — Runs item tests + commits

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | no new messages from Butter | [conversation CONV-1792499678127-174] |
| data | 188 completed sessions since 2026-10-01 carry `testResults`; only 85 have a suite-like line, and its wording varies ("full suite 672 passed 1 skipped", "dotnet test 329/329", "tsc 0, vitest 860/860, eslint 0, build 0", "Engine suite 690 pass / 0 fail / 1 skipped") | live DB query 2026-10-20 |
| data | 19 handoffs hold more than one commit; 14 tasks have more than one completed session; 0 sessions lack `workspace_id` | same query |
| git | every registered repo checked uses an https GitHub origin (choda-deck, choda-deck-companion, bpa-engine, remote-bpa, headless-cms, NewJuvenisMaxime, JuvenisMaxime.AI) | `git remote get-url origin` per repo |
| code | test declarations in the real repos are xUnit `[Fact]` / `[Theory]` (C#) and `it(` / `test(` (TS) | grep over JuvenisMaxime.AI and NewJuvenisMaxime |
| code | provenance already models a commit as `{ raw, sha, subject, workspaceId, sessionId }` across ALL sessions | choda-deck/src/adapters/companion/task-provenance.ts:41-50 |
| ADR/gotcha | the released companion runs a vendored adapter; a new field or route is absent until a release, so the web must degrade when it is missing | docs/knowledge/a-new-adapter-route-is-invisible-to-the-shipped-companion-and-the-only-signal-is.md |
| ADR/gotcha | adapter changes add zero MCP edits | docs/knowledge/companion-adapter-must-add-zero-mcp-edits.md |
| code | an optional new field/param, not a new route, is the precedent for extending the commit detail (TASK-1791 `patch=1`) | workspace-commits.ts:500-503 |

### Contract settled this round
- `RunItem.commits: { sha, subject, workspaceId, sessionId }[]` — every commit of every session on the item, newest session first, deduped by sha. `commit` stays for an older web bundle.
- Commit detail `GET /workspaces/:id/commits/:sha?patch=1` gains `webUrl: string | null` — `https://github.com/<owner>/<repo>/commit/<full sha>` when `origin` is a GitHub https or `git@github.com:` URL, else null. Credentials in an https remote are never echoed.
- Test cases added = names parsed client-side from the commit's ADDED lines: a C# method following `[Fact]` / `[Theory]`, a TS `it("…"` / `test("…"`. No other languages in v1.
- Diff loads on expand through the existing `useWorkspaceCommit`; `/runs` itself runs no git.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 8 | out: session_end schema, editing, other languages, commits not in a handoff | D1: how to treat the free-text suite line |
| 3 | Technical contract | 9 | above; reuses workspace-commits.ts route + provenance commit shape | — |
| 4 | Prior art | 9 | vendored-adapter gotcha, zero-MCP gotcha, TASK-1791 optional-param precedent, TASK-1748/1783/1792 | — |
| 5 | Edges & failure | 8 | multi-session (14), multi-commit (19), no suite line (103/188), non-GitHub remote → no link, old adapter → fall back to `commit`, 404 unreadable sha, 409 non-repo | D1 |
| 6 | NFR | 9 | 12/12: perf diff-on-click only, /runs adds no git; security bridge token + SHA_PATTERN + no remote credentials; availability/compliance/data n/a (internal, read-only, nothing stored); observability none (Assumed); errors 404/409 rendered; i18n English UI; a11y Enter expands row; maintainability reuses FileDiff; integration vendored adapter degrade | — |
| 7 | Acceptance criteria | 3 | not written — blocked on D1 | D1 answer, then write |

**TOTAL = MIN = 3** (dimension 7)
Previous round: 3 → this round: 3. New evidence? **YES** (9 sources).

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 9 | 9 |
| 2 | Scope & boundary | 7 | 8 |
| 3 | Technical contract | 7 | 9 |
| 4 | Prior art | 8 | 9 |
| 5 | Edges & failure | 6 | 8 |
| 6 | NFR | 5 | 9 |
| 7 | Acceptance criteria | 3 | 3 |
| | **MIN** | **3** | **3** |

### Stop — blocked on a human decision
D1. The suite total ("760 passed") is free text in only 85 of 188 handoffs, worded differently each time. Parse it, show lines verbatim, or make the autopilot write it in one fixed shape?
D2. A row click now expands in place instead of opening the task page (TASK-2532 AC-8 asserted the navigation). Confirm.

## Round 3 — Runs item tests + commits

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| user | D1: the autopilot writes the suite total in one fixed shape; the companion parses only that shape and shows older lines verbatim | AskUserQuestion answer, 2026-10-20 |
| user | D2: a row click expands in place; the task page link moves into the expansion (TASK-2532 AC-8 test changes) | AskUserQuestion answer, 2026-10-20 |
| skill | `testResults` is assembled in session-end §5 (`passed[]` / `skipped[]` with reason); autopilot §5.5 step 4 and burn-backlog step 3 call `session_end` | session-end/SKILL.md:130-132, choda-autopilot/SKILL.md:290, choda-burn-backlog/SKILL.md:258 |
| code | web `RunItem` mirrors the adapter's; `DiffHunk.lines[].kind` is `add/del/ctx`, so added lines are readable client-side | companion api.ts:2288-2297, 1008-1025 |

### Acceptance (draft, per subtask)
**A — adapter (main):** `runs.test.ts` an item with two sessions whose handoffs hold `["b2 two","b1 one"]` and `["a1 zero"]` serves `commits` with shas `b2, b1, a1` and each `workspaceId` of its session · a sha repeated across sessions appears once · `commit` is unchanged (`"b2 two"`) · `workspace-commits.test.ts` origin `https://github.com/o/r.git` → `webUrl` `https://github.com/o/r/commit/<40-char sha>` · `git@github.com:o/r.git` → same · `https://x:tok@github.com/o/r.git` → URL without `tok` · a GitLab origin → `webUrl: null` · no origin → `null` · lint/typecheck/test.
**C — skills (claude-skills):** session-end §5 states passed[0] is `full suite: N passed, M skipped, K failed`, or skipped gets `full suite: not run — <reason>` · autopilot and burn-backlog reference the rule at their session_end step · a grep for `full suite: N passed` finds all three files.
**B1 — web parsers (companion):** `parseSuiteLine("full suite: 760 passed, 1 skipped, 0 failed")` → `{passed:760, skipped:1, failed:0}` · `"dotnet test 329/329"` → `null` · `addedTestCases` on hunks with added `[Fact]` + `public async Task A_b_c()` → `["A b c"]`, `[Theory]` likewise · added `it("does x", …)` / `test('does y', …)` → `["does x","does y"]` · a removed or context `[Fact]` is not counted · lint/typecheck/test.
**B2 — Runs view (companion):** Tests cell shows `760 passed` from a fixed-shape line, or the first line + `+N more` otherwise · clicking a row sets `aria-expanded="true"` and does NOT navigate · the expansion lists every passed and skipped line · it lists the commit's added test-case names and their count · it lists each changed file with `+a` `−d` · clicking a file renders `FileDiff` lines · `webUrl` renders a link to it; `webUrl: null` or absent renders no link · an item without `commits` (old adapter) falls back to `commit` · a 404 commit renders "not readable on this machine" · a "Open task" link has href `/tasks/<id>` with `state.from.to === "/runs"` · lint/typecheck/test.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | D1 + D2 answered; out list from R2 | — |
| 3 | Technical contract | 9 | carried + web types read (api.ts:1008-1025, 2288) | — |
| 4 | Prior art | 9 | carried | — |
| 5 | Edges & failure | 9 | D1 closes the no-suite-line edge: old lines verbatim | — |
| 6 | NFR | 9 | carried | — |
| 7 | Acceptance criteria | 9 | above: every AC names its test file or surface, each has a failing input (verbatim line, GitLab origin, removed `[Fact]`, old adapter) | — |

**TOTAL = MIN = 9**. Previous 3 → 9. New evidence: YES (4).

### Score history
| # | Dimension | R1 | R2 | R3 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | 9 | 9 |
| 2 | Scope & boundary | 7 | 8 | 9 |
| 3 | Technical contract | 7 | 9 | 9 |
| 4 | Prior art | 8 | 9 | 9 |
| 5 | Edges & failure | 6 | 8 | 9 |
| 6 | NFR | 5 | 9 | 9 |
| 7 | Acceptance criteria | 3 | 3 | 9 |
| | **MIN** | **3** | **3** | **9** |

## All dimensions ≥ 9 after 3 rounds

| # | Dimension | Score | WHY it earned 9 |
|---|---|---|---|
| 1 | Problem | 9 | Butter's words; RunsView.tsx:130 drops all but one of the lines 33/33 sessions recorded |
| 2 | Scope | 9 | in/out named; D1, D2 decided by Butter |
| 3 | Contract | 9 | reuses GET /workspaces/:id/commits/:sha?patch=1 (workspace-commits.ts) and the provenance commit shape (task-provenance.ts:41); two additive fields |
| 4 | Prior art | 9 | TASK-1748/1783/1791/1792/2531/2532; vendored-adapter and zero-MCP gotchas |
| 5 | Edges | 9 | multi-session, multi-commit, old adapter, non-GitHub, credentials, 404, 409, binary/too-large, no suite line |
| 6 | NFR | 9 | 12/12 walked in R2 |
| 7 | AC | 9 | each draft AC has a named failing input |

Exemptions: none
Unproven assumptions carried forward: the test-case parser covers only xUnit `[Fact]`/`[Theory]` and TS `it(`/`test(` (the declarations found in the repos), and a test declared outside a commit's diff is not counted as added.
Rounds: 3 · evidence: 22 citations (code 12, data 3, git 1, skill 1, gotcha 2, user 3)
