---
type: gotcha
title: A display ceiling refuses; it does not truncate
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/vault-projects.ts
    commitSha: 
  - path: src/adapters/companion/vault-projects.test.ts
    commitSha: 
createdAt: 2026-09-20
lastVerifiedAt: 2026-09-20
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** you are adding a route that reads a file and hands it to a renderer, and you reach for a size limit. The instinct is to cap it — read the first N bytes and send those.

## Context

`GET /vault/projects/:id/meetings/:folder/:file` (TASK-2051) returns markdown that the companion reads whole into the renderer and parses on the UI thread. A file that is unexpectedly enormous — a day-long transcript, or something that is not what its name suggests — is held in memory twice and then parsed there. A frozen window is not a legible failure.

So a ceiling is right. `VAULT_FILE_MAX_BYTES = 2 * 1024 * 1024`, chosen against what is actually on disk: notes run 34–40 KB, the largest transcript ~300 KB. That is ~7× the biggest real file — a ceiling that sits far above observed data while still being a ceiling, rather than a number picked so nobody ever reaches it.

## Business rule

**Over the ceiling, refuse. Never truncate.**

Half a meeting note renders as a *complete* meeting note. Markdown has no torn edge: the last heading closes, the last table row is a table row, and nothing in the output says bytes were dropped. A reader acts on a decision list that is missing its second half and has no way to know.

A refusal with the numbers is legible and actionable:

```ts
if (bytes > VAULT_FILE_MAX_BYTES) {
  sendJson(res, 413, { error: 'file too large to display', bytes, maxBytes: VAULT_FILE_MAX_BYTES })
  return true
}
```

## Resolution

Report both numbers so the UI can say what it hit and what the limit was, in the units each is legible in — and point at a way the user can still get the content. Here that is the file manager, because the path is already on screen:

> This file is 3072 KB, over the 2 MB display limit. Open it in the file manager instead.

Test **both sides** of the boundary, or the ceiling is unproven: seed `MAX + 1` and assert 413 with no content in the body, and seed `MAX - 1` and assert 200. A one-sided test passes for a route that refuses everything.

Decide the number and write down *why* before the route exists. The criterion for TASK-2051 required it in the task body first, which is what turned "2 MB feels fine" into a measurement against real files.
