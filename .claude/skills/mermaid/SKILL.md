---
name: mermaid
description: Generate Mermaid diagrams from user requirements. Supports flowcharts, sequence diagrams, class diagrams, ER diagrams, Gantt charts, and 18 more diagram types.
allowed-tools: Read Write Edit
---

# Mermaid Diagram Generator

Generate Mermaid diagram code based on user requirements.

## Workflow

1. Analyze user description → determine diagram type
2. Read corresponding syntax reference
3. Generate Mermaid code following the spec
4. Apply styling if needed

## Diagram types

| Type | Reference | Use cases |
|---|---|---|
| Flowchart | [flowchart.md](references/flowchart.md) | Processes, decisions |
| Sequence | [sequenceDiagram.md](references/sequenceDiagram.md) | Interactions, API calls |
| Class | [classDiagram.md](references/classDiagram.md) | Class structure |
| State | [stateDiagram.md](references/stateDiagram.md) | State machines |
| ER | [entityRelationshipDiagram.md](references/entityRelationshipDiagram.md) | Database design |
| Gantt | [gantt.md](references/gantt.md) | Timelines |
| C4 | [c4.md](references/c4.md) | System architecture |
| Mindmap | [mindmap.md](references/mindmap.md) | Hierarchical structures |

Full list: see [all-diagram-types.md](references/all-diagram-types.md)

## Config

- [Theming](references/config-theming.md)
- [Directives](references/config-directives.md)
- [Layouts](references/config-layouts.md)

## Output rules

1. Wrap in ```mermaid code blocks
2. Correct syntax that renders directly
3. Semantic node naming
4. Styling when needed for clarity
