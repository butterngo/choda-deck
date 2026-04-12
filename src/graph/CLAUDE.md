# Choda Deck — Graph layer

## Purpose

Pure types + interface for the graph data layer. Defines the contract that all graph implementations (Neo4j, SQLite) must satisfy. Zero runtime dependencies — consumers import from `src/graph/index.ts` without coupling to a specific backend.

## What belongs here

- `GraphService` interface — the abstract contract (CRUD nodes, relationships, context queries, batch import)
- Shared types: `GraphNode`, `GraphEdge`, `ContextResult`, `NodeType`, `RelationType`
- `GraphConfig` discriminated union + `createGraphService` provider factory
- `buildUid()` helper for the UID format `"{type}:{project}/{id}"`

## What does NOT belong here

- Implementation code (Neo4j driver, SQLite queries) — those go in their own modules and register via `registerGraphProvider`
- CLI or MCP surface — those consume this layer, not live in it
- Runtime dependencies — this layer must stay pure types + interface + factory
