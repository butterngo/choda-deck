---
topic: TASK-2241 — team members on choda-remote (handoff for Monday 2026-10-05)
written: 2026-10-03
parent: TASK-2241
thread: CONV-1790827349855-1
---

# Handoff — team members on choda-remote

## Where it stands

**Shipped and deployed.** mcp.choda.dev runs image `git-3f1de61` (StatefulSet `choda-deck`, revision `choda-deck-6c7d6d98bf`). The micro_k8s manifest is rolled to match (micro_k8s PR #20, 05b6ba8).

| Task | What | Status | PR / commit |
|---|---|---|---|
| TASK-2242 | Caller identity from the Keycloak token; `/sync/*` converter-only | DONE | #319 / 52a266f |
| TASK-2243 | `project_members` + `member add/remove/list` CLI (Postgres) | DONE | #320 / d94cf82 |
| TASK-2244 | Every remote tool scoped to the caller's projects | DONE | #321 / 11379f4 |
| TASK-2245 | `created_by` + token-attributed authors + `INBOX-R-NNN` (Postgres) | DONE | #322 / 7ca5936 |
| TASK-2246 | `tasks.assignee` + `task_list` assignee filter | DONE | #323 / fdc6f03 |
| TASK-2247 | `inbox_convert` template guard (also refuses a missing body) | DONE | #324 / 99ec10b |
| TASK-2250 | Realm role `choda-converter` created + assigned to `mcp-user` | DONE | Keycloak (browser) |
| TASK-2253 | SQLite parity: `project_members`, `INBOX-R`, member CLI on SQLite | IMPLEMENTED (6/7) | #325 / 3f1de61 |
| TASK-2248 | ADR + member onboarding + operator runbook + live E2E | TODO | — |
| TASK-2249 | Decide the draft path after the Phase 1 Postgres cutover | TODO (blocks TASK-2036) | — |
| TASK-2252 | Postgres harness can silently skip a `.pg.test.ts` on CI | TODO | — |
| TASK-2255 (micro-k8s) | Move admin access to Tailscale, close the NSG /32 rules | TODO | — |
| TASK-2241 | Parent epic | TODO — stays open until TASK-2248 (human AC-12/13, AC-14) | — |

Verified live on 2026-10-02:
- `/healthz` ok, and `/sync/since` without a token returns 401.
- The converter `mcp-user` gets 200 from `/sync/since`, sees 15 projects and the 10 remote tools, and tasks carry `assignee`.
- Laptop sync is reachable.
- `member list` exits 0 inside the pod.

Not yet verified live:
- A real member (no member account exists yet).
- That a new remote inbox capture gets an `INBOX-R-NNN` id. Only tests prove this; checking it live would write to production.

## Monday — in this order

1. **Butter:** create a Keycloak test user in realm `demo` (e.g. `test-member`, not `butter` / `claude`) and set its password.
2. **Claude:** re-sync NSG (Butter runs the script; IP rotates), then run `member add <user> <project>` inside the pod:
   `kubectl --kubeconfig C:/Users/hngo1_mantu/.kube/oidc.config -n choda-deck exec choda-deck-0 -- node dist/cli.cjs member add <user> <project>`
3. **Butter:** add the connector `https://mcp.choda.dev/mcp` in claude.ai as the test user and ask "list my choda projects". Only the granted project should appear. This closes TASK-2253 AC-7 and starts TASK-2248 AC-5..8.
4. **Claude:** `/session-start TASK-2248`. Write the ADR, `docs/team/member-onboarding.md` and `docs/team/operator-runbook.md`, and commit this handoff file plus `task-2253-ac-verification.md` in that PR. The ADR must record that **the live remote runs SQLite, not Postgres** (ADR-030 assumed Postgres).
5. Then: TASK-2249 (decision), TASK-2252 (needs approval to READY), TASK-2255 (Tailscale).

## Open housekeeping — Butter

- **Rotate the Keycloak client secret.** It was printed into the session transcript on 2026-10-02 because a bare-value secret file slipped past a `key=value` redaction filter.
- Replace the temporary Keycloak admin `kcadmin` with a permanent admin (Keycloak banner warning).
- `micro_k8s` has unrelated uncommitted work (`docs/knowledge/INDEX.md`, `guide.md`, `home-mise-en-place.md`). It was left untouched.

## How things actually work (learned this run)

- **GitHub account:** the active `gh` account is `vungo-ichiba`, which cannot push to `butterngo/*`. Use the butterngo token per command (`gh auth token --user butterngo` via a one-off credential helper / `GH_TOKEN`). Do not switch the active account.
- **Deploying the remote** (`publish.yml` only publishes to npm; it does **not** deploy):
  1. Re-sync NSG: `00-safety-check.ps1; 10-nsg-update-ip.ps1; 19-nsg-apiserver-ip.ps1` in one PowerShell process. The laptop's public IP rotated three times in hours.
  2. Run `wsl.exe -e bash /mnt/c/dev/insfrastrucure/micro_k8s/scripts/20-deploy-choda-ssh.sh git-<sha>` (untracked in micro_k8s — commit it with TASK-2255). The script builds in WSL docker, then does `docker save | ssh butter@4.194.152.157 'sudo microk8s ctr image import -'`, `set image`, `rollout status`, and `/healthz`.
  3. Script `12-build-push.sh` does not work from this laptop as-is. Its registry port-forward needs a kubectl OIDC login inside WSL, which never completed. WSL also cannot reach a Windows-side port-forward (NAT networking).
  4. Update `micro_k8s/manifests/phase4/03-choda-deck.yaml` afterwards.
- **Windows kubectl works** with `C:/Users/hngo1_mantu/.kube/oidc.config` (cached OIDC token) once NSG matches the current IP.
- **Postgres tests self-skip locally** (Docker is only inside WSL). Only tick pg-backed AC from the ubuntu CI job log showing `✓` for that file, never `↓`.
- **Local full-suite flakes:** `mermaid-check.test.ts` / `workspace-diagram.test.ts` time out under load and pass alone; vitest "Worker exited unexpectedly" happens occasionally. Re-run alone to prove it.
