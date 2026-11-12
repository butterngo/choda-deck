---
type: decision
title: Hybrid knowledge search maps onto Postgres as tsvector plus pgvector, fused by RRF
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/embedding/lexical-index.ts
  - path: src/core/domain/knowledge-service.ts
  - path: src/core/domain/embedding/embedding-store.ts
createdAt: 2026-11-12
lastVerifiedAt: 2026-11-12
---

# Hybrid knowledge search maps onto Postgres as tsvector plus pgvector, fused by RRF

TASK-3253 made `knowledge_search` hybrid on SQLite. This note records how the same design maps onto the Postgres backend (TASK-2028), so the pgvector slice ports it instead of re-deciding it.

## What SQLite does today

| Part | SQLite |
|---|---|
| Lexical leg | FTS5 table `knowledge_fts(slug UNINDEXED, title, body)`, tokenizer `unicode61 remove_diacritics 2`. Ranked by `bm25(knowledge_fts, 0, 5, 1)`, so a title hit weighs five body hits. The query is every word quoted and joined with `OR` (`ftsQuery`), so FTS syntax never reaches the parser. |
| Vector leg | One vector per title-prefixed chunk (200 words, 40 overlap) in `knowledge_vec`, mapped to entries by `knowledge_chunk_map`. An entry scores by its nearest chunk: `MIN(vec_distance_l2(...)) GROUP BY entry`. |
| Filters | `projectId`, `type` and `scope` are applied in both legs' `WHERE`, before the k-cut (TASK-3259). |
| Fusion | Reciprocal Rank Fusion, `score = Σ wᵢ / (60 + rankᵢ)`. The vector leg has weight 1 over its top 50; the lexical leg has weight `LEXICAL_WEIGHT = 0.5` over its top `LEXICAL_DEPTH = 3`. These values come from the 2026-11-12 sweep recorded in `knowledge-service.ts`. |
| Result | Ordered by `score`. Every hit carries its vector `distance`, including hits found only by the lexical leg (`distancesFor`). |

## The Postgres mapping

| Part | Postgres |
|---|---|
| Lexical leg | A `tsvector` column built as `setweight(to_tsvector('simple', title), 'A') \|\| setweight(to_tsvector('simple', body), 'D')`, with a GIN index. The query is `websearch_to_tsquery('simple', …)` with its terms joined by `\|`, which cannot raise a syntax error. Rank with `ts_rank_cd(tsv, query, 1)`; `ts_rank` also works. Use the `simple` configuration, not `english`, so identifiers such as `QUEUE_AC_FINAL_VERIFY_NUDGE` are not stemmed. Wrap `unaccent` around the input to match `remove_diacritics`. |
| Vector leg | A `knowledge_chunks(entry_slug, chunk_index, embedding vector(384))` table with an HNSW index (`vector_l2_ops`). Per entry: `MIN(embedding <-> $q) GROUP BY entry_slug`. |
| Filters | A join to `knowledge_index` with the same `WHERE` in both CTEs. |
| Fusion | The same RRF constants. It can be done in SQL: two CTEs, each with `row_number() OVER (ORDER BY …)` as its rank, a `FULL OUTER JOIN` on slug, and `COALESCE(1.0/(60+v.rank),0) + 0.5*COALESCE(1.0/(60+l.rank),0)`. Or it can call the same `rrfFuse` in TypeScript over the two ranked lists. Prefer the TypeScript path, so one function owns the formula. |

## Why this shape

RRF uses ranks only. A bm25 score, a `ts_rank` value and an L2 distance never have to share a scale, so the backend can change without re-tuning a score normalisation. Only the two depths and the weight are tuned, and they are tuned against the TASK-3252 eval set, whatever the backend.
