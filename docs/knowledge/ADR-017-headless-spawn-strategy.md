---
type: decision
title: "ADR-017: Headless Spawn Strategy — `claude -p` (default config) over Anthropic SDK Direct"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-25
lastVerifiedAt: 2026-04-29
---

# ADR-017: Headless Spawn Strategy — `claude -p` (default config) over Anthropic SDK Direct

> **Status:** ✅ Accepted
> **Trigger:** TASK-610 spike — verify headless metrics schema before re-building any orchestrator. ADR-014 superseded; need a fresh decision on what spawn primitive future Harness Engine work uses.

---

## Context

[[ADR-014-harness-engine-architecture]] proposed a self-written Planner→Generator→Evaluator pipeline over `claude -p` subprocesses. It was superseded after Butter pivoted to Claude Code's native `/team` for orchestration. PR #25 removed `src/core/harness/*` entirely.

But the pivot left an unanswered question: when a future feature *does* need to spawn an AI subprocess from MCP tool code (e.g., `inbox_research`, automation rules, future agent loops), what's the spawn primitive?

Three candidates considered:

| Option | Description |
|---|---|
| **A. `claude -p` default** | Subprocess with full Claude Code env (CLAUDE.md auto-discovery, hooks, skills, MCP, permissions, OAuth) |
| **B. `claude -p --bare`** | Subprocess stripped of hooks/LSP/CLAUDE.md/keychain. Requires `ANTHROPIC_API_KEY`. |
| **C. Anthropic SDK direct** | `@anthropic-ai/sdk` calls from Node, build our own system prompt + tool routing |

TASK-610 spike measured all three (B partially — `--bare` failed without API key in our env). Numbers in [[headless-metrics-schema]].

## Decision

**Use Option A: `claude -p --output-format json` with default Claude Code environment.**

Spawn pattern (canonical):
```
claude -p "<prompt>" \
  --output-format json \
  --session-id <uuid>      # optional, for resumable sessions
  --max-budget-usd 5.00    # always set a hard ceiling
  --tools "<allowlist>"    # use --tools (real restriction), NOT --allowed-tools
  [--no-session-persistence]   # if we don't want .jsonl on disk
```

Parse with `scripts/measure-claude.ts` reference parser (or its eventual `src/core/harness/` port).

## Consequences

### Positive

- **Inherits the L4 layer for free.** Skills, MCP servers, permission modes, hooks, output styles, slash commands, plugins — all available without re-implementation. Building any of these in-house = ADR-008 layer-violation.
- **OAuth keychain auth works out of the box.** No API-key plumbing for end users. Survives `claude /login` rotations.
- **Auto-routing to Haiku for cheap subtasks.** Spike showed Haiku 4.5 silently used for routing/classifier (~$0.0004/turn) — value-add we'd otherwise lose.
- **Cost ceiling is acceptable.** Warm-cache floor $0.017/turn = $1.70/100-turn pipeline. Cold-spawn ceiling $0.099/turn. With reasonable batching, orchestration runs are sub-$10 even for heavy automation.
- **Schema is observable.** stream-json gives full visibility (system/init dump, rate_limit_event, per-message assistant events). Good for audit + debugging.
- **`--max-budget-usd` is a real safety net.** Soft cap (post-turn) but always aborts after one over-limit turn — prevents runaway spend.

### Negative

- **Pay $0.017/turn floor even for trivial calls.** Default config loads ~33k cached tokens (CLAUDE.md, skills, etc.). For micro-classifier calls ("is this Vietnamese? y/n") this is wasteful. **Mitigation**: when we have a use case justifying it, fall back to Option C (SDK direct) for that specific call site. Don't optimise prematurely.
- **Subprocess overhead ~2s wall-clock minimum.** Not suitable for hot-path interactive UX. Fine for orchestration where latency budget is seconds-to-minutes.
- **`--bare` is locked behind `ANTHROPIC_API_KEY`.** OAuth/keychain are hard-disabled. We can't use `--bare` to lower the cache floor without breaking single-binary auth.
- **`--max-budget-usd` overspends on first turn.** Set $0.001, charged $0.099 (99x). Always size budget to *at least* one expected cold-spawn cost ($0.10) plus headroom.
- **`subtype` is a misleading error indicator.** Parsers must check `is_error`, never `subtype === "success"`. Documented in spike + parser handles correctly.

### Neutral

- **`--exclude-dynamic-system-prompt-sections` ignored.** Worse cost on single machine. Only revisit if we ever do cross-machine cache farms.
- **`CLAUDE_CODE_DISABLE_PROMPT_CACHING` doesn't exist.** Use `DISABLE_PROMPT_CACHING=1` (Anthropic SDK env var) when we need to deliberately bust cache for testing.
- **`--max-turns` flag doesn't exist.** Limits are by `--max-budget-usd` only. Multi-turn tracking is the orchestrator's job (each spawn reports `num_turns: 1`).

## When to revisit

This ADR locks in the *default* spawn primitive. Reconsider if any of:

1. **High-volume micro-calls become a workload.** If we end up spawning 1000s of trivial classifier turns, the $0.017 floor adds up — switch those specific call sites to Option C (Anthropic SDK direct, custom slim system prompt).
2. **Anthropic ships a `claude -p --thin` or similar.** A "skip CLAUDE.md auto-discovery but keep OAuth + skills" mode would change the math.
3. **Cross-machine cache farms become real.** If we ever distribute orchestration across machines, `--exclude-dynamic-system-prompt-sections` becomes net-positive.
4. **`/team` proves insufficient and we resurrect a self-written orchestrator.** This ADR's spawn primitive still applies; the orchestrator is a separate decision.

## Reference

- Spike data: [[headless-metrics-schema]]
- Reference parser: `scripts/measure-claude.ts`
- CLI version verified: 2.1.119 (Apr 2026)
- Models in play: claude-opus-4-7[1m] + claude-haiku-4-5-20251001 (auto-routed)
