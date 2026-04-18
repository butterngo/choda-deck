---
name: save-decision
description: Auto-generate an Architecture Decision Record (ADR) from the current conversation. Use after /discussion or any session where architectural decisions were made.
---

# Save Decision — Auto-generate ADR from Conversation

Entry point. See `references/` for each topic.

## Purpose

After a `/discussion` session or any conversation where architectural decisions were made, this skill summarizes the discussion into an ADR file following `30-Knowledge/adr-standard.md`. Outputs to `docs/decisions/` in the current project.

## Quick rules

| Rule                 | Detail                                                           |
| -------------------- | ---------------------------------------------------------------- |
| Template source      | `30-Knowledge/adr-standard.md` — always read before generating   |
| Output location      | `docs/decisions/ADR-XXXX-<slug>.md` in current project           |
| Auto-increment ID    | Scan `docs/decisions/` for highest ADR number, increment by 1    |
| Status default       | `proposed` — user promotes to `accepted` after review            |
| AI-Context required  | One-line summary, mandatory per adr-standard                     |
| One decision per ADR | If conversation had multiple decisions, generate multiple ADRs   |
| Update index         | Append new entry to `docs/decisions/index.md` after creating ADR |

## Usage

```
/save-decision <topic>
```

- `<topic>` is optional — if omitted, infer from conversation context
- If `docs/decisions/` does not exist, create it with `index.md`

## References

- [Generation steps](references/generation-steps.md)
- [Conversation extraction](references/conversation-extraction.md)
- [Index management](references/index-management.md)
