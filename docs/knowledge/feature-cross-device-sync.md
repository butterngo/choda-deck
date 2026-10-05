---
type: feature
title: Cross-device sync (canonical export / import)
projectId: choda-deck
scope: project
refs:
  - path: src/core/sync/export-service.ts
    commitSha: 3f1de6130d7a67b9d7d31df63bf37a4c6346d010
  - path: src/core/sync/import-service.ts
    commitSha: 3f1de6130d7a67b9d7d31df63bf37a4c6346d010
  - path: src/core/sync/canonical-json.ts
    commitSha: 3f1de6130d7a67b9d7d31df63bf37a4c6346d010
createdAt: 2026-06-04
lastVerifiedAt: 2026-10-05
anchorTaskId: TASK-978
realizesTasks: ["TASK-671","TASK-672","TASK-978","TASK-979"]
inWorkspaces: ["main"]
effortBand: L
status: in-progress
---

Move project state between devices via a canonical, deterministic snapshot — export to a portable form, import with preflight + path remapping. The additive-columns + read-only pull phase (ADR-030 §2) is the current epic; later write-through, last-writer-wins, and inbox-surfacing phases are parked.

ADR-005 + ADR-030. Anchor epic TASK-978 is TODO; TASK-979 is [PARKED]. INTEGRATES_WITH [[feature-postgres-remote-backend]].
