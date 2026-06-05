---
type: gotcha
title: "MCP tool handlers must await the async service facade — an un-awaited Promise stringifies to \"{}\""
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/mcp/mcp-tools/knowledge-tools.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
  - path: src/adapters/mcp/mcp-tools/__tests__/knowledge-tools-await.test.ts
    commitSha: 0f5b7660cf547efd5ccae6461a83c30f35c23dc3
createdAt: 2026-06-05
lastVerifiedAt: 2026-06-05
---

## Trigger

An MCP tool returns `{}` (empty object) for inputs that clearly have data — e.g. `knowledge_list({projectId})` returned `{}` for every project while `knowledge_search` worked and the rows demonstrably existed in SQLite.

## Root cause

`KnowledgeOperations` (and the wider `BackendTaskService` facade) methods are **all `async`** — they return `Promise<…>` to support the SQLite-or-Postgres port. A tool handler that forwards the result without `await`:

```ts
async ({ projectId }) => textResponse(svc.listKnowledge({ projectId }))  // BUG
```

hands `textResponse` a **pending Promise**. `JSON.stringify(promise)` is `"{}"`, so the client always sees `{}`. For read tools this looks like "no data"; for mutators (`create`/`update`/`delete`) the write still lands (the Promise resolves on the microtask queue after the response is sent) but the return is `{}` **and any rejection is silently swallowed** — a latent error sink.

Fix is one word per handler:

```ts
async ({ projectId }) => textResponse(await svc.listKnowledge({ projectId }))
```

## Why it shipped untested

The pre-existing tool-handler tests mock the facade with **synchronous** returns (`vi.fn(() => [])`). A sync mock makes `textResponse(svc.x())` work in the test even though the real facade returns a Promise — the missing `await` is invisible. Regression tests for async-facade handlers MUST use **async mocks** (`vi.fn(async () => …)`) that honor the real `Promise<…>` contract, then assert the parsed payload is the data shape (`Array.isArray`, not `{}`).

## Checklist when adding/auditing an MCP tool handler

- Is the `svc.*` method `async`? If so, `await` it before `textResponse`.
- Does the regression test mock return a Promise? If it returns a bare value, it cannot catch a missing `await`.
- For a not-found branch (`if (!entry)`), confirm `entry` is awaited — an un-awaited Promise is always truthy, so the branch never fires.

Discovered fixing TASK-990 (PR #173): 7 of 8 `knowledge_*` handlers were missing the await; only `knowledge_search` had it.
