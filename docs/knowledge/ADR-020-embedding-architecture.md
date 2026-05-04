---
type: decision
title: "ADR-020: Embedding Architecture — local default with provider abstraction for semantic search"
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/embedding/embedding-store.ts
    commitSha: 47e20ee8c6fbc44a043cfcb2f6ebf786b17a462f
  - path: src/core/domain/embedding/local-embedding-provider.ts
    commitSha: 47e20ee8c6fbc44a043cfcb2f6ebf786b17a462f
  - path: src/core/domain/embedding/embedding-provider-factory.ts
    commitSha: 47e20ee8c6fbc44a043cfcb2f6ebf786b17a462f
  - path: src/core/domain/sqlite-task-service.ts
    commitSha: 47e20ee8c6fbc44a043cfcb2f6ebf786b17a462f
  - path: src/core/domain/knowledge-service.ts
    commitSha: 47e20ee8c6fbc44a043cfcb2f6ebf786b17a462f
  - path: src/adapters/mcp/mcp-tools/knowledge-tools.ts
    commitSha: 47e20ee8c6fbc44a043cfcb2f6ebf786b17a462f
createdAt: 2026-05-04
lastVerifiedAt: 2026-05-04
---

# ADR-020: Embedding Architecture — local default with provider abstraction for semantic search

> AI-Context: Semantic search on `knowledge_index` is implemented via `sqlite-vec` virtual table (`knowledge_vec`) joined to `knowledge_index` by rowid. Embeddings come from a pluggable `EmbeddingProvider` interface. Default provider is local `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`. Provider switch (Voyage / OpenAI) is an env-var change plus auto re-embed on model mismatch detected at startup. `@huggingface/transformers` and `onnxruntime-node` are `optionalDependencies` so default install footprint stays small.

## Context

`knowledge_list` and `task_list` filter only by string match — they cannot retrieve "ideas similar to X" when the wording differs. Use case: query `"ADR about caching strategy"` should surface a relevant ADR even if the body never contains the literal word `caching`.

Constraints:

- **Privacy.** `knowledge_index` stores ADRs and project state — private content. Sending it to a third-party API every `knowledge_create` is a leak.
- **Distribution.** Choda-deck is OSS distributed via `pnpm`. Forcing every installer to download a 310 MB ML stack just to read tasks is hostile.
- **Scale today.** 17 entries. A local brute-force KNN over 384-dim vectors completes in < 1 ms.
- **Future scale.** Likely 100–1000 entries within a year. Still small enough for brute-force.
- **Future provider switch.** Butter may want to switch to a higher-quality API model (Voyage `voyage-code-3`, OpenAI `text-embedding-3-large`) when local quality becomes the bottleneck.
- **Hard ML constraint.** Vectors from different models live in incompatible spaces. Switching models requires re-embedding **every** existing row; partial migration is impossible.

POC validated the stack (TASK-643): `sqlite-vec` extension loads in `better-sqlite3` on Windows + plain Node, `@huggingface/transformers` v4 generates embeddings using WASM fallback (no native `onnxruntime-node` build script needed), and KNN retrieval pulled the correct ADR for a paraphrased query that shared no keywords with the source text.

## Options considered

### Embedding provider

| Option | Pro | Con |
|---|---|---|
| Local `Xenova/all-MiniLM-L6-v2` (chosen) | Free, private, zero external setup, 384 dims small | English-only, MTEB ~58 (mid tier), 310 MB native deps if not externalized |
| OpenAI `text-embedding-3-small` | Multilingual, MTEB ~62, $0.00002/1K tokens | Leaks knowledge content to OpenAI, requires API key |
| Voyage `voyage-3-lite` / `voyage-code-3` | Anthropic-recommended partner, 200 M tokens free tier, code-specialized variant | Leaks content to Voyage, API key required |
| BAAI `bge-m3` (local multilingual) | MTEB ~64, multilingual including Vietnamese, free | ~600 MB model file vs ~25 MB for MiniLM |

### Vector storage layout

| Option | Pro | Con |
|---|---|---|
| Separate `knowledge_vec` virtual table joined by rowid (chosen) | Idiomatic `sqlite-vec`; vector format isolated; recreate without touching `knowledge_index` | Two-table join on every search query |
| `ALTER TABLE knowledge_index ADD COLUMN embedding BLOB` | Single-table read | `vec0` not used → manual KNN in JS (slower); `embedding` dim is fixed → schema migration on dim change |

### Generation timing

| Option | Pro | Con |
|---|---|---|
| Async — `knowledge_create` returns immediately, embedding populated in background (chosen) | No blocking; first call fast even when model not yet loaded (8.5 s cold start) | `knowledge_search` must skip rows whose vector isn't yet ready |
| Sync — `knowledge_create` blocks until embedded | Simpler invariant: every row has a vector after create returns | Cold start blocks 8.5 s; every API call blocks ~200 ms |

