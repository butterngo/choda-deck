---
type: decision
title: "ADR-007: Choda Deck — comprehensive AI workspace replacing Obsidian"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-04-13
lastVerifiedAt: 2026-04-29
---

# ADR-007: Choda Deck — comprehensive AI workspace replacing Obsidian

## Context

Hiện tại workflow dùng Obsidian + Choda Deck + Claude Desktop. Nhưng thực tế:
- 100% content viết bởi AI, không viết tay
- Obsidian chỉ là file viewer + search — core value = manage `.md` files
- Claude Desktop đang bị thay thế bởi Choda Deck terminal sessions
- Obsidian plugins (dataview, templater) không dùng — AI thay thế hết

Obsidian core chỉ làm 4 việc: file explorer, markdown render, search, wikilink resolution. Choda Deck có thể làm cả 4 + nhiều hơn.

## Decision

**Choda Deck = comprehensive AI workspace** — thay thế hoàn toàn Obsidian.

### Vision

```mermaid
flowchart TD
    subgraph "Choda Deck"
        Terminal["AI Terminal Sessions"]
        Tasks["Task Management (Kanban, Roadmap)"]
        KB["Knowledge Base (second brain)"]
        Skills["Skill & Command Manager"]
        Daily["Daily Standup / Retro"]
        Files["File Manager (.md vault)"]
        Search["Full-text Search"]
        Graph["Graph Context (Neo4j/SQLite)"]
    end

    subgraph "Storage"
        Vault[".md files (vault)"]
        SQLite["SQLite (structure)"]
        Git["Git (version control)"]
    end

    subgraph "AI"
        Claude["Claude Sessions (MCP stdio)"]
    end

    Terminal --> Claude
    Claude -->|"read/write"| Vault
    Claude -->|"create tasks"| SQLite
    Tasks --> SQLite
    KB --> Vault
    Files --> Vault
    Search --> Vault
    Search --> SQLite
    SQLite -->|"export"| Vault
    Vault --> Git
```

### What replaces what

| Obsidian feature | Choda Deck replacement |
|---|---|
| File explorer | Built-in file browser for vault |
| Markdown renderer | Markdown viewer (detail panel, doc viewer) |
| Search | Full-text search across vault + SQLite |
| Wikilinks `[[note]]` | Wikilink resolution + graph relationships |
| Daily notes | Daily standup / Focus view |
| Graph view | Graph CLI + built-in graph viewer |
| Plugins (dataview, kanban) | Native: Kanban board, Roadmap, Focus |
| Templates | AI generates via MCP tools |
| Obsidian MCP | Not needed — AI runs inside Choda Deck |

### Core modules

```mermaid
flowchart LR
    subgraph "Choda Deck Modules"
        TM["Task Management\n(Kanban, Roadmap, Focus)"]
        KB["Knowledge Base\n(second brain viewer)"]
        SM["Skill Manager\n(browse, create, assign)"]
        CM["Command Manager\n(slash commands)"]
        FM["File Manager\n(.md CRUD, search)"]
        DW["Daily Workflow\n(standup, retro)"]
        AI["AI Terminals\n(Claude sessions)"]
        PM["Plugin Manager\n(MCP servers)"]
    end
```

### Data architecture

```mermaid
erDiagram
    Project ||--o{ Phase : has
    Phase ||--o{ Feature : contains
    Feature ||--o{ Epic : "broken into"
    Epic ||--o{ Task : contains
    Task ||--o{ Task : "subtask of"
    Task ||--o{ TaskDependency : "depends on"
    Project ||--o{ Document : has
    Project ||--o{ Skill : has

    Project {
        string id PK
        string name
        string taskPath "vault path"
        json workspaces "terminal configs"
    }

    Phase {
        string id PK
        string projectId FK
        string title
        string status "TODO|READY|IN-PROGRESS|DONE"
        int position "roadmap order"
    }

    Feature {
        string id PK
        string projectId FK
        string phaseId FK
        string title
        string status
        string priority
    }

    Epic {
        string id PK
        string projectId FK
        string featureId FK
        string title
        string status
    }

    Task {
        string id PK
        string projectId FK
        string epicId FK
        string parentTaskId FK
        string title
        string status
        string priority
        string filePath ".md file"
    }

    Document {
        string id PK
        string projectId FK
        string type "adr|guide|spec|note"
        string title
        string filePath ".md file"
    }

    Skill {
        string id PK
        string projectId FK "nullable = global"
        string title
        string filePath "SKILL.md"
        boolean active
    }

    TaskDependency {
        string sourceId FK
        string targetId FK
    }
```

### Source of truth

| Data | Source of truth | Reason |
|---|---|---|
| Task structure (status, priority, relationships) | **SQLite** | Fast queries, structured |
| Content (descriptions, specs, ADRs) | **.md files** | Git-friendly, AI read/write |
| Relationships (task→feature→phase) | **SQLite** | Queryable hierarchy |
| Knowledge articles | **.md files** | Second brain, wikilinks |
| Skills | **.md files** (SKILL.md) | Claude reads directly |
| Roadmap | **SQLite** | Phase ordering, progress |

**Rule:** Structure in SQLite, content in `.md` files. Wikilinks in `.md` resolve via file system.

### AI interaction (MCP stdio)

