---
task: TASK-2243
title: S2 project_members table on the remote + member add/remove CLI
parent: TASK-2241
verified: 2026-10-01
session: SESSION-1790841518768-23
pr: https://github.com/butterngo/choda-deck/pull/320
merge_commit: d94cf82
result: 8/8 AC ticked
---

# TASK-2243 — AC verification

## Done (8/8)

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 information_schema shape | ✅ | `member-command.pg.test.ts` ✓ (7 tests, 2718 ms) in CI job 110276158059 (ubuntu-latest, real Postgres): columns + PK `[project_id, member]` asserted exactly |
| AC-2 not syncable, schema-parity passes | ✅ | `project-members-remote-only.test.ts` (2) + `sync-columns.test.ts` passed locally; full local suite exit 0 |
| AC-3 first add → exit 0, one row | ✅ | same pg file, test "AC-3" |
| AC-4 second add → exit 0, still one row | ✅ | test "AC-4" — would throw on the PK without ON CONFLICT |
| AC-5 unknown project → non-zero, named, nothing inserted | ✅ | test "AC-5" |
| AC-6 remove → 0; again → 1 "not a member" | ✅ | test "AC-6" |
| AC-7 list stdout exact | ✅ | test "AC-7" — `choda-deck\np2\n`, empty stderr, with another member's row present as a leak check |
| AC-8 repository = CLI | ✅ | test "AC-8" |

## Not done / needs a human

None.

## Findings

1. Locally the pg file self-skips (Docker only inside WSL), so AC-1 and AC-3..8 rest on the ubuntu CI job log alone. The per-job log was fetched via `gh api repos/butterngo/choda-deck/actions/jobs/<id>/logs`, which works while the windows job is still running; `gh run view --log` does not.
2. The full local suite was green this time. The mermaid cold-start timeouts seen in TASK-2242 did not recur.
3. Running the bundled `dist/cli.cjs member` without CHODA_PG_URL exits with "member commands require CHODA_PG_URL", confirming the subcommand is wired into the shipped CLI.

## Steps

Branch `feat/task-2243-project-members` → migration 016 + repository + CLI + 3 test files → typecheck ✅ · test ✅ · lint ✅ (0 errors) · build ✅ → PR #320 → CI green ×3 → squash-merged as d94cf82 → `git merge-base --is-ancestor d94cf82 origin/main` exit 0.