### Packaging

| Option | Pro | Con |
|---|---|---|
| `@huggingface/transformers` + `onnxruntime-node` as `optionalDependencies` (chosen) | Default install < 5 MB; semantic search is opt-in | Code paths must handle "provider not installed"; degraded mode for `knowledge_search` |
| Eager bundle inline | Out-of-the-box experience | Forces 310 MB on every user, even those who never use search |

## Decision

### 1. Default provider — local `Xenova/all-MiniLM-L6-v2`

384 dims, quantized INT8, ~25 MB model file cached at `~/.cache/huggingface/`. Loaded via `@huggingface/transformers` v4 (the maintained successor to `@xenova/transformers` v2 — v2 hard-depends on `sharp` which fails to load on Windows without an explicit native build).

Rationale: privacy, zero recurring cost, zero external setup, and quality is sufficient at 17–1000 entries for English ADR content. Multilingual quality is weak, but per the project `CLAUDE.md` rule *"All .md files: English only"*, `knowledge_index` content is English. Vietnamese-bearing data (conversations, task bodies) is out of scope for phase 1.

### 2. Provider abstraction

```ts
export interface EmbeddingProvider {
  readonly id: string         // e.g. 'local-minilm-l6-v2', 'voyage-3-lite', 'openai-3-small'
  readonly dims: number       // 384, 512, 1536, …
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}
```

Three concrete implementations live behind the interface and are loaded **lazily** via dynamic `import()` from a factory keyed on `CHODA_EMBEDDING_PROVIDER` env (`local` | `voyage` | `openai`). Modules that consume embeddings (`knowledge_create`, `knowledge_search`, the backfill script) depend only on the interface. Adding a fourth provider is a new file plus one switch case in the factory — no call-site changes.

### 3. Schema — separate `vec0` virtual table

```sql
CREATE VIRTUAL TABLE knowledge_vec USING vec0(embedding float[384]);

ALTER TABLE knowledge_index ADD COLUMN embedding_provider_id TEXT;
ALTER TABLE knowledge_index ADD COLUMN embedding_dims INTEGER;
```

`knowledge_index` retains its existing schema and gets two metadata columns recording which provider embedded each row. `knowledge_vec` holds vectors; rows join by `rowid`. Queries use `knowledge_vec MATCH ? AND k = ?` with results ordered by distance.

Rationale: `vec0`'s dimensionality is fixed at `CREATE VIRTUAL TABLE` time. Putting the vector inline in `knowledge_index` would either lock the dim forever or force an `ALTER` migration on every model change. Separating them means a model switch is `DROP TABLE knowledge_vec; CREATE VIRTUAL TABLE knowledge_vec USING vec0(embedding float[<new>]);` plus a re-embed pass — `knowledge_index` content is untouched.

### 4. Generation is async

`knowledge_create` returns to the caller immediately after the row lands in `knowledge_index`. Embedding generation is queued in a background worker (single in-process queue, no concurrency primitives required at this scale). `knowledge_search` is a `LEFT JOIN` against `knowledge_vec`; rows without a vector are filtered out of the candidate set with a logged note that they weren't yet embedded.

Rationale: model cold-load is 8.5 s on first invocation. Even cached, an embed call is ~10 ms — small but compounding across batch creates. Async also makes the pattern uniform whether the provider is local (~10 ms) or an HTTP API (~100–500 ms with retry and rate-limit handling).

### 5. Packaging — `optionalDependencies`

`@huggingface/transformers`, `onnxruntime-node`, and `sharp` move to `optionalDependencies` in `package.json`. Default `pnpm install` skips them. Power users opt in:

```bash
pnpm install --include=optional
# OR
pnpm add @huggingface/transformers onnxruntime-node
```

When the deps are missing, `loadProvider('local')` resolves to a `NoopEmbeddingProvider` whose `embed()` throws a typed error. `knowledge_search` catches that error and returns `{ enabled: false, reason: 'optional embedding deps not installed' }` instead of crashing. `knowledge_create` simply skips the embed step with a single warning logged.

### 6. Build externals

`build:mcp` adds `--external:onnxruntime-node --external:onnxruntime-web --external:sharp` so the bundle stays at ~2.4 MB. Native `.node` binaries cannot be bundled by esbuild and stay in `node_modules` at runtime. Combined with the `optionalDependencies` rule, the final shipped artifact is small whether the user opts into search or not.

### 7. Provider switch — startup model-mismatch detection

On `SqliteTaskService` startup, after the active provider is resolved, check the most-recent `embedding_provider_id` value in `knowledge_index`. If it differs from the active provider, trigger a re-embed migration:

1. `DROP TABLE knowledge_vec;`
2. `CREATE VIRTUAL TABLE knowledge_vec USING vec0(embedding float[<new dims>]);`
3. Iterate `knowledge_index` rows, embed body, insert into `knowledge_vec`, update `embedding_provider_id` + `embedding_dims`.

