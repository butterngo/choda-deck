---
type: decision
title: "ADR-013: Session rules injected via MCP response — compliance through prompt, not validation"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-18
lastVerifiedAt: 2026-04-29
---

# ADR-013: Session rules injected via MCP response — compliance through prompt, not validation

## Context

[ADR-009](./ADR-009-session-lifecycle.md) defined `session_start` / `session_end` MCP tools. Evidence from first weeks of use (TASK-513, TASK-514 sessions):

- `session_start` returned `lastHandoff` JSON, but Claude consistently **skipped surfacing it to the user** — jumped straight into task picking.
- `session_end` payloads were inconsistent: sometimes `resumePoint` only, sometimes missing `tasksUpdated`, no canonical shape.
- Butter had to manually remind Claude to show handoff ("tôi thấy bạn thiếu handoff").

Root cause: the MCP tool exposes **data** but no **contract**. Claude is free to synthesize a response however it wants — low-effort path = skip steps.

Adding `.claude/rules/session.md` in a single repo was considered but rejected: Butter uses Choda Deck across multiple projects; per-repo rule duplication defeats the whole point of a central MCP server.

## Decision

Ship rules **inside the MCP server itself**, injected into every `session_start` / `session_end` response as literal imperative text. Compliance is through **in-response prompting**, not runtime validation.

### Storage

`src/tasks/rules/session-rules.md` — single markdown file in the choda-deck repo, git-tracked, edit-able by Butter without rebuild.

Two sections, parsed by heading:

```markdown
## On session_start
- Echo lastHandoff block verbatim before any other action.
- List activeTasks grouped by priority.
- Warn if abandonedSession present.
- Wait for user acknowledge before picking a task.

## On session_end
- Required: resumePoint (one sentence describing where you stopped).
- Required: tasksUpdated (ids + new status).
- Recommended: decisions, looseEnds, commits.
- Persist handoff_json to SQLite (done by tool).
```

MCP-wide, no per-project override in v1.

### Injection

**session_start** response grows a `rules: string` field containing the `## On session_start` section body (plain text, no heading).

**session_end** tool `description` in the MCP schema carries the `## On session_end` section. Claude reads tool descriptions before calling → payload prepared per contract.

Both load the rule file via `fs.readFileSync` **per call** — no server restart needed when Butter edits the file. File is small (<1 KB); read cost is negligible.

### Compliance model

Prompt injection, not runtime enforcement:

- Rule text sits **inside the tool response** Claude just received → in working memory, hard to ignore.
- Rule is imperative + checklist-shaped → Claude echoes, does not synthesize.
- If Claude skips, there is no hard stop. This is accepted: the cost of building a validator (parse Claude output, detect missing sections, re-prompt) exceeds the benefit for a single-user tool.

Butter stays the backstop: if Claude skips, Butter notices and the rule text itself is the reminder.

## Rationale

- **Central, not per-repo.** One rule file, one MCP server, all projects inherit. Editing is one place.
- **Prompt injection beats external rules.** Rules in `.claude/rules/*.md` sit in ambient context — easy to forget between tool calls. Rules **inside** the tool response are right next to the data Claude needs to act on.
- **File over database.** Markdown file is diff-able, version-controlled, human-edit-able. A `session_rules` table would add admin UI surface for zero user-facing benefit.
- **Hot reload via per-call read.** No server lifecycle to manage; fs read at ~microsecond scale is fine for a tool that fires once per session boundary.
- **No hooks.** Electron / Claude Code hooks run shell commands, not MCP calls. Hook-based enforcement would require a parallel validator and more moving parts for negligible gain.

## Consequences

### Positive

- One file to edit, all projects get the new rule next call.
- Claude compliance goes up without code changes to the client.
- Rule content is data, not code — Butter tunes behavior without touching TypeScript.
- Sets a pattern: future MCP tools can carry behavioral contracts the same way (e.g. `conversation_decide` could inject "require actions array" rule).

### Negative

- Soft enforcement only. A skipped step is a Butter-catches-it, not a runtime error. Accepted for the MVP single-user regime.
- Rule file is not validated at load time. A malformed `## On session_start` heading → `rules` field empty. Mitigation: log a warning on parse if section missing; unit test the parser.
- Ties rule edits to the MCP server process. If Butter runs multiple Claude Code instances against the same MCP, all see the same rule — not a problem, but worth noting.

### Out of scope (deferred)

- Per-project rule overrides (`10-Projects/<id>/session-rules.md`).
- Runtime validator that re-prompts Claude if required fields are missing from `session_end`.
- Rule versioning / migration when schema evolves.
- Rule-driven UI (render the checklist in Choda Deck for humans to tick manually).

## Open questions

- Should the rule file live in `src/tasks/rules/` (next to MCP tool code) or `src/rules/` (shared across future MCP servers)? Proposed: `src/tasks/rules/` — stays colocated with what uses it; move later if a second MCP server appears.
