---
type: gotcha
title: A flat distance profile from knowledge_search means NO match, not N matches
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-08-07
lastVerifiedAt: 2026-08-07
affectedFeatureId: feature-embedding-search
---

## Trigger

You call `knowledge_search`, get a full `topK` result set back, and rank or
present those rows as "what we know about X".

## Context

`knowledge_search` embeds the query with the active provider and returns rows
ordered by vector distance. It **never returns an empty result set for an
off-topic query** — there is no relevance threshold. With the local
`local-minilm-l6-v2` provider the distances for a non-matching query bunch
around ~1.0–1.20 with no gap between hit 1 and hit 8.

## Business rule

**A flat distance profile is the signal for "nothing matched".** Rank order
alone carries no information about whether anything is actually relevant. Treat
`topK` rows with no distance gap as ZERO knowledge-layer hits, not as N hits.

Verified twice, both times 0/8 results were relevant:

| Query | Distances | Relevant results | Found by term matching instead |
|---|---|---|---|
| `git worktree` | 1.07–1.20 | 0 of 8 | ADR-014, ADR-019, 2 vault notes |
| `BPA` | 1.09–1.14 | 0 of 5 | `video-bpmn-business-process-automation.md` |

## Resolution

- Use semantic results only to **add** candidates a term search missed. Never
  to order, filter, or reject a hit found by term evidence.
- Rank by term evidence in the body — term density, term in a heading, term in
  the first 20 lines.
- Drop an uncorroborated semantic result rather than padding an answer with it.
- Note there is currently **no MCP tool doing full-text over entry bodies**:
  `knowledge_list` is metadata-only and `knowledge_search` is embeddings. For a
  body-level sweep, grep the directories from `knowledge_list`'s `filePath`
  values (canonical by construction — worktree copies cannot appear).

## Related

Cause vs symptom: `changing-the-embedding-model-variant-silently-degrades-ranking-it-never-fails`
documents *why* ranking degrades (model variant mismatch, no failure signal).
This entry is the caller-side symptom and what to do instead.

Consumed by the `/choda-knowledge-search` skill, which treats semantic rank as
advisory only for exactly this reason.
