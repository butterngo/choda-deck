---
requirement: Pilot the thread-based agent orchestrator (INBOX-R-005) — runs end to end, security guaranteed
started: 2026-11-16
workspace: main
status: in-progress
---

# Discovery — Pilot the thread-based agent orchestrator (INBOX-R-005)

Discovery thread: CONV-1794801463124-1

## Round 1 — agent orchestrator pilot

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread opened, no human posts yet | [conversation CONV-1794801463124-1] |
| inbox | the design, decisions and 6-step order | INBOX-R-005 (created 2026-11-15T02:57Z) |
| manifest | the live remote runs **SQLite** (StatefulSet, replicas=1, "if we ever swap SQLite -> Postgres"); image `git-3f1de61`, rolled 2026-10-02 | micro_k8s `manifests/phase4/03-choda-deck.yaml:7-10,58` |
| ADR | ADR-030 plans Postgres remote; the narrow PG facade exists but is not what runs | ADR-030-dual-backend-sync, feature-postgres-remote-backend |
| ADR | ADR-010 makes conversations SQLite-only; R-005 replaces that domain | ADR-010-conversation-protocol |
| ADR search | no prior ADR on agent orchestration / message bus / long-poll (noConfidentMatch) | knowledge_search 2026-11-16 |
| live remote | remote `project_list` (sync user, fresh call) has no `ba-nghiep` / `algorithms`, yet `task_context TASK-3298` returns it with `projectId: ba-nghiep` | MCP HTTP calls, 2026-11-16 ~04:05Z |
| local DB | `projects` rows `ba-nghiep`, `algorithms` have `sync_updated_at = null` (never stamped); `choda-deck` is stamped; `pending_ops` empty | data/database/choda-deck.db, read 2026-11-16 |
| code | the write-through stamps + pushes `ensureProject`, so an unstamped project was created by a process **not** in sync mode | src/core/sync/sync-write-through.ts:47,124-133 |
| config | Claude Desktop registers `choda-tasks` with no `CHODA_BACKEND` on the deprecated `dist/mcp-server.cjs`; Claude Code registers it with `CHODA_BACKEND=sync` | %APPDATA%/Claude/claude_desktop_config.json, ~/.claude.json |
| code | remote tools are project-scoped by `project_members` (remote-only, never synced) | src/adapters/mcp/remote-scope.ts:1-35, src/core/sync/project-members-remote-only.test.ts |
| live | `offline_access` changes the Keycloak refresh token from `Refresh` (1799 s) to `Offline` (0 = offline-session window) — relevant to the agent/client token NFR | token grant probe 2026-11-16 |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 6 | R-005 states the goal (drive local agents from the phone, work in parallel) | Butter: what concrete pain today, what "pilot runs" means (which flow, how many agents) |
| 2 | Scope & boundary | 4 | R-005 lists 6 steps; nothing says which are the pilot and what is out | Butter: pilot = steps 1-4? ntfy (5) and skill (6) in or out? |
| 3 | Technical contract | 3 | remote store is SQLite, but R-005's push path is Postgres `LISTEN/NOTIFY` — the contract has no backend yet | decision D1 (backend), then read the HTTP transport (stateless) for long-poll |
| 4 | Prior art | 7 | ADR-010/026/030/034 found; no orchestration ADR; R-005 overturns ADR-010 and assumes ADR-030 shipped | record that R-005 supersedes ADR-010 for agent traffic; settle D1 |
| 5 | Edges & failure | 3 | R-005 names heartbeat, claim expiry, permission prompt; nothing traced | after D1: trace stateless transport + Cloudflare/ingress timeouts |
| 6 | NFR | 3 | security list in R-005 is rich but unsourced; VM is up only 08:00-22:00 | the 12-category checklist against D1 |
| 7 | Acceptance criteria | 1 | none written | blocked on #3 and #5 |

**Step 1 (sync bug) is already understood**: root cause = projects created from Claude Desktop, which runs the deprecated bundle without `CHODA_BACKEND=sync`, are never stamped or pushed. That piece can become its own task now.

**TOTAL = MIN = 1** (dimension 7)
Previous round: 1 → this round: 1. New evidence? **YES** (12 sources) → may continue.

