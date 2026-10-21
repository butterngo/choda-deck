---
requirement: "phải có luôn cái checklist khi deploy lên là cần phải đảm bảo gì vd như chạy migration config a b or c" + "những gì cần tôi lưu ý thì phải hiển thị hết lên ... bấm open lên rồi copy và chạy thôi chứ không cần phải mở folder a b c"
started: 2026-10-21
workspace: Main
status: converged
---

# Discovery — Each run carries a deploy checklist, and everything Butter must run opens and copies from the companion

Goal 4 of 4 (Butter, 2026-10-21). Thread: CONV-1792554417056-259. Mockup (Deploy checklist + Waiting on you): https://claude.ai/artifact/JZKYzy8jaPDW4821EmZD3o

## Round 1

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread opened; Butter's Open/Copy request relayed from goal 1's thread | [conversation CONV-1792554417056-259], [conversation CONV-1792550694921-246 MSG-1792551122174-250] |
| skill | /ichiba-deploy already checks a change: B3 commits/files grouped (code, app.config, helm, migrations, CI, tests), B4 migrations (`**/Migrations/`, no migrate on start-up in Production), B5 every changed config key, B8 one acceptance check, B9 rollback target; A9 env var names the code reads at start-up | ~/.claude/skills/ichiba-deploy/SKILL.md Phase A (A8, A9), Phase B (B3-B9) |
| repo | bpa-engine ships one hand-run script per migration plus a combined one: `docs/deploy/sql/*.sql`, e.g. `bpa10-workhub-all.sql` (107 lines, idempotent, "run BEFORE the deploy", "record who ran it") | C:/dev/test/bpa-engine/docs/deploy/sql/bpa10-workhub-all.sql:1-15 |
| repo | the run's new config keys appear only in code and tests (`Platform:BaseUrl`, `Directory:PlatformWorkspaces`, `ServiceAuth:OutboundKeys:platform`) and in `appsettings*.json` (`ServiceAuth`) | `git show 982baad c192898` in bpa-engine |
| code | the companion can already serve any text file of a workspace: `GET /workspace-docs/<workspaceId>/<rel path>` (traversal-guarded, whole tree since TASK-1787) — Open needs no new read route | choda-deck/src/adapters/companion/workspace-docs.ts:1-27,204 |
| gotcha | companion writes go only through the writable service via `workflow.ts` routes; a tick that must persist is a new route there | docs/knowledge/companion-mutations-only-writable-svc-only-workflow-routes.md |
| memory | sensitive_information/ files are never printed (bare-value secrets slip past redaction) | feedback_never_cat_credential_files (auto-memory) |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter's words; today the SQL, keys and checks are found by opening folders and deploy records | — |
| 2 | Scope & boundary | 6 | change-specific items vs the env procedure /ichiba-deploy owns | D1 |
| 3 | Technical contract | 5 | Open path exists; generation source and tick storage undecided | D1, D2 |
| 4 | Prior art | 8 | ichiba-deploy A/B phases, deploy records, workspace-docs route, mutation-route gotcha | — |
| 5 | Edges & failure | 5 | secret values, file moved after merge, prod vs QC ticks, a key only read in code | D3, D4 |
| 6 | NFR | 5 | security of secrets is the main one | D4 |
| 7 | Acceptance criteria | 2 | none | blocked |

**TOTAL = MIN = 2**. New evidence: YES (7).

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 9 |
| 2 | Scope & boundary | 6 |
| 3 | Technical contract | 5 |
| 4 | Prior art | 8 |
| 5 | Edges & failure | 5 |
| 6 | NFR | 5 |
| 7 | Acceptance criteria | 2 |
| | **MIN** | **2** |

### Stop — blocked on human decisions
D1 where the checklist comes from · D2 where ticks are kept · D3 QC vs prod · D4 secret values.

## Round 2

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | no human messages since round 1 | [conversation CONV-1792554417056-259] |
| user | D1 scanned from the run's diff + a `## Deploy` section the plan writes for what the diff cannot show; the env procedure stays in /ichiba-deploy · D2 ticks in the choda DB per environment, through a companion write route, shared with /ichiba-deploy, visible on every synced machine · D3 one list, ticks per env; Prod warns when the same item is not done on QC · D4 secrets: names and the sensitive file are shown, "Copy value" puts the value on the clipboard without ever displaying or logging it | AskUserQuestion answers, 2026-10-21 |
| code | companion writes follow the workflow.ts pattern (`method === 'POST' && path …` routes over the writable service) | choda-deck/src/adapters/companion/workflow.ts:110-130 |
| code | synced tables carry `sync_updated_at` / `sync_deleted_at` / `sync_origin` (inbox, workspaces); ADR-036 governs the remote sync | src/core/domain/repositories/inbox-repository.ts; workspaces table schema; docs/knowledge/ADR-036-companion-capture-bridge.md |
| repo | bpa-engine keeps several secrets in one file (`sensitive_information/service-auth-keys.txt`, plus `dev-auth-signing-key.txt`, `dev-db-10.29.70.110.txt`), so a secret reference must name the file AND the field | `ls C:/dev/test/bpa-engine/sensitive_information` (names only) |

