---
requirement: "có thể có 1 cái sequence diagram cho mỗi cái task không vd khi chạy pilot nó sẽ ra luôn cái diagram và có thể define luôn bộ test case rồi link tới nó ... tôi muốn biết chắc chắn 1 cái luôn chạy nó phải đảm bảo hết"
started: 2026-10-21
workspace: Main
status: converged
---

# Discovery — Each task gets a sequence diagram and its test cases, linked AC ↔ test ↔ result

Goal 3 of 4 (Butter, 2026-10-21). Thread: CONV-1792553696904-251. Mockup (Items tab → TASK-2524): https://claude.ai/artifact/JZKYzy8jaPDW4821EmZD3o

## Round 1

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread opened, no messages yet | [conversation CONV-1792553696904-251] |
| user | the ask; the mockup's Items tab shows the target (Sequence sub-tab, AC ↔ test ↔ result table, an untested AC holds the item) | chat 2026-10-21; artifact JZKYzy8jaPDW4821EmZD3o |
| code | `ac_check` takes only `{taskId, acIndex, evidence, cwd, sessionId}`; evidence is free text | choda-deck/src/adapters/mcp/mcp-tools/ac-check.ts:30-57 |
| data | each tick is stored as a session event `{kind:"ac_check", taskId, acIndex, text, evidence, sessionId}`; 1351 ticks since 2026-10-01, 822 of them mention a test in prose, 59 say grep. Pairing an AC with a test today means parsing prose | live DB query 2026-10-21 |
| code | a mermaid parse check exists: `listMermaidFences(markdown)` and `checkMermaid(source)` (parse, not render) | choda-deck/src/adapters/companion/mermaid-check.ts:82,167 |
| code | the companion already renders mermaid (`MermaidBlock`), but `CaptureMarkdown` draws it only with the opt-in `diagrams` prop; the task page does not pass it, so a fence in a task body shows as code | companion components/CaptureMarkdown.tsx:17-25, TaskDetailPanel.tsx:134 |
| skill | /choda-plan writes each subtask body as `## Context / ## Acceptance / ## Test Plan / ## Related`; no diagram section | choda-plan/SKILL.md:223-224 |
| code | the body locks at IN-PROGRESS, so a diagram written at planning time cannot be edited by the run | task_update tool description |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter's words; 529 of 1351 ticks since Oct name no test, so "every AC was really tested" cannot be shown today | — |
| 2 | Scope & boundary | 6 | in: diagram per task, AC ↔ test pairing, coverage gate | D1-D3 |
| 3 | Technical contract | 6 | ac_check, event payload, mermaid check, plan template read | decide the structured AC evidence fields (D2) |
| 4 | Prior art | 8 | mermaid-check (TASK-1934), MermaidBlock, ac_check (ADR-029 channel 2) | ADR search for a rejected structured-evidence idea |
| 5 | Edges & failure | 5 | diagram fails to parse; contract changes after plan (body locked); AC checked by grep/manual | D3 |
| 6 | NFR | 5 | defaults; mermaid bundle is 84 MB and opt-in | walk 12 |
| 7 | Acceptance criteria | 3 | none | blocked on D1-D3 |

**TOTAL = MIN = 3** (dimension 7). New evidence: YES (7).

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 9 |
| 2 | Scope & boundary | 6 |
| 3 | Technical contract | 6 |
| 4 | Prior art | 8 |
| 5 | Edges & failure | 5 |
| 6 | NFR | 5 |
| 7 | Acceptance criteria | 3 |
| | **MIN** | **3** |

### Stop — blocked on human decisions
D1 which tasks get a diagram · D2 how an AC names its test · D3 what counts as "covered".

## Round 2

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | no human messages in the thread | [conversation CONV-1792553696904-251] |
| user | D1 every task with a call flow (API, event, UI → adapter, job) has `## Sequence`; docs/config/skill tasks write `Sequence: n/a — <reason>`; the plan draws it and checks it parses before approval · D2 `ac_check` records `method` (test / command / grep / manual) and `ref`; the plan tags each AC with its expected check; the run fills in the real test name · D3 a behaviour AC needs `test` or `command`; `grep` only for file/docs content; `manual` only for a human AC; an AC without it is red and the loop does not close the item | AskUserQuestion answers, 2026-10-21 |
| code | `checkAcItem` writes the session event payload `{kind:"ac_check", taskId, acIndex, text, evidence, sessionId}`; new fields are added there | choda-deck/src/core/domain/sqlite-task-service.ts:776-803 |
| code | events are read per session (`listSessionEvents(sessionId, type)`), and runs.ts already holds every session of an item, so the adapter can join ticks to items without a new query | session-event-operations.interface.ts:5; runs.ts `toItem` |
| code | `— human` is already the AC tag the Runs adapter reads (`/\bhuman\b/` in acceptanceCounts); the new tags extend that convention | choda-deck/src/adapters/companion/runs.ts (acceptanceCounts) |
| code | the diagram check exists only as an adapter route `POST /workspace-docs/diagram/check { mermaid } → { ok } / { ok:false, error, line }`; a skill running in the CLI has no adapter, so a CLI command over `checkMermaid` is needed | choda-deck/src/adapters/companion/mermaid-check.ts:7,38,167 |

