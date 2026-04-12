# Index Management

## Index file location

`docs/decisions/index.md` in the current project.

## After creating an ADR

Append one row to the index table:

```markdown
| [ADR-0005](ADR-0005-retry-strategy.md) | Use exponential backoff for Kafka retries | proposed | 2026-04-02 |
```

## Index template (bootstrap)

If `docs/decisions/index.md` does not exist, create it:

```markdown
# Architecture Decision Records

> AI-Context: Index of all architectural decisions for <Project>. Read this before @importing any ADR.

| ID | Title | Status | Date |
|---|---|---|---|
```

## Status updates

When user changes an ADR status (accepted, deprecated, superseded):
- Update the ADR file frontmatter
- Update the corresponding row in index.md
- If superseded, add `superseded-by ADR-XXXX` to old ADR frontmatter
