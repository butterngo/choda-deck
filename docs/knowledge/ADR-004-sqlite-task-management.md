---
type: decision
title: "ADR-004: SQLite embedded for task management data layer"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-13
lastVerifiedAt: 2026-04-29
---

# ADR-004: SQLite embedded for task management data layer

## Context

Phase 1 cần data store cho Kanban board, epic/subtask hierarchy, task CRUD. Options: Neo4j (đã có), SQLite embedded, pure markdown.

Chọn **SQLite embedded** vì:
- Fast queries cho board rendering (no network round-trip)
- Offline-capable, zero external dependency
- Neo4j có thể remove trong tương lai — task data không nên phụ thuộc vào nó
- Markdown files vẫn là source of truth cho content, SQLite là derived index

## Schema

### ER Diagram

```mermaid
erDiagram
    projects ||--o{ epics : has
    projects ||--o{ tasks : has
    epics ||--o{ tasks : contains
    tasks ||--o{ tasks : "subtask of"
    tasks ||--o{ task_dependencies : "depends on"
    tasks ||--o{ task_dependencies : "depended by"

    projects {
        text id PK "e.g. task-management"
        text name
        text cwd
    }

    epics {
        text id PK "e.g. EPIC-001"
        text project_id FK
        text title
        text status "TODO|READY|IN-PROGRESS|DONE"
        text created_at
        text updated_at
    }

    tasks {
        text id PK "e.g. TASK-130"
        text project_id FK
        text epic_id FK "nullable"
        text parent_task_id FK "nullable, subtask"
        text title
        text status "TODO|READY|IN-PROGRESS|DONE"
        text priority "critical|high|medium|low"
        text labels "JSON array"
        text due_date "ISO date, nullable"
        int pinned "0|1, daily focus"
        text file_path "vault .md path"
        text created_at
        text updated_at
    }

    task_dependencies {
        text source_id FK "task that depends"
        text target_id FK "task depended on"
    }
```

### Data Flow

```mermaid
flowchart LR
    subgraph Vault
        MD[".md files<br/>(source of truth)"]
    end

    subgraph Choda Deck
        Import["vault-import<br/>(parse frontmatter)"]
        SQLite["SQLite DB<br/>(fast queries)"]
        Board["Kanban Board<br/>(React UI)"]
        Sync["markdown-sync<br/>(write back)"]
    end

    MD -->|read| Import
    Import -->|insert/update| SQLite
    SQLite -->|query| Board
    Board -->|status change| SQLite
    SQLite -->|frontmatter update| Sync
    Sync -->|write| MD
```

### Kanban Board Layout

```mermaid
flowchart LR
    subgraph Board["Kanban Board (per project)"]
        TODO["TODO<br/>─────<br/>TASK-201<br/>TASK-202"]
        READY["READY<br/>─────<br/>TASK-205"]
        IP["IN-PROGRESS<br/>─────<br/>TASK-130<br/>TASK-131"]
        DONE["DONE<br/>─────<br/>TASK-126<br/>TASK-127"]
    end

    TODO -->|drag| READY
    READY -->|drag| IP
    IP -->|drag| DONE
```

### Component Architecture

```mermaid
flowchart TD
    subgraph Renderer
        App["App.tsx"]
        VR["ViewRouter"]
        TV["TerminalView"]
        KB["KanbanBoard"]
        TC["TaskCard"]
        DP["DetailPanel"]
    end

    subgraph Main
        TS["TaskService"]
        DB["SQLite DB"]
        MS["MarkdownSync"]
    end

    App --> VR
    VR -->|"tab: Terminal"| TV
    VR -->|"tab: Tasks"| KB
    KB --> TC
    TC -->|click| DP
    KB -->|"IPC: task:*"| TS
    TS --> DB
    TS --> MS
```

## Decision

### Statuses — hardcoded 4 columns

| Status | Kanban Column | Meaning |
|---|---|---|
| `TODO` | 1st | Backlog, not started |
| `READY` | 2nd | Ready to pick up |
| `IN-PROGRESS` | 3rd | Actively working |
| `DONE` | 4th | Completed |

No custom workflow in V1. Fixed 4 columns, any task can move to any status (no transition rules).

### IDs — vault IDs

Task IDs use existing vault convention: `TASK-130`, `EPIC-001`, etc. Not auto-increment integers. This keeps SQLite ↔ vault file mapping simple.

### Dependencies — SQLite table

`task_dependencies` table instead of Neo4j graph. Self-contained — no external DB dependency for core task management features. Neo4j remains optional for cross-project context queries.

### Indexes

```sql
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status ON tasks(project_id, status);
CREATE INDEX idx_tasks_epic ON tasks(epic_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
```

## Consequences

- `better-sqlite3` package — synchronous, fast, no async overhead
- SQLite file at `{app-data}/choda-deck.db` (packaged) or `choda-deck.db` (dev)
- Import existing vault tasks on first run or on-demand
- Board changes write to SQLite immediately, markdown sync is async (debounced)
- Neo4j can be removed later without affecting task management
- No custom workflow — if needed later, add `workflows` + `statuses` tables

## Related

- [[TASK-301_sqlite-data-layer]]
- [[TASK-303_kanban-board]]
- [[TASK-308_markdown-sync]]
- [[phase-1-task-management]]
