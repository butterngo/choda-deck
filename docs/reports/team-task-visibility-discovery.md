---
requirement: Invite 2-3 team members to choda remote; tasks assigned locally, read-only team web page
started: 2026-10-01
workspace: choda-deck
status: converged
---

# Discovery — Invite 2-3 team members to choda remote; tasks assigned locally, read-only team web page

Discovery thread: CONV-1790827349855-1

Requirement as stated by Butter (chat, 2026-10-01):
- Team of 2-3 people; each member works on one or more projects.
- Tasks are assigned to a member. Assignment happens **locally** (task_update) and is pushed.
- The remote web page is **read-only** — view only.
- Every write still goes through each member's local choda-deck plus the pull/push sync skills.
- Invite = create a Keycloak user + add them to a project; manual/CLI is acceptable for v1.

## Round 1 — team task visibility

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | Scope from Butter: 2-3 people, member ↔ 1+ projects, web read-only, assign locally, writes via local pull/push | chat 2026-10-01 (thread CONV-1790827349855-1 seeded with it) |
| code | Task ids are minted **locally** from a per-DB counter (`UPDATE … SET last_number = last_number + 1`) | src/core/domain/repositories/counter-repository.ts:9-14 |
| code | The counter only advances past remote ids **on pull** (`advanceCountersFromImport`) | src/core/sync/sync-pull.ts:125, counter-repository.ts:30-31 |
| code | Server-side apply judges a pushed row by Lamport alone — no check that two rows sharing an id are the same entity. Higher Lamport overwrites; lower/equal from a different origin → `conflict` | src/core/sync/sync-apply.ts:93-104 |
| code | Lamport is a per-device monotonic counter, not wall clock | src/core/sync/lamport-clock.ts:1-6 |
| code | `/sync/since` returns every delta since a Lamport cursor — no project or caller filter | src/adapters/mcp/http-transport.ts:142-167 |
| code | `/sync/apply`, `/sync/since`, `/mcp` share one gate; OAuth mode returns `claims !== null` and discards identity (TODO ADR-034) | src/adapters/mcp/http-transport.ts:340, 361-368 |
| code | Laptop sync authenticates with a per-user Keycloak ROPC username/password — so per-member identity is already possible on the wire | src/core/sync/keycloak-token-provider.ts:1-13 |
| code | `Task` has no assignee; the only `assignee` field is on `ConversationAction` | src/core/domain/task-types.ts:71-77, 316 |
| ADR | Sync was designed for **single-user multi-device. Not multi-tenant. Not many writers.** | ADR-030-dual-backend-sync:100 |
| ADR | PowerSync rejected for single-user, with an explicit trigger: "Reconsider if a second human user ever joins." | ADR-030-dual-backend-sync:242 |
| ADR | Original plan minted ULIDs; shipped code uses per-DB counters (`TASK-N`) — the ULID plan was not carried out | ADR-030-dual-backend-sync:266, 271 vs counter-repository.ts:9 |
| ADR | "A second human … just add realm users/roles. The per-tool allowlist scoping seam activates here." | ADR-034-keycloak-backed-http-auth-via-on-origin-proxy:104 |
| ADR | `REMOTE_TOOL_ALLOWLIST` is still the 6 read+capture tools; writes go only via `/sync/apply` | ADR-030-dual-backend-sync:41 |