For 17 entries with a local provider this is sub-second. For 1000 entries against Voyage's free tier, ~5 seconds plus zero cost (well within 200 M token allowance). The migration is idempotent — interrupting and restarting picks up where it left off because rows whose `embedding_provider_id` already matches the active provider are skipped.

## Why not others

| Option | Rejected because |
|---|---|
| OpenAI / Voyage as default provider | Forces every user to obtain an API key and leaks knowledge content. Voyage stays as the recommended **upgrade path** rather than the default |
| Embedding column inline in `knowledge_index` | Locks dim at table create; `vec0` semantics not used → must implement KNN in application code |
| Sync `knowledge_create` | First-call latency of 8.5 s for cold model load is not acceptable for a write API. API providers would compound this with network latency on every call |
| Eager bundle (no optional deps) | Forces 310 MB on the 95 % of users who don't need semantic search |
| `@xenova/transformers` v2 | Hard dependency on `sharp`, which on Windows fails without an explicit `pnpm approve-builds` for native compile. The successor `@huggingface/transformers` v4 makes `sharp` optional |
| BAAI `bge-m3` as default | Multilingual quality is excellent, but the model file is ~600 MB vs ~25 MB for MiniLM — not justified given current English-only scope |

## Consequences

- **Good.** Privacy preserved by default. Distribution footprint stays at < 5 MB unless user opts in. Provider switch is an env-var change plus an auto-migration. Code consumers of embeddings depend only on the interface, not on any concrete model
- **Good.** Schema isolates vector storage — model dim changes don't touch `knowledge_index`
- **Bad.** Two-step search (`LEFT JOIN` + filter rows missing vectors) is slightly more complex than a single-table read. At 17 entries this is invisible; if performance degrades at scale, materialize a view or maintain a "ready-to-search" index column
- **Bad.** First `knowledge_create` after process start triggers an 8.5 s model load on a background thread — the create itself is fast, but the embedding for that first row is delayed. Acceptable since search results being briefly incomplete is preferable to write API latency
- **Risks.** If a provider's API changes shape (Voyage v4, OpenAI v5), the corresponding provider implementation file is the only place that needs updating. Each provider is < 50 lines

## Impact

- **Files/modules added:**
  - `src/core/domain/embedding/embedding-provider.interface.ts`
  - `src/core/domain/embedding/local-embedding-provider.ts`
  - `src/core/domain/embedding/noop-embedding-provider.ts`
  - `src/core/domain/embedding/embedding-provider-factory.ts`
  - `src/adapters/mcp/mcp-tools/knowledge-search-tool.ts`
  - `scripts/backfill-embeddings.mjs`
- **Files modified:**
  - `src/core/domain/sqlite-task-service.ts` — load `sqlite-vec` extension, run schema migration
  - `src/core/domain/knowledge-service.ts` — async embedding queue on `knowledge_create`
  - `src/adapters/mcp/server.ts` — register `knowledge_search` tool
  - `package.json` — add `sqlite-vec` to deps, `@huggingface/transformers` + `onnxruntime-node` + `sharp` to `optionalDependencies`
  - `package.json` `build:mcp` script — add `--external:onnxruntime-node --external:onnxruntime-web --external:sharp`
- **Dependencies affected:** `sqlite-vec` (required, ~14 KB), `@huggingface/transformers` (optional, ~99 MB), `onnxruntime-node` (optional, ~212 MB), `sharp` (optional, ~600 KB)
- **Migration needed:** yes, automatic — schema migration on startup adds `knowledge_vec` virtual table and the two metadata columns; backfill script populates 17 existing rows on first run

## Revisit when

- Active scale crosses ~10 000 entries — `sqlite-vec` brute-force KNN starts becoming noticeable; consider migrating to an ANN-capable store (Qdrant, LanceDB)
- Vietnamese content moves into `knowledge_index` (e.g. project state notes get embedded) — local English-only model becomes a quality bottleneck; reconsider `bge-m3` local or Voyage multilingual
- The 8.5 s cold-load on first embed becomes a UX pain (e.g. a power user creates 50 entries in a row) — preload the model in the worker on `SqliteTaskService` constructor instead of on first embed
- A frontier model from Anthropic eventually ships an embedding endpoint — the provider abstraction makes adoption trivial

## Related

- ADR-018: Knowledge Layer Foundation — code-coupled MD with frontmatter and staleness tracking
- ADR-019: ADR Numbering Convention — keep ADR-NNN prefix in slug
- TASK-643: Semantic search on `knowledge_index` via `sqlite-vec`
- TASK-506: `related_context()` cross-project intelligence — future consumer of the embedding layer
- INBOX-036: Original sketch that became this ADR (converted)
- CONV-1777864297783-2: POC validation conversation, includes raw stack-decision findings
