---
type: learning
title: A reasoning deployment answers HTTP 200 with an empty body when the token budget is too small
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/azure-review.ts
    commitSha: 4bc9ed5be4051863468ee50325e02a598d73fcb7
  - path: src/adapters/companion/ai-review.ts
    commitSha: 4bc9ed5be4051863468ee50325e02a598d73fcb7
createdAt: 2026-09-05
lastVerifiedAt: 2026-09-05
---

**Trigger:** a model call returns `200`, your parser reports "the provider answered badly", and you go and rewrite the prompt. Nothing you do to the prompt helps, because the model never wrote an answer at all.

**Context.** Measured against Azure AI Foundry on 2026-09-05 while building `POST /claude-config/review` (TASK-1856). A reasoning-class deployment spends its token budget *thinking* before it writes anything, and the budget is shared between the two.

```
gpt-5-mini, max_completion_tokens: 300
  -> 200, finish_reason "length", content "" (0 chars)
     usage.completion_tokens_details.reasoning_tokens = 300

gpt-5-mini, max_completion_tokens: 2000
  -> 200, finish_reason "stop", content 489 chars
     reasoning_tokens = 384
```

The non-reasoning deployments in the same resource — `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o` — answer fine at 300, so the difference is the model family, not the prompt or the schema.

**The rule.** `200` + `finish_reason: length` + empty content is **its own fact** and needs its own error kind. Folding it into a parse failure is not a cosmetic mislabel: it sends the reader to debug a prompt when the fix is a number. The two failures have opposite remedies, so they must not share a name.

**Resolution.** `AiErrorKind` gained `budget`, reported as *"<deployment> used its whole token budget before answering — raise it and retry"*. Two CONTROL tests keep it honest: genuinely malformed content still reports `parse`, and a non-null `refusal` still reports `refusal`, so `budget` cannot become the answer to everything.

**A second consequence of the same family split.** A reasoning deployment **rejects** `max_tokens` outright and requires `max_completion_tokens`; the others do not know the second name. The field is therefore chosen per deployment, matched on a name prefix (`gpt-5`, `o1`, `o3`, `o4`) rather than an exact id — a deployment is named by whoever created it, so `gpt-5-mini-prod` is the same model with the same two constraints.

**How to find this again:** if a model call returns 200 and your notes array is empty, read `finish_reason` and `usage.completion_tokens_details.reasoning_tokens` before touching the prompt.
