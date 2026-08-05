---
type: gotcha
title: Changing the embedding model variant silently degrades ranking — it never fails
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/embedding/local-embedding-provider.ts
    commitSha: 1a0eea4b1687cbdfbe66144169069fa64a5d21c9
  - path: src/core/domain/embedding/embedding-provider-factory.ts
    commitSha: 1a0eea4b1687cbdfbe66144169069fa64a5d21c9
createdAt: 2026-08-05
lastVerifiedAt: 2026-08-05
affectedFeatureId: feature-embedding-search
---

## Trigger

You change how the embedding model is loaded — a `dtype`, a quantization flag, a different
model id, or a library major version that reinterprets an existing option — while vectors
are **already stored**. Nothing throws. Search keeps returning results. They are quietly
worse, and no test catches it.

## Context

`LocalEmbeddingProvider` embeds both sides of the comparison: queries at search time, and
documents at index time. Those vectors are only comparable if they came from the **same
model variant**. fp32 and int8 versions of `all-MiniLM-L6-v2` produce vectors in the same
384-dimensional space with the same rough geometry — so cosine similarity across variants
still yields a plausible ordering. It is degraded, not broken.

That is what makes this dangerous. A version mismatch that *crashed* would be a good bug.
This one returns a ranked list that looks entirely normal.

Found 2026-08-05 (TASK-1509) via a live instance of it. The code asks for
`pipeline(..., { quantized: true })`, which is a **transformers.js v2** option. The
installed package is `@huggingface/transformers` **v4.2.0**, where quantization is selected
with `dtype`. v4 ignores the unknown option without warning. Proof, from the cache rather
than from reading intent: `.cache/Xenova/all-MiniLM-L6-v2/onnx/` holds exactly one file,
`model.onnx` at 86.2 MB — no `model_quantized.onnx`. The request was silently dropped and
the full fp32 model has been in use the whole time.

## Business rule

**Query vectors and stored document vectors must come from the same model variant.**

A change to the variant is therefore never a one-line change. It is a migration:

1. Change the loader.
2. Re-embed **every** stored vector in the same pass. At the time of writing that is 276
   rows in `knowledge_vec_rowids`.
3. Only then serve queries from the new variant.

Doing (1) without (2) leaves the index in mixed precision indefinitely, and nothing in the
system reports it.

## Resolution

The immediate instance is filed as INBOX-1675 and deliberately **not** fixed in place —
fixing the flag alone is precisely the unsafe half of the migration.

The durable fix is to make the mismatch **detectable**, because right now it cannot be
seen at all:

- `EmbeddingProvider.id` is `local-minilm-l6-v2` and does not distinguish fp32 from q8.
  Stamp the variant into the provider id (or store it alongside each vector) so stored and
  query variants can be compared at read time.
- With that in place, a mismatch can be surfaced the way the rest of this feature already
  surfaces trouble — `searchKnowledge` returns `{ enabled: false, reason }` rather than
  pretending, and the UI renders the reason (`KnowledgeSearchBox.tsx`, TASK-1174).

Before committing to a variant change, measure retrieval quality both ways against the same
query set. The corpus is small enough (276 entries) that this is cheap, and it converts a
guess into a number.

## Wider point

This is the same failure family as TASK-1549/1551 and the TASK-1559 capture defects:
**output that is confidently wrong beats output that is obviously broken, every time.** The
guard is always the same — make the system able to tell the two states apart, then say
which one it is in.
