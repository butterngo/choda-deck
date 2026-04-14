---
date: 2026-04-14
status: accepted
---

# ADR-008: Phase B — File Manager + Markdown Viewer Design

## Context

Phase A (SQLite hierarchy) complete. Next step per ADR-007 roadmap: replace Obsidian's core file browsing capabilities. Need file tree browser, markdown renderer, wikilink resolution, and full-text search inside Choda Deck.

Constraints: renderer sandboxed (contextBridge only), no global state lib (R6 open), ViewRouter mount-once pattern, sql.js for SQLite, solo dev.

## Decisions

### D1: File browser as ViewRouter tab (not sidebar panel)

**Chosen:** New "Files" tab in ViewRouter alongside Terminal, Tasks, Roadmap, Focus.

**Alternatives rejected:**
- Sidebar panel — crowded, complex layout
- Split (tree in sidebar, content as tab) — most complex, Phase D territory

**Why:** Consistent with existing view pattern. KISS. Side-by-side browsing (files + terminal) deferred to Phase D when full Obsidian replacement is needed.

### D2: react-markdown + remark-gfm for rendering

**Chosen:** `react-markdown` with `remark-gfm` plugin, `remark-wiki-link` for wikilinks, `rehype-highlight` for syntax highlighting.

**Alternatives rejected:**
- `marked` — requires `dangerouslySetInnerHTML`, no React integration
- `@mdx-js/react` — overkill for view-only rendering

**Why:** React-native rendering (no innerHTML), rich plugin ecosystem for wikilinks and GFM, safer by default.

### D3: Main-process grep for search (not FTS)

**Chosen:** `fs.readFile` + regex line matching in main process. No index.

**Alternatives rejected:**
- SQLite FTS (sql.js supports FTS3/4 only, index maintenance overhead)
- In-memory index (lunr.js/minisearch — memory overhead, rebuild on changes)

**Why:** Vault is ~500 files. Grep is fast enough. Zero maintenance. Add FTS later if perf degrades.

### D4: Navigate within Files view + history stack

**Chosen:** Wikilink clicks navigate within the Files view. Back-stack (array of paths) for back-button.

**Alternatives rejected:**
- Modal overlay — nested modals awkward
- Breadcrumb stack — more state complexity than needed

**Why:** Matches Obsidian mental model. Minimal complexity.

## Architecture

### New IPC surface: `window.api.vault`

| Channel | Kind | Purpose |
|---|---|---|
| `vault:tree` | invoke | Read directory tree recursively |
| `vault:read` | invoke | Read file content + stat |
| `vault:search` | invoke | Grep files for query, return matches |
| `vault:resolve` | invoke | Resolve `[[wikilink]]` to absolute path |

### Renderer components

```
FilesView (container — registered in ViewRouter)
  ├── SearchBar (debounced search + results dropdown)
  ├── FileTree (left panel — recursive expand/collapse)
  └── MarkdownViewer (right panel — react-markdown + wikilinks)
```

### Wikilink resolution

Main process builds `Map<basename, absolutePath>` cache on first resolve. Cache invalidated on `vault:tree` call. No file watcher for MVP.

## Consequences

- 4 new IPC channels (`vault:*`) — follows existing namespace pattern
- 3 new npm deps: `react-markdown`, `remark-gfm`, `remark-wiki-link` (+ optional `rehype-highlight`)
- Files view is read-only — no editing in Phase B
- Search is O(n) file scan — acceptable for ~500 files, revisit if vault grows 10x

## Related

- [[ADR-007-choda-deck-replaces-obsidian]] — vision document
- [[ADR-004-sqlite-task-management]] — SQLite data model