**ID collision (the round's first target) — confirmed by reading, not yet reproduced.** Member A and member B both pull at counter 900. A creates a task → local `TASK-901`; B creates a different task → local `TASK-901`. A pushes first → applied. B pushes: if B's Lamport is higher, B's row **overwrites A's task** on the canonical store; if not, B gets `conflict` and B's task never reaches the remote. Either way two unrelated tasks share one id and one is lost or hidden. The same counter pattern backs inbox items (`inbox-repository.ts:29`) and conversations.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 7 | Butter's own scope statement (chat) | Who looks at the page and what they do today to learn their tasks — one sentence from Butter |
| 2 | Scope & boundary | 7 | In/out stated by Butter: read-only web, local assign, manual invite | Which entities the page shows (tasks only? inbox? conversations?); whether a member's laptop pulls only their projects; where the web app is hosted |
| 3 | Technical contract | 6 | /sync/since, /sync/apply, auth gate, counter all read (http-transport.ts, sync-apply.ts, counter-repository.ts) | Postgres `tasks` columns (migrations.ts); read API for the web does not exist — define it; how a project filter enters /sync/since |
| 4 | Prior art & constraints | 8 | ADR-030:100, :242, :266; ADR-034:104 | Human decision: this requirement trips ADR-030's own "second human" revisit clause — amend ADR-030 or write a new ADR? |
| 5 | Edges & failure | 5 | ID collision traced through code (above) | Reproduce or test it; member removed from project but keeps local copy; member pulls a project they left; assignee who is not a member |
| 6 | NFR | 2 | — checklist not yet read | Walk references/nfr-checklist.md |
| 7 | Acceptance criteria | 1 | none written | Blocked on 3 and 5 |

**TOTAL = MIN = 1** (dimension 7)
Previous round: — → this round: 1. New evidence? **YES** (14 sources) → may continue.

### Score history
| # | Dimension | R1 |
|---|---|---|
| 1 | Problem & value | 7 |
| 2 | Scope & boundary | 7 |
| 3 | Technical contract | 6 |
| 4 | Prior art | 8 |
| 5 | Edges & failure | 5 |
| 6 | NFR | 2 |
| 7 | Acceptance criteria | 1 |
| | **MIN** | **1** |

### Round 2 will look for exactly this
- Walk the NFR checklist (#6)
- Read Postgres `tasks` schema + how projects/workspaces sync, to define the web read API and a project filter (#3)
- Enumerate id-strategy options for the collision (#5) — likely ends in a human decision

## Round 2 — team task visibility

thread: no new messages (only the round-0 seed and the round-1 post).

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| code | Every laptop pushes with `origin = 'laptop'`: `startSyncLoop` defaults `opts.origin ?? 'laptop'` and the bootstrap call passes no origin | src/core/sync/sync-loop.ts:41, src/adapters/mcp/server-bootstrap.ts:202 |
| code | Consequence for the collision: with a shared origin, an **equal**-Lamport push of a different task under the same id is classed as an idempotent re-delivery and **applied** — a silent overwrite, not even a logged conflict | src/core/sync/sync-apply.ts:93-104 (`canonical.origin === canonical.pushOrigin`) |
| code | The ULID PK swap from ADR-030 was "deliberately NOT here (it rewrites every FK target and is not auto-safe — separate slice)" — no task tracks it (task_list TODO/CANCELLED query "ULID" → []) | src/core/sync/syncable-tables.ts:8-12; task_list 2026-10-01 |
| code | Postgres `tasks`: `id, project_id (FK projects), parent_task_id, title, status, priority, labels JSONB, due_date, pinned, file_path, body, created_at, updated_at` + sync columns; indexed on `(project_id, status)` — no assignee | src/core/domain/repositories/postgres/migrations.ts:77-95 |
| code | Syncable set = projects, workspaces, tasks, inbox_items, conversations, conversation_messages, conversation_actions. Sessions and knowledge are stdio-only and never reach the remote | src/core/sync/syncable-tables.ts:19-27 |
| checklist | 12 NFR categories walked; Butter's defaults applied below | skills/requirement-analysis/references/nfr-checklist.md |

### NFR (dimension 6)
| Category | Requirement | Source |
|---|---|---|
| Performance | Web list < 1s for one project's tasks; 2-3 concurrent users | Default + Stated (team size) |
| Scalability | None needed — 2-3 users, single remote replica is fine | Stated (team size) |
| Availability | No SLA; internal tool, downtime for deploys acceptable | Default |
| Security | Keycloak JWT per member; a member sees only projects they belong to — on the web **and** on /sync/since | Default + Stated ("each member works on 1+ projects") |
| Observability | Log caller `sub` on /sync/apply and web reads; no dashboard | Assumed |
| Error handling | Push of a colliding id must be rejected loudly, never silently applied | Derived from round-1/2 evidence |
| Data | Removing a member from a project: remote stops serving it; their local copy is NOT wiped (documented limitation) | Assumed — **needs Butter** |
| i18n | English UI | Default — **Butter's team may prefer Vietnamese; confirm** |
| Accessibility | Not required for v1 | Default |
| Compliance | None | Assumed (internal team) |
| Maintainability | Butter maintains; same repo as choda-deck | Assumed |
| Integration | Keycloak (id.choda.dev), existing /sync/since + /sync/apply; new read-only HTTP route(s) for the web | Code (http-transport.ts:125-131) |

### Decisions blocking further progress
1. **ID strategy** for multi-writer creates — options:
   - A. **Range lease:** each laptop leases a block of counter values from the remote (e.g. 50 at a time) and mints from it. Keeps `TASK-N`; works offline until the block runs out.
   - B. **Remote mints:** `task_create` asks the remote for the id. Simplest; creating a task needs the network.
   - C. **Member prefix:** `TASK-<member>-N`. No coordination; changes the id format every tool and regex relies on.
   - D. **ULID swap** per ADR-030 §266. Most correct; rewrites every FK target — the slice ADR-030 itself deferred.
   Recommendation: **A**, plus a per-member `origin` (the Keycloak username) so the apply path can tell two writers apart.
2. **ADR handling:** this requirement trips ADR-030:242 ("reconsider if a second human user ever joins"). Amend ADR-030 with a multi-member section, or write a new ADR that supersedes its single-user premise?
3. **Member removed from a project** — accept that their local copy remains (v1), or must it be purged on next pull?
4. **UI language** — English, or Vietnamese for the team?

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 7 | carried — no new evidence | One sentence from Butter: what the team does today to learn their tasks |
| 2 | Scope & boundary | 7 | carried — no new evidence | Page shows tasks only (syncable set allows more); member laptop pulls only their projects |
| 3 | Technical contract | 7 | Postgres tasks columns (migrations.ts:77-95); origin wiring (sync-loop.ts:41) | Web read API shape + where the project filter enters /sync/since — depends on decision 1 |
| 4 | Prior art & constraints | 8 | ULID deferral confirmed (syncable-tables.ts:8-12), no tracking task | Decision 2 |
| 5 | Edges & failure | 7 | Shared-origin silent overwrite (sync-apply.ts:93-104 + sync-loop.ts:41) | Decisions 1 and 3 |
| 6 | NFR | 7 | 12/12 walked; 8 defaulted | Decisions 3 and 4 |
| 7 | Acceptance criteria | 1 | carried — blocked on 3 and 5 | Decisions 1-3 |

**TOTAL = MIN = 1** (dimension 7)
Previous round: 1 → this round: 1. New evidence? **YES** (6 sources) → may continue, but **stopped: blocked on a human decision** (§5).

### Score history
| # | Dimension | R1 | R2 |
|---|---|---|---|
| 1 | Problem & value | 7 | 7 |
| 2 | Scope & boundary | 7 | 7 |
| 3 | Technical contract | 6 | 7 |
| 4 | Prior art | 8 | 8 |
| 5 | Edges & failure | 5 | 7 |
| 6 | NFR | 2 | 7 |
| 7 | Acceptance criteria | 1 | 1 |
| | **MIN** | **1** | **1** |

### Round 3 will look for exactly this
- Take Butter's answers to decisions 1-4 as evidence
- Define the web read API + project filter on /sync/since against the chosen id strategy (#3)
- Draft falsifiable AC (#7)

## Round 3 — team task visibility

thread: 1 new message — Butter's answers to decisions 1-4 (MSG-1790827834519-5).

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | Members push **drafts**, not tasks. The team reviews; **exactly one person** approves and converts a draft into a task, so every task follows the template | [conversation CONV-1790827349855-1, MSG-1790827834519-5] |
| conversation | ADR handling: Claude's call → **new ADR** (premise change, not a patch): "Multi-member remote: drafts in, one converter out", superseding ADR-030's single-user premise only | [conversation …-5, answer 2] |
| conversation | Member removed from a project: simplest → remote stops serving that project to them; local copy is left as-is (documented limitation) | [conversation …-5, answer 3] |
| conversation | Web UI language: English | [conversation …-5, answer 4] |
| ADR | The inbox pipeline already is a draft→review→convert flow: `raw → researching → ready → converted`; `inbox_convert` creates the task, sets `linked_task_id` and closes the linked conversation atomically | ADR-011-inbox-pipeline:80-97 |
| ADR | "Tasks with `status=inbox`" was **rejected** — an un-reviewed idea is not a task. A draft therefore belongs in the inbox, not as a task status | ADR-011-inbox-pipeline:149 |
| code | The task template is `defaultBody`: `## Context / ## Acceptance (- [ ]) / ## Test Plan / ## Related` | src/adapters/mcp/mcp-tools/task-tools.ts:15-33 |
| code | Inbox ids are counter-minted (`INBOX-NNN`) exactly like tasks → drafts from two members collide the same way | src/core/domain/repositories/inbox-repository.ts:33 |
| code | Conversation and message ids are timestamp-based (`CONV-<epochms>-n`, `MSG-<epochms>-n`), so review comments from several members do not share the counter problem | observed: MSG-1790827834519-5, CONV-1790827349855-1 |

**What this does to the id problem.** Only the converter's machine runs `inbox_convert`, so only one device ever mints `TASK-N` — tasks are back to a single writer, the premise ADR-030 was built on. The range-lease option is no longer needed. Two things still are:
- draft (inbox) ids must not collide across members — mint them per member (e.g. `INBOX-<user>-NNN`) or timestamp-based like conversations;
- each member's laptop must push with its own `origin` (Keycloak username), so the apply path stops treating another member's write as a re-delivery (round 2).
Members still *update* converted tasks (status, AC ticks) as they work; that stays LWW per row, which is correct once origins differ.

### Open decision (blocks dimension 7)
- **Where does "approve" happen?** (a) the reviewer runs `inbox_convert` on their own laptop — the web stays read-only; or (b) an Approve button on the web — the web becomes a writer and needs its own write path and the converter role check on the server.

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter: tasks must follow the template, gated by one reviewer; team needs shared visibility [conv …-5] | — |
| 2 | Scope & boundary | 8 | In: drafts, review, single converter, read-only task view. Out: purge on removal, Vietnamese UI | Approve location |
| 3 | Technical contract | 8 | inbox_convert contract (ADR-011:97), template (task-tools.ts:15-33), inbox counter (inbox-repository.ts:33) | Web read API + project filter on /sync/since; depends on approve location |
| 4 | Prior art & constraints | 9 | ADR-011 is the draft flow; ADR-011:149 rules out a task-status draft; new ADR chosen for the ADR-030 premise | — |
| 5 | Edges & failure | 8 | Task minting single-writer; draft id + origin remain (above); removal behaviour decided | Non-converter calling inbox_convert / task_create must be refused — where depends on approve location |
| 6 | NFR | 9 | 12/12; removal + language now Stated [conv …-5] | — |
| 7 | Acceptance criteria | 1 | carried — none written | Approve location |

**TOTAL = MIN = 1** (dimension 7)
Previous round: 1 → this round: 1. New evidence? **YES** (9 sources). **Stopped: blocked on one human decision** (approve location).

### Score history
| # | Dimension | R1 | R2 | R3 |
|---|---|---|---|---|
| 1 | Problem & value | 7 | 7 | 9 |
| 2 | Scope & boundary | 7 | 7 | 8 |
| 3 | Technical contract | 6 | 7 | 8 |
| 4 | Prior art | 8 | 8 | 9 |
| 5 | Edges & failure | 5 | 7 | 8 |
| 6 | NFR | 2 | 7 | 9 |
| 7 | Acceptance criteria | 1 | 1 | 1 |
| | **MIN** | **1** | **1** | **1** |

### Round 4 will look for exactly this
- Take the approve-location answer as evidence
- Define the web read API + per-member project filter (#3)
- Write the AC set (#7)

## Round 4 — team task visibility

thread: 1 new message — Butter: approve happens locally, web stays read-only (MSG-1790827971013-7).

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation | Approve = the reviewer runs `inbox_convert` on their own laptop; the web is read-only | [conversation CONV-1790827349855-1, MSG-1790827971013-7] |
| code | Pull filter point: `fetchSinceFromPg` selects `SELECT * FROM ${table} WHERE sync_updated_at > $1 …` per syncable table — the one place a per-member project filter goes | src/core/sync/sync-source.ts:34-38 |
| code | Apply enforcement point: `applyDeltaToPg` reads the canonical row per pushed row, then `planApplyRow` → upsert; a "no canonical row + table = tasks" check and a project check slot in here, inside the same transaction | src/core/sync/sync-sink.ts:30-80 |
| code | `upsertPgRow` uses the live column list (`pgColumns`), so a new `tasks.assignee` column flows through push/pull with no sync code change | src/core/sync/sync-sink.ts:45, 77 |
| code | The push origin comes from the **request body** (`Body = { origin, deltas }`) — client-asserted, so it must be replaced by the token's identity, not trusted | src/adapters/mcp/http-transport.ts:173 |
| code | Counter advance skips any id whose suffix is not all digits ("Explicit non-numeric ids … are skipped"), so `INBOX-<member>-NNN` drafts never disturb the converter's `INBOX-NNN`/`TASK-N` counters | src/core/domain/repositories/counter-repository.ts:37, 51 |
| code | The startup counter seed only reads `INBOX-[0-9]*` ids, so per-member draft ids are ignored there too | src/core/domain/repositories/schema.ts:280 |

### Design that the AC are written against
- **Identity:** the OAuth gate returns the verified claims instead of `claims !== null`. `member = preferred_username`; `converter = realm role choda-converter` (Butter). Push origin := `member`; the body's `origin` is ignored.
- **Membership:** remote-only table `project_members(project_id, member, created_at)`, not synced; managed by CLI. A converter sees and writes every project.
- **Apply rules (server):** a `tasks` row with no canonical row from a non-converter → new verdict `rejected`; any row whose project is not one of the caller's → `rejected`. Updates to existing tasks in the caller's projects stay LWW.
- **Pull rule (server):** `/sync/since` returns only the caller's projects; messages/actions via their conversation's project; inbox rows with `project_id IS NULL` only to converters.
- **Drafts:** `inbox_add` on a member laptop mints `INBOX-<member>-NNN`. Review happens in the draft's linked conversation (timestamp ids, already collision-safe).
- **Template guard:** `inbox_convert` refuses a body missing any of `## Context / ## Acceptance / ## Test Plan / ## Related` or with no `- [ ]` under `## Acceptance` — backs Butter's "every task follows the template".
- **Web:** read-only page served by the remote pod under `/team`, Keycloak login (public client + PKCE), English UI. Reads `GET /team/tasks`.
- **ADR:** new ADR "Multi-member remote: drafts in, one converter out", superseding ADR-030's single-user premise (ADR-030 gets a pointer; its sync mechanics stand).

### Acceptance criteria (draft)
- [ ] AC-1 `tasks` has a nullable `assignee TEXT` on SQLite and Postgres; the schema-parity test passes; `task_update({assignee:'an'})` on the converter laptop appears with `assignee='an'` on Postgres after one drain. *(machine)*
- [ ] AC-2 Under OAuth, `POST /sync/apply` stamps `sync_origin` with the caller's `preferred_username`; a push whose body says `origin:'laptop'` with user `an`'s token lands with `sync_origin='an'`. *(machine)*
- [ ] AC-3 Two different members pushing the same row id at an equal Lamport: the second push gets verdict `conflict` and the canonical row is unchanged (today it is applied). *(machine — pg test)*
- [ ] AC-4 A `tasks` row with no canonical row, pushed with a token lacking `choda-converter`, gets verdict `rejected` and is absent from Postgres; the identical push with the role is `applied`. *(machine)*
- [ ] AC-5 A member pushing any row whose project is not in their `project_members` gets `rejected` for that row; rows in their own projects in the same push still apply. *(machine)*
- [ ] AC-6 `GET /sync/since?since=0` with a member token returns zero rows from projects they are not a member of, in every syncable table (incl. `conversation_messages` via conversation, and no `project_id IS NULL` inbox rows); a converter token returns all. *(machine)*
- [ ] AC-7 `inbox_add` on a laptop configured as member `an` mints `INBOX-an-NNN`; the converter laptop keeps minting `INBOX-NNN`; pulling `INBOX-an-001` does not move the converter's inbox counter. *(machine)*
- [ ] AC-8 `choda-deck member add <member> <projectId>` / `member remove` change `project_members` on the remote; after `remove`, the member's next pull returns no rows for that project. Their local copy is not deleted (documented). *(machine)*
- [ ] AC-9 `GET /team/tasks?projectId=X` → 200 with `[{id,title,status,priority,assignee,updatedAt}]` for a member of X; 403 for a non-member; 401 without a token; `&assignee=an` returns only `an`'s tasks. *(machine)*
- [ ] AC-10 `inbox_convert` refuses (error, no task created, draft stays unconverted) a body missing any of the four template headings or with zero `- [ ]` under `## Acceptance`; a conforming body converts. *(machine)*
- [ ] AC-11 The `/team` page, logged in as a member, lists only that member's projects, filters by assignee, is English-only, and issues no POST/PUT/PATCH/DELETE during a full click-through (network log). *(human — screenshot + HAR)*
- [ ] AC-12 End-to-end: member `an` adds a draft → the reviewer converts it locally with `assignee:'an'` → within one sync cycle it shows on `/team` under `an`. *(human)*
- [ ] AC-13 The new ADR exists in the knowledge layer and ADR-030 carries a "premise superseded by" pointer to it. *(machine — knowledge_get)*

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried — [conv …-5] | — |
| 2 | Scope & boundary | 9 | Approve local, web read-only [conv …-7]; out: web writes, purge on removal, Vietnamese UI | — |
| 3 | Technical contract | 9 | Filter point sync-source.ts:34-38; enforcement point sync-sink.ts:30-80; column flow sync-sink.ts:45,77; origin source http-transport.ts:173 | — |
| 4 | Prior art & constraints | 9 | carried — ADR-011:80-97, :149; ADR-030:100, :242; ADR-034:104 | — |
| 5 | Edges & failure | 9 | Spoofed body origin (http-transport.ts:173), equal-Lamport cross-member (sync-apply.ts:93-104), non-converter create, foreign-project push/pull, null-project inbox, removal, draft id vs counter (counter-repository.ts:37,51) — each has an AC | — |
| 6 | NFR | 9 | carried — 12/12 | — |
| 7 | Acceptance criteria | 9 | 13 criteria, each names its surface and has a distinguishable fail (AC-3 fails on today's code; AC-4/5 fail without the new verdict) | — |

**TOTAL = MIN = 9**
Previous round: 1 → this round: 9. New evidence? **YES** (7 sources). **Converged.**

### Score history
| # | Dimension | R1 | R2 | R3 | R4 |
|---|---|---|---|---|---|
| 1 | Problem & value | 7 | 7 | 9 | 9 |
| 2 | Scope & boundary | 7 | 7 | 8 | 9 |
| 3 | Technical contract | 6 | 7 | 8 | 9 |
| 4 | Prior art | 8 | 8 | 9 | 9 |
| 5 | Edges & failure | 5 | 7 | 8 | 9 |
| 6 | NFR | 2 | 7 | 9 | 9 |
| 7 | Acceptance criteria | 1 | 1 | 1 | 9 |
| | **MIN** | **1** | **1** | **1** | **9** |

## ✅ All dimensions ≥ 9 after 4 rounds

| # | Dimension | Score | WHY it earned 9 — evidence, not confidence |
|---|---|---|---|
| 1 | Problem & value | 9 | Butter: tasks must follow the template and pass one reviewer; the team needs to see assigned work [conv MSG-…-5] |
| 2 | Scope & boundary | 9 | In/out stated by Butter across MSG-…-5 and MSG-…-7; out-of-scope list written above |
| 3 | Technical contract | 9 | Every change lands at a read code site: sync-source.ts:34-38, sync-sink.ts:30-80, http-transport.ts:173/361-368, inbox-repository.ts:33, migrations.ts:77-95 |
| 4 | Prior art | 9 | ADR-011 is the draft flow (and rejects task-status drafts, :149); ADR-030:242 names this exact trigger; ADR-034:104 names the role seam |
| 5 | Edges & failure | 9 | Seven failure paths traced to code, each mapped to an AC |
| 6 | NFR | 9 | 12/12 categories; language + removal stated by Butter, rest defaulted per checklist |
| 7 | Acceptance criteria | 9 | 13 checkbox criteria; AC-3 fails on current code (sync-apply.ts:93-104 + shared origin), so pass and fail differ |

Exemptions: none
Unproven assumptions carried forward:
- The id collision and the silent equal-Lamport overwrite were traced by reading, **not reproduced** — AC-3 is the reproduction.
- Keycloak tokens from realm `demo` carry `preferred_username` and `realm_access.roles` — not yet checked on a live token.
- Web hosting under `/team` on the remote pod and a new public Keycloak client are Claude's defaults, not Butter's stated choice.
- The template guard on `inbox_convert` (AC-10) is Claude's addition backing Butter's goal; Butter has not asked for an automated check.
- Members' drafts and review comments reach the remote only if their laptop runs `CHODA_BACKEND=sync` — member onboarding is not yet documented.

Rounds: 4 · evidence: 36 citations across code (25), ADR (7), conversation (4)
Report: C:/dev/choda-deck/docs/reports/team-task-visibility-discovery.md
