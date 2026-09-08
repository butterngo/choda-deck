---
task: TASK-1914
title: Register ac_review as a stdio MCP tool, so a skill can call the grader
verified: 2026-09-08
session: SESSION-1788865407175-60
run: /choda-burn-backlog iteration 2 (auto-merge authorized, dynamic, scope label ac-review)
---

# AC verification — TASK-1914

**Done: 6/7. Needs a human: 1 (AC-7). Blockers: none.**
Held at IMPLEMENTED, not DONE — an unticked criterion blocks the transition even
on a proven merge.

Merged and proven before any tick: PR #282, merge commit `0e66ad2`, asserted an
ancestor of `origin/main`.

## Criteria

| AC | Class | Verdict | Evidence |
|---|---|---|---|
| AC-1 | machine | ✅ | Post-merge run on `0e66ad2`: a body with 3 checkbox lines, a prose line between them, and a `- [ ]` under `## Test Plan` yields exactly 3 rows, indexes `[0,1,2]`, each carrying text/verdict/concern/suggestion |
| AC-2 | machine | ✅ | The prompt captured from the injected provider is byte-identical to `ac-grader.ts`'s exported `SYSTEM`; the route's own 17 tests pass unchanged through the extraction |
| AC-3 | machine | ✅ | A task with no `## Acceptance` answers `NO_ACCEPTANCE_CRITERIA`, provider call log empty, no `criteria` key |
| AC-4 | machine | ✅ | Two tests — no `ai-provider.json`, and no `dataDir` at all — both answer `NO_MODEL_CONFIGURED` with `criteria` undefined |
| AC-5 | machine | ✅ | A 401 whose body reads `invalid api key sk-live-abcdef123456` answers `kind: auth`, and the serialised output is asserted NOT to contain `sk-`; a 429 keeps `retryAfter: "30"` rather than retrying |
| AC-6 | machine | ✅ | `REMOTE_TOOL_ALLOWLIST.has('ac_review')` is false with a CONTROL that `has('task_list')` is true; a second test asserts the tool IS registered on a server built without an allowlist |
| **AC-7** | **human** | **⬜ not done** | No human is in this loop. An injected provider returns whatever it is handed, so nothing here shows the live model answers in the shape the tool expects |

## Injections — each reddening one criterion and nothing else

| Injection | Red |
|---|---|
| the grader sends `SYSTEM.replace('WEAK','BAD')` instead of the exported prompt | AC-2 |
| add `'ac_review'` to `REMOTE_TOOL_ALLOWLIST` | AC-6 |

## Steps run

- `npx vitest run src/adapters/mcp/mcp-tools/__tests__/ac-review.test.ts src/adapters/companion/ac-review.test.ts`
  on merged `main` — 29 passed across 2 files
- Gates before the PR, bare: typecheck 0, lint 0 (after fixing an empty-interface
  error lint caught and typecheck did not), builds 0, 154 files / 2027 tests
- CI on #282: ubuntu, windows, docker-image all green

## Why AC-7 could not be done here, even by a human

The tool is registered at MCP server startup. This session's server was started
before the merge, so `ac_review` is not in its tool list — a human sitting here
right now still could not call it. It becomes callable on the next server start.

Carried forward as its own task with TASK-1860 AC-7, which has been unticked
since 2026-09-05 and asks the harder half of the same question: not whether the
tool answers, but whether the grader's *judgement* is worth acting on.

## Findings

`pnpm run lint` caught an empty-interface error (`AcReviewDeps extends
TaskOperations {}`) that `typecheck` passed clean — the reason §6 runs lint as
its own gate rather than assuming typecheck covers it.
