---
type: learning
title: "Playwright pilot skill — global Claude Code skill for FE executor"
projectId: choda-deck
scope: project
refs:
  - path: docs/knowledge/playwright-executor-pilot-runbook.md
    commitSha: 5cfe71017a81cffbb70b456f136c4cc5729f2504
createdAt: 2026-05-08
lastVerifiedAt: 2026-05-08
---

# Playwright pilot skill — global Claude Code skill

Companion to [`playwright-executor-pilot-runbook`](./playwright-executor-pilot-runbook.md). The runbook is **canonical content** (operator's manual). This entry tracks the **discovery surface** — a Claude Code skill that auto-triggers when Butter works on FE Playwright pilot tasks.

## Why a skill (not just the runbook)

Runbook is passive — Butter must remember to look it up. The skill makes lookup automatic: Claude pre-loads the operational pattern when it sees a `fe-playwright-test` task, a `choda-deck run` invocation, or an AC report path. No more "wait, how do I run this again?".

## Location

Global, user-scope:

```
C:\Users\hngo1_mantu\.claude\skills\playwright-pilot\
├── SKILL.md             # trigger desc + 5-step operator flow
└── references/
    └── extending.md     # onboarding checklist for new FE projects + known limits
```

`~/.claude/skills/` is read by Claude Code in **every** repo, every session — pilot pattern is portable across choda-deck, remote-workflow, and any future FE project Butter onboards.

## Trigger surface

The skill description tells Claude when to load it. Triggers cover:

- Task labeled `fe-playwright-test`
- Invoking `choda-deck run` CLI
- Reading or writing an FE Playwright `.spec.ts` that needs AC mapping
- Debugging an `ac-report.json` under `<artifactRoot>/<project>/<taskId>/<timestamp>/`
- Onboarding a new FE project to the pilot pattern

If Butter mentions any of these explicitly OR the conversation context matches, Claude auto-loads the skill before answering.

## Behaviour contract

The skill is **project-agnostic by design**. It does NOT hardcode:

- Workspace ids (resolved via `mcp__choda-tasks__workspace_list` or `--worktree` override)
- Dev server commands (read from target repo's `CLAUDE.md`, else ask)
- `testDir` / `baseURL` (read from target repo's `playwright.config.ts` at runtime)
- Stable selectors (grep target repo's `src/`)
- Auth mocks (target repo's `e2e/setup/<file>.ts`)

Per-project config lives in target repo, not in the skill. This is the explicit reason for keeping the skill global rather than project-bound.

## Single source of truth

Skill body never duplicates runbook content. Instead, the first instruction is:

```
mcp__choda-tasks__knowledge_get  slug: playwright-executor-pilot-runbook
```

If the runbook drifts from source code (`isStale: true`), the skill surfaces that to Butter. Edit the runbook → all skill invocations see the fresh content next call. No skill rebuild needed.

## Onboarding a new FE project

`references/extending.md` carries the checklist:
1. Pre-flight checks on target repo (`@playwright/test` installed, `playwright.config.ts`, browsers)
2. `workspace_add` to register target cwd in choda-deck
3. Add pilot notes to target repo's `CLAUDE.md`
4. Validate end-to-end with a fixture task — gate-only → skip-coder → full
5. Optional per-project knowledge entry (`playwright-pilot-<id>.md`) tracking run history + selector quirks

It also calls out the **current Phase-1 limitation**: `CODER_SYSTEM_PROMPT` hardcodes `e2e/tests/` as spec landing zone. If the new project uses a different `testDir`, either align the project's config (low effort) or wait for Phase 2 refactor (INBOX-091) that derives `testDir` from `playwright.config.ts` at runtime.

## When NOT to invoke this skill

Documented in SKILL.md. Summary: BE/API tests, vitest unit tests, tasks lacking the `fe-playwright-test` label (gate will reject anyway), generic Playwright debugging unrelated to choda-deck executor.

## Maintenance

Skill itself rarely needs edits — the body is mostly stable trigger logic + delegation to the runbook. Edits happen when:

- Trigger keywords need tuning (false positives or misses)
- A new run mode is added (e.g. CI integration)
- Phase 2 lands and the testDir limitation note can be removed
- A new FE project lands a different mocking convention worth documenting

Update both files (`SKILL.md` + `references/extending.md`), bump runbook's `lastVerifiedAt` if cross-references changed, and re-test the skill in a fresh Claude Code session.

## References

- [`playwright-executor-pilot-runbook`](./playwright-executor-pilot-runbook.md) — canonical operator's manual
- TASK-679 — pilot scope + scaffold commits
- INBOX-091 — Phase 2 (general executor + testDir refactor)
- ADR-018 — knowledge layer convention this entry follows
- Skill files (outside this repo): `~/.claude/skills/playwright-pilot/`