### Contract settled
- **AC tag**: each `## Acceptance` line ends with ` — test`, ` — command`, ` — grep` or ` — human` (case-insensitive, last token). No tag = legacy, unchanged behaviour.
- **`ac_check`** gains `method?: 'test' | 'command' | 'grep' | 'manual'` and `ref?: string` (≤ 300 chars), stored in the event payload. On a tagged AC:
  - `— test` → method must be `test` and `ref` (the test name) is required, else `METHOD_MISMATCH` / `REF_REQUIRED`;
  - `— command` → method `command` or `test`, `ref` required (the command or test);
  - `— grep` → any of `grep`, `command`, `test`; `ref` required (pattern + file, or the test);
  - `— human` → method must be `manual`.
  Untagged AC: both fields optional, as today.
- **CLI `choda-deck mermaid check <file>`**: checks every mermaid fence in a markdown file (or stdin with `-`), prints `ok` or `line N: error`, exit 0 / 1.
- **`GET /runs`** item gains `acs: { index, text, tag, checked, method, ref, evidence }[]` (the newest `ac_check` event per index across the item's sessions) and `sequence: { mermaid } | { na: reason } | null`.
- **Coverage rule** (adapter, also used by goal 2's report): an AC is `covered` when it is checked with a method its tag allows, `weak` when checked by a method the tag does not allow (legacy ticks), `open` when unchecked and machine-tagged, `human` when tagged human and unchecked.
- **Companion**: the item expansion (TASK-2563) gains sub-tabs Sequence (drawn with `MermaidBlock`, "No diagram" / "n/a — reason") and Test cases (AC # · criterion · tag · method · ref · state). The task page passes `diagrams` so `## Sequence` draws there too.
- **/choda-plan**: subtask template adds `## Sequence` (or `Sequence: n/a — reason`) and an AC tag on every line; §3d grades a missing tag or a diagram that fails `choda-deck mermaid check` as not ready.
- **/choda-autopilot**: §5.5 passes `method` + `ref` on every `ac_check`; an item with any `open` machine AC is not closed (already true) and the 🔴/🟡 notice names the AC.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | D1-D3; out: generating diagrams from code, per-test result capture from test runners (the `ref` is the record), retro-tagging old tasks | — |
| 3 | Technical contract | 9 | above; payload writer, event reader, mermaid check and AC-tag reader all read | — |
| 4 | Prior art | 9 | TASK-1934 mermaid-check, ADR-029 channel 2 (ac_check events), MermaidBlock opt-in, `— human` convention | — |
| 5 | Edges & failure | 9 | wrong method for tag, missing ref, untagged legacy AC, diagram fails to parse, contract changes after the body locks (run files 🟡 and the diagram stays the plan's), task with no flow (n/a), ticks spread over several sessions (newest wins) | — |
| 6 | NFR | 9 | perf: events already loaded per session; mermaid stays lazy (84 MB, opt-in); security: no new route; data: two optional payload fields, old events still read; a11y: diagram has its source in a details element; integration: older adapter → web shows no Test cases tab | — |
| 7 | Acceptance criteria | 9 | drafted per subtask for the plan: method/tag refusals, legacy pass-through, CLI exit codes, `acs`/`sequence` fields, coverage states, UI states | — |

**TOTAL = MIN = 9**. Previous 3 → 9. New evidence: YES (6).

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 9 | 9 |
| 2 | Scope & boundary | 6 | 9 |
| 3 | Technical contract | 6 | 9 |
| 4 | Prior art | 8 | 9 |
| 5 | Edges & failure | 5 | 9 |
| 6 | NFR | 5 | 9 |
| 7 | Acceptance criteria | 3 | 9 |
| | **MIN** | **3** | **9** |

## All dimensions ≥ 9 after 2 rounds

| # | Dimension | WHY it earned 9 |
|---|---|---|
| 3 | Contract | additive fields on an existing tool and event; reuses checkMermaid and the AC-tag reader |
| 5 | Edges | every refusal has a code; legacy ticks are shown as `weak`, not hidden or failed |
| 7 | AC | each draft names its test file and a discriminating input (a `— test` AC ticked with `grep`, an untagged AC, a fence with `{{`) |

Exemptions: none
Unproven assumptions: plan-time diagrams match what gets built — when the contract moves during the run, the diagram (locked body) is out of date and only the 🟡 notice says so; `ref` is written by the agent, so a wrong test name is caught only if the test does not exist (not checked in v1).
Rounds: 2 · evidence: 13 citations (code 9, data 1, skill 1, user 2)
