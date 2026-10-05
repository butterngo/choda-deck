---
task: TASK-2253
title: S9 SQLite-backed remote parity — project_members, INBOX-R ids and member CLI on the SQLite backend
parent: TASK-2241
verified: 2026-10-02
session: SESSION-1790907431582-14
pr: https://github.com/butterngo/choda-deck/pull/325
merge_commit: 3f1de61
deployed: mcp.choda.dev, image git-3f1de61, StatefulSet revision choda-deck-6c7d6d98bf
result: 6/7 AC ticked — AC-7 needs a human (Keycloak test user)
---

# TASK-2253 — AC verification

## Why this task exists

On 2026-10-02 the deploy of git-99ec10b revealed that the live mcp.choda.dev runs the **SQLite** backend: `CHODA_BACKEND` is unset and there is no `CHODA_PG_URL` in `choda-deck-0`, and `postgres-0` holds only the `postgres` and `keycloak` databases. TASK-2243 and TASK-2245 had built membership and `INBOX-R` ids for Postgres only. Butter chose SQLite parity over moving the remote to Postgres.

## Done (6/7)

The criteria below were proven by `src/adapters/mcp/__tests__/sqlite-remote-parity.test.ts` and `src/core/sync/project-members-remote-only.test.ts`. They need no Docker and passed locally and in all three CI jobs of run 36955313077.

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 project_members in the SQLite schema, not syncable | ✅ | `project-members-remote-only.test.ts` |
| AC-2 member add idempotent, unknown project refused | ✅ | parity test "AC-2" |
| AC-3 remove / remove again / list | ✅ | parity test "AC-3", with a leak check against another member's row |
| AC-4 scoped HTTP surface on SQLite | ✅ | parity test "AC-4": `project_list` returns P1 only, and `task_context` on a P2 task gives the unknown-id reply |
| AC-5 remote-ids option mints INBOX-R | ✅ | parity test "AC-5" |
| AC-6 HTTP transport path mints INBOX-R | ✅ | parity test "AC-6", through `serviceOptionsForTransport` + `createTaskService` |

## Not done — needs a human

- **AC-7 (live member):** Butter creates a Keycloak test user in realm `demo` and sets a password. Claude then runs `member add <user> <project>` inside `choda-deck-0`. The test user's connector should list only that project. Claude cannot do the account and password part.

## Live checks after the deploy (2026-10-02)

- `https://mcp.choda.dev/healthz` → `{"ok":true}`; `/sync/since` without a token → 401.
- Converter (`mcp-user`, role `choda-converter`): `/sync/since` → 200; `project_list` → 15 projects; `tools/list` → the 10 allowlisted tools; tasks carry an `assignee` field.
- Laptop companion `/sync/health` → `loopAlive`, `reachable`, pull a few seconds old. It was briefly `reachable:false` while the pod restarted (~1 min).
- `kubectl exec choda-deck-0 -- node dist/cli.cjs member list nobody` → exit 0, which confirms the table exists in the pod's SQLite DB.

**Not verified live:** that a new remote capture on mcp.choda.dev actually gets an `INBOX-R-NNN` id. This is proven only by AC-5/AC-6 tests. Checking it live means writing a real inbox item to production, which was not done unasked.

## Findings

1. **Design premise was wrong.** TASK-2241 and ADR-030 describe the remote as Postgres, but the live remote is SQLite. Both are now supported. TASK-2248's ADR should record which backend the remote actually runs.
2. **Deploy path.** The registry port-forward in `micro_k8s/scripts/12-build-push.sh` requires a WSL kubectl OIDC login, and that login never completed. The image was shipped instead with `docker save | ssh … microk8s ctr image import -`, followed by `set image` and `rollout status`. The `micro_k8s` manifest was then rolled to `git-3f1de61` (micro_k8s PR #20, 05b6ba8).
3. **NSG /32 drift.** The laptop's public IP rotated three times in a few hours, so every deploy needed the NSG scripts re-run first. This is now micro-k8s TASK-2255 (move admin access to Tailscale).
