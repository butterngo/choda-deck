---
type: learning
title: A directory without its meta.json is a live recording, not debris
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/meetings.ts
    commitSha: 6c5a466fe9b458b4b31dfefb5735e988af1347d7
createdAt: 2026-09-16
lastVerifiedAt: 2026-09-16
---

**Trigger:** you are writing anything that walks `<artifactsDir>/meetings/` and
decides what can go — a retention pass, a disk-space reclaim, a "clean up stale
directories" chore, a migration. You see a directory with audio in it and no
`meta.json`, and it reads as an abandoned half-write.

**It is the opposite.** `meta.json` is written by `POST /meetings/:id/finalize`, at
the *end*. A directory without one is a meeting **being recorded right now**, with
chunks still arriving. Deleting it destroys the recording in progress, and the user
finds out when they stop the meeting and there is nothing there.

**The invariant.** In `meetings.ts` this is enforced by construction rather than by a
rule someone has to remember:

- `listMeetings()` reads `meta.json` and skips any directory that has none.
- `evictOldest()` is built on `listMeetings()`, so an in-progress recording is not
  merely protected — it is **invisible** to eviction. There is no code path where
  eviction can see it and choose correctly or incorrectly.

Keep it that way. Any new sweep should be written on top of `listMeetings()`, not on
`readdir` — the moment something reads the directory listing directly, the protection
is gone and nothing fails to warn you.

There is a test for it: *"never evicts an in-progress recording — it has no meta.json
and is invisible"* seeds 25 finalized meetings plus one live directory and asserts the
live one survives an eviction down to 20.

**The trade-off this buys, stated so it is not discovered as a bug:** recordings that
never finalize are never evicted either. A machine that crashes mid-meeting thirty
times accumulates thirty directories. That is the right default — silent deletion of
recordings is worse than disk use — but if it ever needs sweeping, the sweep must
distinguish *old and abandoned* from *young and live*, by age, and not by the absence
of `meta.json` alone.
