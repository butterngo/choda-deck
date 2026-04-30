---
type: decision
title: Pure heuristic core, thin git wrapper for stubbability
projectId: choda-deck
scope: project
refs:
  - path: src/core/domain/knowledge-suggestions.ts
    commitSha: 045ef8f38390e1e0c4ade6b0ff164701c96c4db8
  - path: src/core/domain/knowledge-git.ts
    commitSha: 045ef8f38390e1e0c4ade6b0ff164701c96c4db8
  - path: src/core/domain/knowledge-suggestions.test.ts
    commitSha: 045ef8f38390e1e0c4ade6b0ff164701c96c4db8
createdAt: 2026-04-30
lastVerifiedAt: 2026-04-30
---

# Pure heuristic core, thin git wrapper for stubbability

## Decision

Khi 1 module domain có 2 phần: **logic thuần** (filter / classify / shape data) và **side-effect** (git/fs/network), tách thành 2 layer:

1. **Pure core** — chỉ nhận data in, trả data out. Zero I/O, zero global state. Test trực tiếp bằng plain function calls + literal inputs.
2. **Thin wrapper** — gọi binary/API một call, trả structured data. Mock-able qua interface 1-2 method. Không chứa business logic.

Pattern chuẩn trong codebase:

| Pure core | Thin wrapper | Test path |
|---|---|---|
| `knowledge-suggestions.ts` `suggestKnowledge()` | `collectFilesByCommit()` calling `GitOps.filesInCommit()` | `knowledge-suggestions.test.ts` stubs `CommitFilesGit` interface |
| `knowledge-service.ts` staleness compute | `knowledge-git.ts` `GitOpsImpl` | `knowledge-service.test.ts` `FakeGitOps` |

## Why

- Unit tests cho heuristic không spawn `git` subprocess → CI nhanh + deterministic
- Stub git failures (missing repo, bad SHA) qua test scenarios chứ không cần test fixture filesystem
- Heuristic logic thay đổi (keywords, thresholds) không động vào git layer; ngược lại git layer đổi (different VCS) không impact heuristic tests

## How to apply

Khi thêm module domain mới:

1. Identify side-effects → đẩy vào interface (`GitOps`, `FsOps`, ...)
2. Pure core nhận **kết quả** của side-effect (e.g. `Map<sha, files[]>`), không nhận function reference
3. Wrapper module: 1 function = 1 binary call. Try/catch swallow per-call, không bubble lỗi vào core.
4. Test pure core với literal `Map`/`Array`; test wrapper với fake binary nếu cần (rare).

## Anti-pattern

- Pure core gọi git/fs trực tiếp → test phải spawn process
- Wrapper chứa filter logic → test wrapper phải prepare git fixture cho mỗi heuristic case
- Interface fat (5+ method) → consumer chỉ cần 1 method nhưng phải mock toàn bộ → dùng `Pick<>` hoặc segregate interface

## Related

- ADR-015 lifecycle services pattern (transactional core, thin facade)
- TASK-639 first explicit application để ship session_end suggestions
