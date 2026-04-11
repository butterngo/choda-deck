---
id: ADR-0001
title: Adopt spawn-worker pattern for V2+ cross-repo orchestration features
status: accepted
date: 2026-04-11
---

## Context

Choda Deck's MVP (v0.1) hosts live **interactive** `claude` sessions per project — the sidebar is a navigation aid, not an orchestration surface. However, the long-term vision (see `docs/requirements.md` → "Big picture — long-term vision") includes features like:

- **Context injection** into a running claude session (daily note / task / memory snippet as implicit initial context)
- **Task management** panel where clicking a task could trigger a worker that analyzes, proposes, and applies changes in a target repo
- **Cross-project graph + workflow** actions that span multiple repos

These features need a **headless, parallel-safe, inspectable** way to run Claude Code work in target repo cwds — different from the interactive pty that MVP ships. That problem was already solved in the archived `claude-orchestrator` project. Reference: archived ADR-0002 "Orchestration pattern — vault session + claude -p workers" at `vault/90-Archive/claude-orchestrator/docs/decisions/ADR-0002-orchestration-pattern.md`, and the distilled reusable form at `vault/skills/spawn-worker/SKILL.md`.

The decision at hand: does Choda Deck invent its own orchestration pattern for V2+, or explicitly adopt spawn-worker as the reference implementation?

## Decision

**Adopt `vault/skills/spawn-worker/` as the reference pattern for any V2+ Choda Deck feature that needs to orchestrate Claude Code work outside the interactive session.**

Concretely:
- Any "headless task" feature (overnight runs, multi-repo refactors, batched analyses) spawns `claude -p` workers following the two-phase pipeline documented in `spawn-worker/SKILL.md` (analyze → approve → implement+verify).
- Handoff between the Choda Deck UI and workers goes through files under `vault/Agent-Bridge/<task-id>/` (or a Choda-Deck-local equivalent if we decide to keep orchestration state out of the vault).
- Cost cap: every spawn uses `--max-budget-usd` hard limits; structured JSON output feeds back into the UI.
- The approval gate is rendered as a Choda Deck UI element (banner / modal / dedicated view type) — the vault-session-as-orchestrator mechanic from `spawn-worker` translates to **Choda-Deck-as-orchestrator** for the UI case.

## Rationale

- **Proven** — POC validated end-to-end on 2026-04-11 (see archived ADR-0002 "Consequences"). Cost and latency characteristics known.
- **No extra runtime** — `claude -p` CLI is already the dependency Choda Deck spawns interactively anyway. Adopting spawn-worker adds zero new binaries, zero new languages, zero new supervisors.
- **Parallel-safe by construction** — file-based handoff means N concurrent workers never share in-memory state. Matches Choda Deck's multi-tab architecture where each project could trigger its own worker.
- **Inspectable** — plan.md / result.md files are real markdown Butter can read, diff, commit. Fits Choda Deck's "vault is source of truth" identity.
- **Avoids NIH** — the alternative (Choda Deck invents its own worker orchestration) costs engineering time and diverges from a pattern Butter already uses in vault sessions.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Invent Choda-Deck-specific orchestration layer | NIH. Duplicates work. Diverges from vault-side orchestration, doubling maintenance |
| Use interactive pty for headless work too (pipe commands through the existing MVP pty) | Loses parallel safety, loses cost caps, pollutes the interactive session Butter is watching |
| Direct Anthropic API calls from Choda Deck main process | Huge scope bump (conversation state management, auth refresh, caching, tool-use loop). Orthogonal to MVP value prop |
| Defer the decision until V2 starts | Risks painting MVP architecture into a corner. Recording the intent now makes V2 design a refinement, not a re-decision |

## Consequences

### Positive

- V2 orchestration design is already 80% specified — implementation becomes "wire spawn-worker into the Choda Deck UI" rather than greenfield design
- Choda Deck UI can surface plan.md / result.md files directly via its (also V2+) note-viewer view type — no extra renderer work
- Cost visibility built in — every worker call returns `total_cost_usd` in structured JSON; Choda Deck can surface running totals
- Shared vocabulary with vault-side tooling — same "worker", "plan.md", "result.md", "approval gate" concepts on both sides

### Negative

- Cold-start latency per worker spawn (~12s observed in POC) — fine for human-approved async work, unacceptable for anything real-time. V2 features built on this must be designed as async from the start
- Cross-worker communication is the vault session's job in the reference pattern — Choda Deck will need to own that role instead (TASK-151 — BE+FE routing protocol, priority #1 as of 2026-04-11)
- Not applicable to MVP — this ADR is intentionally forward-looking. MVP code should NOT adopt it yet; premature integration would bloat MVP

## Relationship to MVP

**MVP ships without any spawn-worker code.** This ADR records the *intent* so MVP architectural choices (`<ViewRouter>`, polymorphic main pane, session map design) leave room for a future `worker` view type without refactoring the shell. No MVP code is blocked by this ADR.

## Status

Accepted 2026-04-11. Not yet implemented in Choda Deck (V2+). Reference implementation: `vault/skills/spawn-worker/`. Archived origin: `vault/90-Archive/claude-orchestrator/docs/decisions/ADR-0002-orchestration-pattern.md`.

## Log

- 2026-04-11 — ADR drafted during `/project-discovery` run. Records adoption intent without committing MVP code.
