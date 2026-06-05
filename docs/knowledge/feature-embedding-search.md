---
type: feature
title: Embedding-backed semantic search
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/embedding/local-embedding-provider.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/core/domain/embedding/embedding-provider-factory.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-04
lastVerifiedAt: 2026-06-04
realizesTasks: ["TASK-643"]
inWorkspaces: ["main"]
effortBand: M
status: shipped
---

Semantic recall over knowledge/memory via sqlite-vec embeddings, behind a provider interface with local and noop implementations so it degrades gracefully when embeddings are unavailable. ADR-020.

Supports [[feature-knowledge-layer]] and [[feature-agent-memory]] recall. Realizes list is thin (one confidently-matched task) — extend if more embedding tasks are recalled.