```mermaid
sequenceDiagram
    actor User
    participant Terminal as Claude Terminal
    participant MCP as MCP Server (stdio)
    participant SQLite as SQLite
    participant Vault as .md files

    User->>Terminal: "tạo task mới cho feature login"
    Terminal->>MCP: task_create({ title, featureId, ... })
    MCP->>SQLite: INSERT task
    MCP->>Vault: Generate TASK-xxx.md (optional)
    MCP-->>Terminal: "Created TASK-135"

    User->>Terminal: "context TASK-130"
    Terminal->>MCP: task_context({ id: "TASK-130" })
    MCP->>SQLite: Query task + deps + feature + phase
    MCP->>Vault: Read .md content
    MCP-->>Terminal: Full context with hierarchy
```

### Wikilinks

`.md` files vẫn dùng `[[wikilink]]` syntax. Choda Deck resolve:
1. Scan vault cho matching filename
2. Render as clickable link trong viewer
3. Graph relationships từ SQLite bổ sung (stronger than text wikilinks)

### Inbox + Scheduler flow

```mermaid
flowchart TD
    subgraph "Capture (anytime)"
        User["User / AI"]
        Inbox["inbox/ folder"]
    end

    subgraph "Scheduler (overnight)"
        Agent["Research Agent"]
        Enriched["inbox/enriched/"]
        Git["Git commit"]
    end

    subgraph "Morning (Choda Deck)"
        Scan["Scan inbox/enriched/"]
        Suggest["Suggest actions"]
        CreateTask["Create task?"]
        AddKB["Add to knowledge?"]
        Skip["Skip?"]
    end

    User -->|"quick capture"| Inbox
    Inbox -->|"scheduler picks up"| Agent
    Agent -->|"research + enrich"| Enriched
    Enriched --> Git
    Git -->|"next morning"| Scan
    Scan --> Suggest
    Suggest --> CreateTask
    Suggest --> AddKB
    Suggest --> Skip
    CreateTask -->|"INSERT"| SQLite
    AddKB -->|"move to knowledge/"| Vault
```

**Flow:**
1. User captures thought anytime → `inbox/` folder (quick .md file)
2. Scheduler agents run overnight → research, enrich, commit to git
3. Morning: Choda Deck scans `inbox/enriched/`
4. Suggests: tạo task? thêm vào knowledge base? skip?
5. User confirms → Choda Deck executes (INSERT SQLite / move file)

Inbox lives **outside** project folders — it's a cross-project capture point.

### Git role

```mermaid
flowchart LR
    subgraph "Choda Deck (primary)"
        SQLite["SQLite (source of truth)"]
        Local[".md files (local)"]
    end

    subgraph "Git (secondary)"
        Repo["Git repo"]
        Scheduler["Scheduler agents"]
    end

    SQLite -->|"export"| Local
    Local -->|"commit"| Repo
    Scheduler -->|"research overnight"| Repo
    Repo -->|"morning import"| SQLite
```

Git is NOT required for Choda Deck to function. Git serves:
- **Backup** — version history for .md files
- **Scheduler** — background agents commit research results
- **Collaboration** — share vault via git (future)

Choda Deck works fully offline with just SQLite + local .md files.

## Implementation phases

### Phase A — SQLite hierarchy (next)

- Add Phase + Feature tables to SQLite
- Import existing vault phases/features
- Roadmap view reads from SQLite phases
- Task → Epic → Feature → Phase hierarchy

### Phase B — File manager + markdown viewer

- Built-in file browser for vault
- Markdown renderer (view .md files in app)
- Wikilink resolution (click `[[link]]` → navigate)
- Full-text search

### Phase C — Knowledge base + skills + inbox

- Browse knowledge articles (30-Knowledge/)
- Skill catalog viewer + creator
- Command manager
- Daily standup / retro views
- Inbox processing: scan enriched, suggest actions

### Phase D — Standalone workspace

- All Obsidian workflows covered
- Scheduler integration (scan git for overnight results)
- Choda Deck is standalone comprehensive workspace
- Obsidian optional — user can still use if they want

## Risks

| Risk | Mitigation |
|---|---|
| Scope creep — building IDE | Focus: AI workflow + task mgmt, not general editor |
| SQLite corruption | .md files as backup, git versioning |
| Losing mobile access | .md files in git, viewable anywhere |
| Markdown rendering quality | Use proven lib (marked/remark), not build from scratch |
| Scheduler complexity | Start simple: scan folder, no orchestration |
| Data migration — Obsidian → SQLite có thể mất data | Import tool + validate counts, giữ .md files nguyên |
| Single developer — app phức tạp, 1 người maintain | AI-assisted development, module hóa rõ ràng |
| Electron performance — nhiều views + SQLite + terminals | Lazy loading, mount-once pattern, sql.js lightweight |
| Lock-in — data locked trong SQLite | .md export luôn available, SQLite format open |
| Feature parity Obsidian — community plugins nhiều năm | Không cần 100% — chỉ cover workflow thực tế đang dùng |

## Open questions (resolved)

| Question | Answer |
|---|---|
| AI creates tasks via? | MCP tools (stdio) — local, integrates with Claude Desktop too |
| .md files role? | Storage + content layer, SQLite owns structure |
| Daily workflow? | Choda Deck Focus view + daily/retro built-in |
| Documents in SQLite? | File path + metadata only, content in .md, wikilinks preserved |
| Git role? | Secondary — backup + scheduler agents, not required for app |
| Inbox? | Cross-project capture → scheduler enriches → morning import |

## Related

- [[ADR-004-sqlite-task-management]]
- [[ADR-005-vault-import-sync]]
- [[ADR-006-project-workspace-hierarchy]]
- [[phase-1-task-management]]
- [[phase-2-skill-management]]
