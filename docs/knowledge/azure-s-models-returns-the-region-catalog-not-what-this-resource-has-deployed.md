---
type: learning
title: Azure's /models returns the region catalog, not what this resource has deployed
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/azure-review.ts
    commitSha: 4bc9ed5be4051863468ee50325e02a598d73fcb7
createdAt: 2026-09-05
lastVerifiedAt: 2026-09-05
---

**Trigger:** you build a model picker from the obvious endpoint, and it offers hundreds of options. Every one the reader picks answers `DeploymentNotFound`, and the bug looks like yours.

**Context.** Measured against a real Azure AI Foundry resource on 2026-09-05 (TASK-1856). The resource has **six** deployments. `GET {endpoint}/models` returned **428** entries — `dall-e-3`, `code-cushman-001`, `whisper-001`, every `gpt-4` snapshot — because it lists what the *region supports*, not what this resource *has*.

**The rule.** Two different questions, two different routes:

```
GET {endpoint}/models                                        -> the region catalog (428)
GET {base}/openai/deployments?api-version=2023-03-15-preview -> this resource (6)
GET {base}/openai/deployments?api-version=2024-10-21          -> 404 Resource not found
```

Note the second trap inside the first: the deployments route answers **only** to `2023-03-15-preview`. The api-version the chat calls use returns `404`, which reads like a wrong URL and is actually a wrong version — so the fix looks like "the path is wrong" and is not.

**Chat versus embedding is a capability join, not a name prefix.** Filtering the deployments on a `text-embedding-` prefix works today and hides the first chat model that breaks the convention. Instead, join each deployment's `model` against the catalog's own `capabilities.chat_completion` — the 428-entry catalog is the right source for *capabilities*, just the wrong one for *availability*. Verified correct across all six deployments, and a test proves a chat-capable deployment named `text-oracle` is still offered.

**Resolution.** `listAzureModels()` calls both routes and intersects them: deployments with `status === 'succeeded'` whose model is chat-capable in the catalog. A listing failure returns 502 and leaves review working on the configured default — a picker is a convenience, and a convenience that can take out a feature was built wrong.
