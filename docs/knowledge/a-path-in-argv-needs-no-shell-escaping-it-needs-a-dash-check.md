---
type: gotcha
title: A path in argv needs no shell escaping — it needs a dash check
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/docker-exec.ts
    commitSha: 8f91a70c96b3edb146cd5ecde49850e365b102c8
  - path: src/adapters/companion/docker-run.ts
    commitSha: 8f91a70c96b3edb146cd5ecde49850e365b102c8
createdAt: 2026-09-07
lastVerifiedAt: 2026-09-07
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** you are adding a route that puts a user-supplied string into a child process's arguments, and you reach for a denylist of `;`, `&&`, `|`, `$(...)`.

## Context

The adapter spawns processes in several places — `git` in `workspace-commits.ts`, `docker` in the container routes. All of them use `execFile`-style spawning with **args as an array**. There is no shell anywhere on that path.

The instinct on seeing user input reach argv is to strip shell metacharacters. In `docker-exec.ts` that instinct is wrong twice over, and a test asserts the opposite on purpose.

## Business rule

**Escaping defends against a shell. With no shell, it defends against nothing — and it breaks real inputs.**

`docker exec <id> ls -la <path>` passes `path` as one element of an array. The kernel receives it verbatim; no interpreter ever sees it. So `/app/a b;c&&d$(e).json` is simply a filename, and a route that rejects it has broken a legitimate file while preventing no attack that was ever possible.

**What must never happen is an argument becoming a flag.** `-rf`, `--privileged`, `-f` — these are not intercepted by any shell either, but the *program* reads them as options. That is the real boundary, and it is one character wide.

Two rules follow:

1. **Refuse a leading `-`**, before spawning. This is the whole validation a path needs.
2. **Assert the argv WHOLE, with `toEqual`.** `toContain` passes against an array with an extra flag appended, which is precisely the failure the check exists to prevent.

## Resolution

- `docker-exec.ts` accepts every metacharacter and has a test named for it, so a future reader tightening it "for safety" turns that test red and finds this note.
- `docker-run.ts` applies the same reasoning to a container **name** (`-rm` is refused) and takes the further step of resolving an image by **id** rather than reference — `postgres:16` is refused, because accepting a reference is what would let docker pull from wherever the name points.
- Refusals happen in the adapter, **before** spawning, even when the daemon would refuse too: our message can name *which* container, and it cannot be removed by appending a flag.

## Related

- TASK-1875 (`docker-exec`), TASK-1874 (`docker-run`), TASK-1873 (images), TASK-1866 (actions)
- The permission shape these all share: fixed program, array args, no shell, no stdin, capped buffer, behind an injectable seam — `workspace-commits.ts` `GitCommitReader` is the original