### Score history
| # | Dimension | R0 | R1 |
|---|---|---|---|
| 1 | Problem & value | 5 | 6 |
| 2 | Scope & boundary | 3 | 4 |
| 3 | Technical contract | 2 | 3 |
| 4 | Prior art | 2 | 7 |
| 5 | Edges & failure | 3 | 3 |
| 6 | NFR | 2 | 3 |
| 7 | Acceptance criteria | 1 | 1 |
| | **MIN** | **1** | **1** |

### Stop — blocked on human decisions (§5)
Dimensions 2 and 3 need calls, not searches:
- **D1 backend:** R-005 assumes remote Postgres (`LISTEN/NOTIFY`), the live remote is SQLite on one pod. Options: (a) move the remote to Postgres first (ADR-030 path; a migration of the live data), (b) pilot on SQLite with an in-process notifier — workable only because the pod is `replicas=1`.
- **D2 pilot scope:** which of the 6 steps make the pilot, and is the bar "2 terminals on one group take a command from the phone and post a result back"?

### Round 2 will look for exactly this
- Butter's answers to D1 and D2 in the thread (#2, #3)
- Then: the stateless Streamable HTTP transport and the Cloudflare tunnel idle timeout for a held-open request (#3, #5)

## Round 2 — agent orchestrator pilot

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread: no new human posts (Butter answered in chat; recorded in the thread) | [conversation CONV-1794801463124-1] |
| chat | **D1 = pilot on SQLite with an in-process notifier; D2 = pilot is steps 1-4, bar = 2 terminals in one group take a `command` from the phone (Claude app) and post a `result` back; steps 5 (ntfy) and 6 (skill) out** | Butter, chat 2026-11-16 ("có") |
| code | `/mcp` builds a fresh server + **stateless** `StreamableHTTPServerTransport` with `enableJsonResponse: true` per request — a held `wait_for_message` sends no bytes until it returns | src/adapters/mcp/http-transport.ts:313-333 |
| domain | Cloudflare (non-Enterprise) cuts a proxied request with 524 when the origin sends nothing for 100 s; Tunnel traffic is proxied | Cloudflare docs, "Error 524" / proxy read timeout |
| code | identity is server-derived per request from the JWT (`preferred_username` or `sub`, realm role `choda-converter`) and carried in AsyncLocalStorage — `from` can be server-assigned without new plumbing | src/adapters/mcp/caller-identity.ts:14-31,42-50 |
| code | audience check accepts `aud` or `azp` == `MCP_OIDC_AUDIENCE` (`claude-connector`) — a token minted for a separate agent client is rejected unless Keycloak maps that audience | src/adapters/mcp/oauth/jwt-verifier.ts:133-139 |
| code | the static bearer is a full-access converter identity — must never reach an agent terminal | src/adapters/mcp/caller-identity.ts:19-25 |
| infra | VM runs 08:00-22:00 ICT only (21-vm-schedule.ps1) — an agent loop meets a dead remote every night | micro_k8s scripts/21-vm-schedule.ps1 |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 6 | carried — no new evidence on the pain | Butter: one real case where waiting at the laptop cost him |
| 2 | Scope & boundary | 8 | D2 in chat: steps 1-4 in, 5-6 out, explicit bar | are `discussion` threads in the pilot or only `task` threads? |
| 3 | Technical contract | 6 | transport, identity and audience paths read; Cloudflare 100 s cap known | message schema + 3 tool signatures written; agent-client audience decided (D4) |
| 4 | Prior art | 8 | D1 settled against ADR-030/ADR-010 | an ADR recording "agent traffic leaves the conversation domain; SQLite + in-process notifier for the pilot" |
| 5 | Edges & failure | 6 | 100 s cut, nightly VM stop, full-access static bearer, idle-loop token cost named | spike result (step 2): real timeout limits of Claude Code tool calls + Cloudflare |
| 6 | NFR | 5 | security + availability window sourced; cost (idle turns) named | the 12-category pass after D4 |
| 7 | Acceptance criteria | 1 | carried — still none written | blocked on #3 (schema) and #5 (spike) |

**TOTAL = MIN = 1** (dimension 7)
Previous round: 1 → this round: 1. New evidence? **YES** (7 sources) → may continue.

### Score history
| # | Dimension | R0 | R1 | R2 |
|---|---|---|---|---|
| 1 | Problem & value | 5 | 6 | 6 |
| 2 | Scope & boundary | 3 | 4 | 8 |
| 3 | Technical contract | 2 | 3 | 6 |
| 4 | Prior art | 2 | 7 | 8 |
| 5 | Edges & failure | 3 | 3 | 6 |
| 6 | NFR | 2 | 3 | 5 |
| 7 | Acceptance criteria | 1 | 1 | 1 |
| | **MIN** | **1** | **1** | **1** |

### Stop — blocked on a human decision (§5)
- **D4 agent identity:** how does a terminal authenticate? Recommendation: one Keycloak **confidential client per agent** (`client_credentials`), realm role `choda-agent`, an audience mapper adding `claude-connector`; secret in Windows Credential Manager. `from` = that client, so one agent cannot post as another. Tradeoff: one Keycloak client to create per agent.
- The idle-loop cost question (hold ≤ 90 s in JSON mode vs SSE keep-alive for minutes) is **not** a decision — it is exactly what step 2 (the spike) measures, and becomes its acceptance criterion.

### Round 3 will look for exactly this
- Butter's answer to D4 (#3, #6)
- Write the message schema + `post` / `read_since` / `wait_for_message` signatures against the existing repository layer (#3), then the first falsifiable AC (#7)

## Round 3 — agent orchestrator pilot

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread: no new human posts | [conversation CONV-1794801463124-1] |
| chat | **D4 = one Keycloak confidential client per agent (`client_credentials`), realm role `choda-agent`, audience mapper to `claude-connector`, secret in Windows Credential Manager** | Butter, chat 2026-11-16 ("okay") |
| code | widening the remote surface = 3 coordinated edits: `REMOTE_TOOL_ALLOWLIST`, `RemoteOperations`, the backend; boot refuses an allowlisted tool with no `REMOTE_TOOL_SCOPING` entry | src/adapters/mcp/server-bootstrap.ts:70-83, src/core/domain/remote-operations.interface.ts:37-67, src/adapters/mcp/remote-scope.ts:24-48 |
| code | `conversation_messages` has no type, no addressee, no server-assigned sender and is not append-only by constraint — the new log cannot reuse it | src/core/domain/repositories/schema.ts:642-650 |
| code | remote-only tables are kept out of sync by `SYNCABLE_TABLES` and pinned by a test — the pattern the new tables follow (local stores no agent traffic, per R-005) | src/core/sync/project-members-remote-only.test.ts:1-25 |
| code | membership is administered inside the pod by a CLI against the remote SQLite (`member add`) — group setup follows the same path, so the pilot needs `kubectl exec` or SSH to the VM | src/adapters/cli/member-command.ts:1-14 |
| checklist | the 12 NFR categories + Butter's defaults | ~/.claude/skills/requirement-analysis/references/nfr-checklist.md |

### Contract (draft)
Remote-only SQLite tables (not in `SYNCABLE_TABLES`):
- `agent_groups(id, project_id → projects, name, created_at)`; `agent_group_members(group_id, principal, kind 'human'|'agent', label e.g. 'agent:A', PK(group_id, principal))`
- `agent_threads(id, group_id, kind 'task' only in the pilot, task_id NULL, title, status 'open'|'closed', claimed_by NULL, claim_expires_at NULL, created_at)`
- `agent_messages(seq INTEGER PRIMARY KEY, id TEXT UNIQUE (client UUIDv7), thread_id, from_principal (server-set), to_addr 'agent:<X>'|'all'|'human', type CHECK IN (command, ask, claim, status, result, decision, close, heartbeat, stop), body ≤ 8 KB, expires_at NULL, created_at)` — `BEFORE UPDATE` / `BEFORE DELETE` triggers `RAISE(ABORT)`
- `agent_cursors(principal, group_id, last_seq)`

Tools (remote allowlist + scoping entry + `RemoteOperations`; the Postgres facade throws a named "not in the pilot" error, since the remote runs SQLite):
- `post({ threadId?, groupId, id, to, type, body, expiresInSec? }) → { id, seq, threadId }`: no `from` input; a human `command` with no `threadId` opens a `task` thread; same `id` + same body → same `seq`; same `id` + different body → conflict.
- `read_since({ groupId, afterSeq?, threadId? }) → { messages, nextSeq }`: an agent sees `to = its label | all`; a human sees the whole group.
- `wait_for_message({ groupId, afterSeq, timeoutSec ≤ 85 }) → { messages, nextSeq, timedOut }`: the in-process notifier wakes it; the hold cap stays under Cloudflare's 100 s until the spike proves SSE keep-alive.
- Authz: `command`, `decision`, `stop` only from a human principal (no `choda-agent` role); agents only `ask`, `claim`, `status`, `result`, `heartbeat`, `close`; a caller outside the group gets the unknown-id reply.
- Claim: `type=claim` sets `claimed_by` only when it is null or past `claim_expires_at` (single UPDATE … WHERE); `heartbeat` extends it 5 min.

### NFR (12 categories)
| Category | Requirement | Source |
|---|---|---|
| Performance | a `command` reaches a waiting agent ≤ 2 s; other tools unaffected during a hold (< 1 s) | Assumed (default < 1 s), measured in the spike |
| Scalability | 1 human, ≤ 4 agents, one pod; no scale-out | Stated (D1, replicas=1) |
| Availability | 08:00-22:00 ICT; outside it the kit backs off (60 s → 5 min) and resumes from its cursor | Stated (VM schedule) |
| Security | JWT per caller; per-agent Keycloak client; server-set sender; type gating; append-only log; no static bearer in terminals; no `--dangerously-skip-permissions`; one worktree per agent | Stated (R-005, D4) |
| Observability | existing tool-invocation log + a count of messages per type per day | Assumed |
| Error handling | idempotent ids; expired commands never delivered; dead waiter = client retries with its cursor, nothing lost (the log is the source) | Assumed, from the contract |
| Data | agent traffic lives only on the remote; retention indefinite for the pilot; covered by the existing remote backup | Assumed |
| i18n | none; message bodies are free text | Default |
| Accessibility | n/a, no UI | Default |
| Compliance | none, personal tool | Default |
| Maintainability | pilot code in choda-deck, one ADR; Postgres port deferred | Stated (R-005, D1) |
| Integration | claude.ai connector (human), Claude Code `/loop` (agents), Keycloak, Cloudflare Tunnel | Stated (R-005) |

### Acceptance criteria (draft, by pilot step)
Step 1, sync fix
- [ ] Claude Desktop's `choda-tasks` entry runs `dist/cli.cjs mcp serve` with `CHODA_BACKEND=sync` (config file shows both)
- [ ] After a backfill, `SELECT count(*) FROM projects WHERE sync_updated_at IS NULL` on the laptop DB returns 0, and the remote `project_list` (converter caller) includes `ba-nghiep` and `algorithms`

Step 2, spike
- [ ] Report records, through `mcp.choda.dev`: the longest JSON-mode hold that returns 200 and the status at 100 s; whether an SSE response with progress pings survives 300 s; Claude Code's observed tool-call timeout; latency of a `task_list` call issued during a hold

Step 3, log + tools + authz (unit/integration on SQLite)
- [ ] An agent-role caller posting `type=command` gets a "type not allowed for agent" error and the message count is unchanged
- [ ] A stored row's `from_principal` equals the token identity even when the client sends a `from` field
- [ ] `UPDATE` or `DELETE` on `agent_messages` raises
- [ ] Posting the same `id` twice stores one row; same `id` with a different body returns a conflict error
- [ ] A `command` to `agent:A` is returned to A's waiting `wait_for_message` within 2 s and is absent from B's `read_since`
- [ ] A `command` past `expires_at` is returned to no agent
- [ ] Two concurrent `claim`s on one thread leave exactly one `claimed_by`
- [ ] A caller outside the group gets the same reply as for an unknown group id
- [ ] The 3 tools appear in remote `tools/list`; `agent_*` tables are absent from `SYNCABLE_TABLES`

Step 4, kit + end to end
- [ ] From the Claude app on the phone, Butter posts one `command` to `agent:A` and one to `agent:B` in group G; each terminal posts `claim` → `status` → `result`, and Butter reads both results in the app
- [ ] Neither terminal runs with `--dangerously-skip-permissions`; each works in its own git worktree; neither can read its Keycloak secret file (settings deny)
- [ ] A `stop` from Butter makes both terminals exit their loop within one hold window

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 6 | carried, no new evidence | Butter: one real case where being away from the laptop blocked work |
| 2 | Scope & boundary | 8 | steps 1-4; discussion threads assumed out (contract: `kind='task'` only) | Butter confirms discussion threads are out |
| 3 | Technical contract | 8 | schema + tool signatures drafted against the real repo layer, allowlist rule and remote-only pattern | spike numbers (hold cap), a known gap |
| 4 | Prior art | 8 | carried | ADR written at conversion |
| 5 | Edges & failure | 8 | nightly stop, dead waiter, run-twice, expiry, concurrent claim, outsider, injection by type gating; each has an AC | spike: Cloudflare/Claude Code timeouts |
| 6 | NFR | 9 | 12/12 answered; 5 defaulted/assumed with a source column | — |
| 7 | Acceptance criteria | 8 | 17 criteria, each names its surface and can fail | step-2 AC depends on the spike's thresholds; step 4 needs the deploy path |

**TOTAL = MIN = 6** (dimension 1)
Previous round: 1 → this round: 6. New evidence? **YES** (6 sources) → may continue.

### Score history
| # | Dimension | R0 | R1 | R2 | R3 |
|---|---|---|---|---|---|
| 1 | Problem & value | 5 | 6 | 6 | 6 |
| 2 | Scope & boundary | 3 | 4 | 8 | 8 |
| 3 | Technical contract | 2 | 3 | 6 | 8 |
| 4 | Prior art | 2 | 7 | 8 | 8 |
| 5 | Edges & failure | 3 | 3 | 6 | 8 |
| 6 | NFR | 2 | 3 | 5 | 9 |
| 7 | Acceptance criteria | 1 | 1 | 1 | 8 |
| | **MIN** | **1** | **1** | **1** | **6** |

### Known blockers outside discovery
- Deploying anything to the remote needs SSH (port 22 dropped before the VM) or `kubectl` via the apiserver NSG rule (still on the old IP).

### Round 4 will look for exactly this
- Butter: a real case for #1, and confirm discussion threads are out (#2)

## Round 4 — agent orchestrator pilot

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | thread: no new human posts | [conversation CONV-1794801463124-1] |
| chat | **#2 settled: discussion threads are out of the pilot**; `kind='task'` only | Butter, chat 2026-11-16 ("2 okay") |
| chat | #1: Butter answered "yes" to "name one real case". That confirms the pain exists but names no case, so it settles nothing new | Butter, chat 2026-11-16 ("1 yes") |
| ops | the deploy path works again: the SSH timeout was IP drift (laptop egress 27.68.135.186 → 171.251.234.229, both NSG rules stale); after `10-nsg-update-ip.ps1` + `19-nsg-apiserver-ip.ps1`, image git-e6c4ea1 rolled via `scripts/20-deploy-choda-ssh.sh` and OIDC `kubectl` reached the node | micro_k8s PR #23, choda-deck PR #387, 2026-11-16 |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 6 | carried; "yes" is a confirmation, not a case | one concrete incident, or Butter accepts it as an unproven assumption |
| 2 | Scope & boundary | 9 | steps 1-4, task threads only; ntfy, skill and discussion threads are out (Butter, R2 + R4) | — |
| 3 | Technical contract | 8 | carried | spike numbers (hold cap); discovery cannot produce them |
| 4 | Prior art | 8 | carried | ADR written at conversion |
| 5 | Edges & failure | 8 | carried | spike: Cloudflare / Claude Code timeouts |
| 6 | NFR | 9 | carried | — |
| 7 | Acceptance criteria | 8 | step-4 deploy-path gap closed (ops row); step-2 thresholds still wait on the spike | spike thresholds |

**TOTAL = MIN = 6** (dimension 1)
Previous round: 6 → this round: 6. New evidence? **YES** (scope, deploy path) → may continue.

### Score history
| # | Dimension | R0 | R1 | R2 | R3 | R4 |
|---|---|---|---|---|---|---|
| 1 | Problem & value | 5 | 6 | 6 | 6 | 6 |
| 2 | Scope & boundary | 3 | 4 | 8 | 8 | 9 |
| 3 | Technical contract | 2 | 3 | 6 | 8 | 8 |
| 4 | Prior art | 2 | 7 | 8 | 8 | 8 |
| 5 | Edges & failure | 3 | 3 | 6 | 8 | 8 |
| 6 | NFR | 2 | 3 | 5 | 9 | 9 |
| 7 | Acceptance criteria | 1 | 1 | 1 | 8 | 8 |
| | **MIN** | **1** | **1** | **1** | **6** | **6** |

### Stop — blocked on a human decision (§5)
- Dimensions 3, 5 and 7 now wait only on the step-2 spike. Running the spike is work, not discovery, so more rounds will not raise them.
- Dimension 1 waits only on Butter. With no concrete incident it stays an unproven assumption.
- Recommendation: convert the two fully-specified steps now. Step 1 (sync fix) has 2 AC. Step 2 (spike) is a spike task with 1 AC. Steps 3-4 stay in discovery: the spike's numbers close #3/#5/#7, and only then do they convert.
