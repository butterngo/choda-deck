---
name: save-decision
description: Auto-generate an Architecture Decision Record (ADR) from the current conversation. Use after /discussion or any session where architectural decisions were made.
---

# Save Decision — Auto-generate ADR from Conversation

Entry point. See `references/` for each topic.

## Purpose

After a `/discussion` session or any conversation where architectural decisions were made, this skill summarizes the discussion into an ADR following `30-Knowledge/adr-standard.md` template, then persists it via the `choda-tasks` `knowledge_create` MCP tool — which writes the file to `docs/knowledge/<slug>.md`, auto-pins ref SHAs, and regenerates `INDEX.md`.

## Quick rules

| Rule                 | Detail                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| Template source      | `30-Knowledge/adr-standard.md` — always read before generating                      |
| Persistence          | Call `mcp__choda-tasks__knowledge_create` with `type=decision, scope=project`       |
| ADR numbering        | Scan via `knowledge_list type=decision` → highest `ADR-N` → +1, zero-pad to 3 digits |
| Title format         | `ADR-NNN: <description>`                                                            |
| Slug                 | **Always pass explicit slug** `ADR-NNN-<short-topic>` (2-4 word kebab) — never let it auto-derive (would lowercase + run too long) |
| Status default       | `proposed` — user promotes to `accepted` after review                               |
| AI-Context required  | One-line summary, mandatory per adr-standard                                        |
| One decision per ADR | If conversation had multiple decisions, generate multiple ADRs                      |
| Refs                 | Extract file paths from Impact section → pass `refs[]` (SHA auto-pinned to HEAD)    |

## Usage

```
/save-decision <topic>
```

- `<topic>` is optional — if omitted, infer from conversation context

## References

- [Generation steps](references/generation-steps.md)
- [Conversation extraction](references/conversation-extraction.md)