### Contract settled
- **Checklist file**, written by /choda-autopilot at the end of the run next to the test report: `<goal home cwd>/docs/reports/<goal-id>-deploy-checklist.md`, YAML frontmatter `items: [{ key, phase: before|deploy|after, kind: migration|sql|config|endpoint|manual|rollback|acceptance, title, why, workspaceId, file?: <rel path>, copy?: <literal text>, secret?: { file, field } }]`. `key` is stable (`migration:20261019101204_ApprovalResults`, `config:Platform:BaseUrl`).
- **Scanner** (CLI `choda-deck deploy scan <ws> <sha>...`, deterministic, used by autopilot): from the run's commits —
  - added `**/Migrations/*.cs` (not `*.Designer.cs` / `*ModelSnapshot.cs`) → `migration`, paired with an added `docs/deploy/sql/*.sql` naming that migration id when one exists (`file` = the SQL);
  - added `docs/deploy/sql/*.sql` → `sql` (a combined script first);
  - added keys in `appsettings*.json` and added `Configuration["A:B"]` / `GetSection("A:B")` / `UseSetting("A:B"` reads → `config` (key name, Helm env form `A__B`);
  - added `Map(Get|Post|Put|Patch|Delete)("…")` → `endpoint` (an acceptance-check candidate);
  plus the goal's `## Deploy` items as `manual`, the B9 rollback line as `rollback`, and the plan's acceptance check as `acceptance`.
- **Ticks**: new table `deploy_checks (goal_task_id, env 'qc'|'prod', item_key, done_by, done_at, note, sync_*)`, one row per tick, synced like inbox. Routes in workflow.ts: `GET /runs/:goal/deploy-checks` → `{ qc: {key: tick}, prod: {…} }`; `POST /runs/:goal/deploy-checks { env, itemKey, done, note? }` → 200; unknown goal 404; env not qc/prod 400. /ichiba-deploy writes the same rows through an MCP tool `deploy_check({ goalTaskId, env, itemKey, done, note })` and links its record path in `note`.
- **Open**: `file` items open through the existing `GET /workspace-docs/<ws>/<file>`; Copy copies the full text. `copy` items copy the literal. Missing file (moved after merge) → "file not found at <path>" and Copy disabled.
- **Secret copy**: `POST /secrets/copy { workspaceId, file, field }` (bridge-token, loopback only) reads `<ws cwd>/<file>`, returns `{ value }` to the page, which writes it to the clipboard; the value is never rendered, logged, or kept in state; the file must be under `sensitive_information/` (else 400), the field must exist (else 404 naming the field, not the value).
- **`GET /runs`**: each run gains `deploy: { path, items } | null` from the checklist file.
- **Companion**: the Deploy checklist and Waiting on you tabs of the mockup; Prod shows "not done on QC" beside an item whose QC tick is missing.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | D1-D4; out: running the SQL for Butter, editing Helm values, staging env, secret rotation | — |
| 3 | Technical contract | 9 | file shape, scanner rules, table + routes + MCP tool, secret-copy route; paths read (workflow.ts, workspace-docs, ichiba-deploy B3-B9) | — |
| 4 | Prior art | 9 | ichiba-deploy phases, deploy records, workspace-docs Open, mutation gotcha, ADR-036 sync | — |
| 5 | Edges & failure | 9 | no migrations → no migration items; SQL without its migration id → `sql` item only; key read only in tests → excluded (test paths skipped); file moved → not found; secret field missing → 404 by name; prod before QC → warning, not a block; re-scan → same keys, ticks kept | — |
| 6 | NFR | 9 | security: secret never rendered/logged, loopback + token, path limited to sensitive_information/; data: ticks synced, small; maintainability: one scanner shared by autopilot and ichiba-deploy | — |
| 7 | Acceptance criteria | 9 | drafts: scanner on the TASK-2513 commits yields 4 migration + 1 combined sql + 4 config + 3 endpoint items; tick round-trip per env; 400/404 paths; secret value absent from the rendered DOM | — |

**TOTAL = MIN = 9**. Previous 2 → 9. New evidence: YES (5).

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 9 | 9 |
| 2 | Scope & boundary | 6 | 9 |
| 3 | Technical contract | 5 | 9 |
| 4 | Prior art | 8 | 9 |
| 5 | Edges & failure | 5 | 9 |
| 6 | NFR | 5 | 9 |
| 7 | Acceptance criteria | 2 | 9 |
| | **MIN** | **2** | **9** |

## All dimensions ≥ 9 after 2 rounds

| # | Dimension | WHY it earned 9 |
|---|---|---|
| 3 | Contract | every surface named with its shape; reads reuse workspace-docs, writes follow workflow.ts |
| 5 | Edges | each missing or unusual input has a named outcome, and the TASK-2513 commits are a real fixture for the scanner |
| 6 | NFR | the one sensitive path (secret copy) is bounded by folder, token, loopback and a no-render rule that an AC can check in the DOM |

Exemptions: none
Unproven assumptions: the format of `sensitive_information/service-auth-keys.txt` (not read, by rule) — `field` assumes `name=value` lines; a different shape needs one reader change. The scanner's config rule catches keys read with string literals only; a key built at run time is missed and must go in `## Deploy`.
Rounds: 2 · evidence: 12 citations (skill 1, repo 3, code 3, gotcha 1, memory 1, ADR 1, user 2)
