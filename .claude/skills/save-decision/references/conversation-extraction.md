# Conversation Extraction

## What to extract

Scan the current conversation for:

| Section | Look for |
|---|---|
| Context | Problem statement, constraints, requirements mentioned early in discussion |
| Options | Alternatives discussed, compared, benchmarked |
| Decision | Explicit "let's go with X", "chose X", or final implementation choice |
| Why not others | Reasons given for rejecting alternatives |
| Consequences | Trade-offs acknowledged, risks flagged |
| Impact | Files modified, modules touched, dependencies changed |
| Revisit when | "If X happens we should reconsider", scaling thresholds, tech debt notes |

## Extraction rules

- **Faithful to discussion** — do not invent options or consequences not discussed
- **Consolidate, don't copy** — summarize threads into concise ADR language
- **Attribute decisions** — if user made the call, note in deciders field
- **Flag gaps** — if a required section has no data from conversation, write `TBD — not discussed` rather than fabricating content
- **Multiple decisions** — if conversation covered 2+ distinct decisions, generate separate ADR files for each. Ask user to confirm the split before writing.

## Topic inference

When `/save-decision` is called without argument:

1. Look for the main subject of the discussion (e.g., "retry strategy", "database choice")
2. Use the most specific noun phrase, not generic ("retry strategy" not "architecture")
3. If ambiguous, ask user: "Which decision to save? I see: A, B, C"
