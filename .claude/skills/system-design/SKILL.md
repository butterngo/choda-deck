---
name: system-design
description: Design system architecture from scratch — choose patterns, decompose components, diagram with C4, analyze trade-offs. Trigger when designing new systems, reviewing architecture, or choosing patterns.
---

# System Design

Help Butter design and review system architecture — from requirements to validated design with ADRs.

## When to trigger

- "Design the architecture for X"
- "Review this architecture"
- "What pattern fits this requirement?"
- "Should we use microservices or monolith?"
- "Draw the system diagram"
- Starting a new project or major feature

## Two modes

### Mode A: Design (new system or major feature)

Follow the 6-step process from @30-Knowledge/system-design-process.md:

1. **Requirements & Constraints** — gather functional, non-functional, constraints, stakeholders
2. **Component Decomposition** — identify bounded contexts, define modules, establish boundaries
3. **Interface Design** — API contracts, event schemas, data flow
4. **Data Design** — data model, storage choice, consistency model
5. **Infrastructure & Deployment** — topology, observability, resilience
6. **Validate** — walk through use cases, check trade-offs (ATAM), capture ADRs

**At each step:**

- Present options with trade-offs (use ATAM from knowledge doc)
- Wait for Butter to decide before proceeding
- Use `mermaid` skill for C4 diagrams (always create L1 Context + L2 Container)
- Use `save-decision` skill to capture key decisions as ADRs

### Mode B: Review (existing system)

Walk through @30-Knowledge/architecture-review-checklist.md:

1. Read the project's `context.md` to understand current architecture
2. Go through each checklist category: Structure, Testability, Data, Scalability, Resilience, Observability, Security, Deployment
3. For each item: pass / fail / not applicable
4. Present findings grouped by severity (critical → warning → info)
5. Propose action items for failures

### Pattern selection

When Butter asks "what pattern fits", use @30-Knowledge/architecture-patterns.md:

1. Understand the requirements (Step 1 from design process)
2. Match against pattern comparison table
3. Present top 1-2 patterns with trade-offs specific to Butter's context
4. Reference existing projects as examples (automation-rule = EDA, task-management = Clean Architecture)

## C4 Diagramming Guide

Always diagram at least L1 + L2. Use `mermaid` skill.

| Level        | When              | Mermaid type  |
| ------------ | ----------------- | ------------- |
| L1 Context   | Always            | `C4Context`   |
| L2 Container | Always            | `C4Container` |
| L3 Component | Complex container | `C4Component` |
| L4 Code      | Rarely            | Class diagram |

## Output format

### For Design mode

```markdown
## System Design: [Name]

### Requirements

- [key requirements + constraints]

### Architecture

- Pattern: [chosen pattern + why]
- [C4 L1 diagram]
- [C4 L2 diagram]

### Components

| Component | Responsibility | Tech |
| --------- | -------------- | ---- |

### Key Decisions

- ADR-001: [decision title] (captured via save-decision)

### Trade-offs

| Decision | Helps | Hurts | Verdict |
| -------- | ----- | ----- | ------- |

### Next steps

- [ ] [implementation tasks]
```

### For Review mode

```markdown
## Architecture Review: [Project]

### Summary

[X] pass / [Y] fail / [Z] N/A

### Critical

- [ ] [failed items that block release]

### Warnings

- [ ] [items to address soon]

### Passed

- [items that passed]
```

## References

- @30-Knowledge/architecture-patterns.md — pattern comparison, .NET project structure
- @30-Knowledge/system-design-process.md — 6-step process, C4 guide, ATAM
- @30-Knowledge/architecture-review-checklist.md — review checklist
- @30-Knowledge/adr-standard.md — ADR format
- @skills/mermaid/ — diagram generation (C4 syntax)
- @skills/save-decision/ — capture decisions as ADRs

## Rules

1. **KISS first.** Don't suggest microservices when a monolith works. Simplest pattern that meets requirements.
2. **Trade-offs explicit.** Every pattern choice has a cost. Name it.
3. **Diagrams required.** No design without at least C4 L1 + L2.
4. **Decisions captured.** Key decisions become ADRs via save-decision skill.
5. **Business context aware.** Check project business context before prioritizing quality attributes.
