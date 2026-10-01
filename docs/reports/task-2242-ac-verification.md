---
task: TASK-2242
title: S1 Remote caller identity from the token + converter-only /sync endpoints
parent: TASK-2241
verified: 2026-10-01
session: SESSION-1790840716914-11
pr: https://github.com/butterngo/choda-deck/pull/319
merge_commit: 52a266f
result: 8/8 AC ticked
---

# TASK-2242 — AC verification

## Done (8/8)

| AC | Verdict | Evidence | Would it fail on the old code? |
|---|---|---|---|
| AC-1 live token carries preferred_username + realm_access.roles | ✅ | Live ROPC token from realm `demo` (client `claude-connector`), payload decoded locally; token never printed. See "Claim names" below. | n/a — environment fact; the AC's stop condition did not trigger |
| AC-2 member identity reaches the handler | ✅ | `http-transport-caller.test.ts` "AC-2": `tools/call whoami` returns `{member:'an',isConverter:false}` | yes — no caller context existed |
| AC-3 converter role reaches the handler | ✅ | same file "AC-3": `{member:'butter',isConverter:true}` | yes |
| AC-4 member → 403 on /sync/since | ✅ | same file "AC-4": 403, empty body, source spy 0 calls | yes — old gate returned 200 for any valid token |
| AC-5 member → 403 on /sync/apply, Postgres unchanged | ✅ | `sync-apply-member-forbidden.pg.test.ts` ✓ (2 tests, 3281 ms) in CI run 36832796019, ubuntu job 110273032602 | yes; the discriminator test shows the same push as converter adds a row |
| AC-6 existing sync tests unchanged for the converter | ✅ | `sync-apply.pg.test.ts` (7), `sync-e2e.pg.test.ts` (1), `http-transport.test.ts` (18) ✓ unmodified in the same ubuntu job; OAuth converter path 200 in `http-transport-caller.test.ts` "AC-6" | — |
| AC-7 static bearer unchanged | ✅ | `http-transport-caller.test.ts` "AC-7" 200; unmodified `http-transport.test.ts` ✓ | — |
| AC-8 report tracked on main | ✅ | `git ls-tree -r --name-only origin/main` lists `docs/reports/team-task-visibility-discovery.md` after merge 52a266f | — |

### Claim names (AC-1 Test Plan note)

The task body locked at IN-PROGRESS, so the AC-1 note lives here.

Payload keys of a live realm-`demo` access token: `acr, allowed-origins, aud, azp, email, email_verified, exp, family_name, given_name, iat, iss, jti, name, preferred_username, realm_access, resource_access, scope, sid, sub, typ`. `realm_access` has the key `roles`.

## Not done

None.

## Needs a human

None for this task's AC. One operational precondition was found (below).

## Findings

1. **Deploy precondition.** The demo realm user that Butter's laptop syncs with currently holds only `offline_access, default-roles-demo, uma_authorization`, so it is **not** a converter. Once this change is deployed to mcp.choda.dev, that laptop's `/sync/*` calls would get 403. Before the next remote release, create the realm role `choda-converter` and assign it to that user. Merging was safe: `publish.yml` deploys only on `v*` tags. Tracked as a follow-up task.
2. **Local pg tests self-skip.** Docker runs only inside WSL on this machine, so `postgres-harness.ts` resolves `dockerAvailable=false` and every `*.pg.test.ts` shows `↓ skipped` locally. AC-5 and AC-6 were therefore proven only from the ubuntu CI log, where those files show `✓` with real durations.
3. **Local full-suite flake.** `mermaid-check.test.ts` (hook timeout) and `workspace-diagram.test.ts` (15 s test timeout) failed under full-suite load and passed alone (29/29, 2.6 s). Neither imports a changed file. Both CI jobs were green.
4. **GitHub account.** The active `gh` account is `vungo-ichiba`, which has no push rights to butterngo/choda-deck. Push, PR and merge used the `butterngo` token per command; the active account was left unchanged.

## Steps

1. Branch `feat/task-2242-caller-identity` from `main` (equal to origin/main).
2. Implemented `src/adapters/mcp/caller-identity.ts` and changed the gate in `http-transport.ts`.
3. Gates: typecheck ✅ · test ✅ (flake above) · lint ✅ (0 errors, 1 pre-existing warning) · build ✅.
4. Commit 390dc91 → PR #319 → CI green on all 3 jobs → squash-merged → merge proof `git merge-base --is-ancestor 52a266f origin/main` exit 0.
