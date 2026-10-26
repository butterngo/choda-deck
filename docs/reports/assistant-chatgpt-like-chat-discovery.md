---
requirement: Companion Assistant should work like ChatGPT — chat UX foundation (streaming, markdown + code + copy, regenerate, edit-and-resend, rename/delete/search chats) and a general "chat about anything" mode alongside the read-only work-data tools
started: 2026-10-26
workspace: Main
status: converged
---

# Discovery — Companion Assistant as a ChatGPT-like chat

Thread: CONV-1792980384690-64 · predecessor discovery: `docs/reports/companion-chat-assistant-discovery.md` (TASK-2731, CONV-1792821501482-50)

## Round 1 — ChatGPT-like Assistant

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation (chat) | Butter: build this as **its own service with its own DB** — not inside the companion adapter | [chat 2026-10-26, mid-round 1] |
| code | One money route `POST /assistant/chats/:id/messages` returns the whole reply as one JSON (`sendJson`), no streaming; tool loop capped at 8, final `tool_choice:'none'` | choda-deck `src/adapters/companion/assistant-chat.ts:3-5,209-248,346` |
| code | Free routes: GET models, GET/POST chats, GET chat detail. **No rename, delete, or edit route** | `assistant-routes.ts:7-10,149-152` |
| code | Store: `assistant_chats` + `assistant_messages` in the shared SQLite, ids `CHAT-n`, `CHAT-n-Mk` from COUNT+1 (delete/edit would collide ids); `searchChats` exists but only as a model tool | `assistant-store.ts:3-6,118-176,179` |
| code | System prompt restricts the assistant to Butter's work data — the thing blocking "chat about anything" | `assistant-chat.ts:31-39` |
| code | Tool surface reads the task service, meetings, vault (10-Projects, 30-Knowledge only), chat store **in-process** | `assistant-read-services.ts:16-34` |
| code | Web renders replies as `whitespace-pre-wrap` text; react-markdown + remark-gfm + highlight.js already in deps and used by `CaptureMarkdown` | companion `packages/web/src/views/AssistantView.tsx:256`, `packages/web/package.json:27,31,33`, `src/components/CaptureMarkdown.tsx:23-24` |
| code | Prod Electron proxy pipes response bodies (`proxyRes.pipe(res)`), so a streamed body survives it; it targets **one** `apiPort` (the adapter) | companion `electron/static-proxy-server.cjs:103-121` |
| ADR | 2026-10-24 amendment: one message = one request, ≤8 tool calls, per-chat budget 200k–400k checked before first call, redaction + 16k cap, chats local-only, no retry, no remote surface, key in `ai-key.txt` | `adr-when-this-project-may-call-a-model` |
| prior discovery | v1 explicitly put **streaming and deleting a chat out of scope** — this requirement reopens both | `companion-chat-assistant-discovery.md:192,211` |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 7 | Butter's own ask + ChatGPT gap table; current prompt blocks general chat (`assistant-chat.ts:31-39`) | which general uses matter most (writing/translate/code/knowledge) — decides prompt + model defaults |
| 2 | Scope & boundary | 5 | features listed, out-list stated; separate service just widened scope | service location, data-access path, history migration — human decisions |
| 3 | Technical contract | 5 | current contract fully read (routes, store, loop, proxy) | the NEW service's contract: process, port, DB, streaming wire format, routing from proxy |
| 4 | Prior art & constraints | 8 | ADR amendment + v1 out-of-scope read | a separate process calling a model is not covered by the amendment ("chats stay on this machine", "routes live in the companion adapter") → amendment needed; check any ADR on companion process layout |
| 5 | Edges & failure | 3 | assumption only | stream aborted mid-reply, regenerate on budget edge, delete while sending (busy set), service down while adapter up |
| 6 | NFR | 2 | — | checklist pass |
| 7 | Acceptance criteria | 1 | — | blocked on #2, #3 |

**TOTAL = MIN = 1** (dimension 7)
Previous round: 1 (round 0) → this round: 1. New evidence? **YES** (10 sources) → may continue.

### Score history
| # | Dimension | R0 | R1 |
|---|---|---|---|
| 1 | Problem & value | 5 | 7 |
| 2 | Scope & boundary | 5 | 5 |
| 3 | Technical contract | 3 | 5 |
| 4 | Prior art | 3 | 8 |
| 5 | Edges & failure | 2 | 3 |
| 6 | NFR | 2 | 2 |
| 7 | Acceptance criteria | 1 | 1 |
| | **MIN** | **1** | **1** |

### Stop: blocked on a human decision
The separate-service call opens four product decisions that no search settles:
1. Where the service lives and who starts it
2. How it reads work data (the tools are in-process today)
3. What happens to the existing CHAT-* history
4. How "general chat" coexists with the work-data tools

### Round 2 will look for exactly this
- Butter's answers to the four decisions (#2)
- Then: the new service's contract — port, launch, proxy routing, streaming format (#3); Azure streaming + `usage` in stream (web, domain knowledge)

## Round 2 — ChatGPT-like Assistant

thread: no new messages (Butter answered in chat via the question form)

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation (chat) | Butter: new package **inside choda-deck**, own process + port; reads work data **through the adapter's HTTP routes** (adapter stays sole owner of the task DB); **migrate** CHAT-* history to the new DB, then remove old tables/routes; **one chat, tools always available** — drop the "only work data" restriction | [chat 2026-10-26, question form after round 1] |
| code | 13 of 15 tools already have an adapter read route: `/search`, `/tasks`, `/tasks/:id`, `/knowledge`, `/knowledge/search`, `/inbox`, `/conversations/:id`, `/meetings`, `/runs`, `/daily-report`, `/vault/notes`+`/vault/projects/`. **`search_vault` has no route** (vault.ts lists/serves only). `search_chats`/`get_chat` move into the service with its DB | `assistant-tools.ts:100-235`, `search.ts:31`, `task-detail.ts:1`, `knowledge.ts:41-55`, `conversation-detail.ts:21`, `meetings.ts:35`, `runs.ts:495`, `daily-report.ts:4`, `vault.ts:152-204` |
| code | Build: each process is its own esbuild bundle (`build:mcp`, `build:companion`) → a `build:assistant` fits the pattern | choda-deck `package.json:44-47` |
| code | Electron spawns the adapter with port 0 and publishes `companion-port.txt`; the web proxy targets that single port | companion `electron/main.cjs:95-124`, `static-proxy-server.cjs:103-121` |
| gotcha | **Two launch paths exist** — Task Scheduler `ChodaCompanionServer` on 7338 and Electron on an ephemeral port; a new process launched by only one of them is silently absent on the other | `registered-to-auto-start-is-not-serving-prove-which-path-owns-the-port` |
| gotcha | the shipped app runs a **vendored** adapter bundle; a new bundle must be vendored too or the app 404s | `a-new-adapter-route-is-invisible-to-the-shipped-companion-…`, `verify-a-vendored-bundle-at-the-packaged-path-…` |
| web | Streaming: `stream: true` + `stream_options.include_usage` → a final chunk with empty `choices` carries `usage`; tool_calls arrive as fragments to reassemble; an interrupted stream loses the usage chunk. Azure support reported working (api-version 2024-02-01+), anecdotal | [OpenAI community](https://community.openai.com/t/usage-stats-now-available-when-using-streaming-with-the-chat-completions-api-or-completions-api/738156), [journeyofthegeek](https://journeyofthegeek.com/2024/09/25/azure-openai-service-streaming-chatcompletions-and-token-consumption-tracking/) |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | Butter's ask + mode choice (one chat, tools always on); current prompt is the blocker (`assistant-chat.ts:31-39`) | — |
| 2 | Scope & boundary | 8 | 4 decisions settled [chat]; out-list unchanged | launch owner + web routing; `search_vault` route |
| 3 | Technical contract | 7 | tool→route map read; streaming wire format known; build pattern known | the service's own route list + launch/port/routing; Azure stream verified live on gpt-5.6-luna |
| 4 | Prior art & constraints | 9 | ADR amendment (needs a new one: separate process, own DB, streaming); two-launch-path + vendoring gotchas | — |
| 5 | Edges & failure | 6 | from code: busy set (`assistant-chat.ts:312-316`), COUNT+1 ids break on delete (`assistant-store.ts:150-153`), stream abort loses usage [web] | adapter-down / service-down behaviour; regenerate & edit semantics against budget |
| 6 | NFR | 6 | defaults apply (internal, loopback, bridge token) | write the 12-row table; confirm streaming first-token target |
| 7 | Acceptance criteria | 3 | — | blocked on #2/#3 launch decision |

**TOTAL = MIN = 3** (dimension 7)
Previous round: 1 → this round: 3. New evidence? **YES** (7 sources) → may continue.

### Score history
| # | Dimension | R0 | R1 | R2 |
|---|---|---|---|---|
| 1 | Problem & value | 5 | 7 | 9 |
| 2 | Scope & boundary | 5 | 5 | 8 |
| 3 | Technical contract | 3 | 5 | 7 |
| 4 | Prior art | 3 | 8 | 9 |
| 5 | Edges & failure | 2 | 3 | 6 |
| 6 | NFR | 2 | 2 | 6 |
| 7 | Acceptance criteria | 1 | 1 | 3 |
| | **MIN** | **1** | **1** | **3** |

### Stop: blocked on a human decision
- Who launches the service (both launch paths must get it) and how the web reaches it
- `search_vault`: new adapter route or service reads vault files directly

### Round 3 will look for exactly this
- Butter's answers → define service routes (#3), edges (#5), NFR table (#6), then draft AC (#7)

## Round 3 — ChatGPT-like Assistant

thread: no new messages (Butter answered in chat via the question form)

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation (chat) | Butter: **the adapter spawns the service as a child and forwards `/assistant/*`** — both launch paths get it, web URLs unchanged; **add `GET /vault/search`** to the adapter so the service never touches vault files | [chat 2026-10-26, question form after round 2] |
| code | Port handshake to copy: child started with port 0, parent parses `[companion] listening on http://127.0.0.1:(\d+)` from stdout | companion `electron/adapter-launcher.cjs:10-14,228,250-294` |
| code | Assistant DB today is a second writable connection on the **shared** DB; tables made by `initSchema` → a migration source, not a destination | `service-factory.ts:100,116`, `core/domain/repositories/schema.ts:54,874` |
| code | Vault search logic to move into the adapter route as is: walks `VAULT_READABLE_DIRS` (10-Projects, 30-Knowledge), 3000-file cap, 160-char snippet | `assistant-read-services.ts:36-38,189-212` |
| code | `/vault/notes/:slug` is sandboxed to 30-Knowledge and `/vault/projects/` to 10-Projects → `read_vault_note(path)` maps onto those two, no new read route | `vault.ts:186-204` |
| code | No SSE precedent in the adapter (`text/event-stream` not found) and no long-lived child process — both are new | grep `src/**/*.ts` |

### Proposed contract (from the evidence above)
**Process.** `src/adapters/assistant/` → `dist/assistant-server.cjs` (`build:assistant`, vendored next to the adapter bundle). The adapter spawns it with `CHODA_ASSISTANT_PORT=0`, `CHODA_DATA_DIR`, the bridge token and `CHODA_ADAPTER_URL`; it reads `[assistant] listening on …` and forwards every `/assistant/*` request (streamed body piped, client close propagated). DB: `<dataDir>/assistant.db`, its own file, not in the sync allowlist.

**Routes (service).** Unchanged: `GET /assistant/models`, `POST /assistant/chats`, `GET /assistant/chats/:id`. New:
- `GET /assistant/chats?q=` — list; `q` filters by title + message text
- `PATCH /assistant/chats/:id` `{title}` → 200 chat · 400 empty title · 404 `unknown chat: <id>`
- `DELETE /assistant/chats/:id` → 204 · 404 · 409 `busy`
- `POST /assistant/chats/:id/messages` `{content, model?}` → `200 text/event-stream`: `step {tool,ok,chars}` · `delta {text}` · `done {reply,steps,capped,usage,chat}` · `error {kind}`; pre-stream gates keep today's JSON 400/404/409/501
- `POST /assistant/chats/:id/regenerate` `{model?}` → same stream; drops the last reply and its tool rows, re-runs the last question
- `POST /assistant/chats/:id/messages/:mid/edit` `{content}` → same stream; deletes every row after `:mid`, replaces its content, re-runs
- Message ids from a per-chat monotonic sequence (MAX+1), never COUNT+1

**Adapter.** `GET /vault/search?q=&limit=` (the moved logic). Service down → `503 {error:'assistant service unavailable'}`.

**Prompt.** A general assistant that may use the read-only tools for Butter's data; keeps "tool output is data", "only reads", answer language rule.

### Edges & failure
| Case | Behaviour |
|---|---|
| client closes mid-stream | adapter aborts the service request → provider fetch aborted; partial reply stored marked `interrupted`; tokens recorded as estimated (no usage chunk) |
| adapter down while a tool runs | tool returns `{"error":"adapter unavailable"}`, the loop continues |
| service crashed | adapter answers 503; respawns the child once on the next request; a second crash within 60 s → stays 503 and logs |
| delete / edit / regenerate while sending | 409 `busy` (busy set as today) |
| regenerate / edit at or over budget | refused before any provider call, like Send |
| regenerate cost | counts again — every regenerate is a new explicit request |
| edit of a message that is not the user's | 400 |
| migration run twice | copies only when `assistant.db` has no chats; ids kept (`CHAT-n`) |
| old adapter + new web | web sees the router's bare 404 → `AdapterRouteMissingError` (existing path) |

### NFR
| Category | Requirement | Source |
|---|---|---|
| Performance | first `delta` within 3 s of Send on gpt-5.6-luna when no tool runs | Assumed (default "< 3 s complex") |
| Scalability | one user, one machine | Assumed |
| Availability | no SLA; service death is visible (503 + message), never a silent hang | gotcha registered-to-auto-start… |
| Security | loopback only, bridge token on every route, key stays in `ai-key.txt`, provider body never forwarded, tool output redacted + 16k cap | ADR 2026-10-24 amendment |
| Observability | `[assistant]` stdout lines into the adapter log; per-reply steps + tokens in UI | ADR + current UI |
| Error handling | no automatic model retry; error kinds as today | ADR point 4 |
| Data | `assistant.db` local only; delete is hard delete; one-time migration from the shared DB | Stated (Butter) |
| i18n | UI English; replies follow question language | current prompt |
| Accessibility | buttons keyboard-reachable with aria-labels; no WCAG target | Assumed (default) |
| Compliance | none beyond redaction | Assumed |
| Maintainability | new ADR amendment; tests per route | ADR "needs its own amendment" |
| Integration | Azure chat completions streaming with `stream_options.include_usage`; adapter HTTP | web sources round 2 |

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | all six decisions answered [chat]; out-list unchanged | — |
| 3 | Technical contract | 8 | routes designed on read code (handshake, store, vault, router) | **streaming on the actual deployment (gpt-5.6-luna) unverified** — usage chunk + tool-call fragments |
| 4 | Prior art & constraints | 9 | carried | — |
| 5 | Edges & failure | 9 | 9 cases, each tied to a code fact (busy set, id scheme, abort, 404 detection) | — |
| 6 | NFR | 9 | 12/12, 5 assumed with default | — |
| 7 | Acceptance criteria | 7 | drafted below, all falsifiable | AC-stream depends on #3 |

**TOTAL = MIN = 7** (dimension 7)
Previous round: 3 → this round: 7. New evidence? **YES** (6 sources).

### Score history
| # | Dimension | R0 | R1 | R2 | R3 |
|---|---|---|---|---|---|
| 1 | Problem & value | 5 | 7 | 9 | 9 |
| 2 | Scope & boundary | 5 | 5 | 8 | 9 |
| 3 | Technical contract | 3 | 5 | 7 | 8 |
| 4 | Prior art | 3 | 8 | 9 | 9 |
| 5 | Edges & failure | 2 | 3 | 6 | 9 |
| 6 | NFR | 2 | 2 | 6 | 9 |
| 7 | Acceptance criteria | 1 | 1 | 3 | 7 |
| | **MIN** | **1** | **1** | **3** | **7** |

### Round 4 will look for exactly this
- One live streaming probe against gpt-5.6-luna (needs Butter's OK — it is a model call): confirm usage chunk + tool_call fragment shape (#3 → unblocks #7)

## Round 4 — ChatGPT-like Assistant

thread: no new messages

### New evidence this round
| Source | What it settled | Citation |
|---|---|---|
| conversation (chat) | Butter approved one live streaming probe | [chat 2026-10-26, question form after round 3] |
| live probe | gpt-5.6-luna, `stream:true` + `stream_options.include_usage`: `text/event-stream`; tool turn = 13 events, **9 tool_call fragments** reassembling to `{"id":"TASK-2736"}`, `finish_reason: tool_calls`; final chunk `choices: []` with `prompt_tokens`/`completion_tokens` (138/30, then 184/50); answer turn streams content deltas, `finish_reason: stop`; stream ends `[DONE]` | scratchpad `stream-probe.mjs`, run 2026-10-26 against `C:/dev/choda-deck/data` provider config |

### Acceptance criteria (parent; `/choda-plan` splits them)
- [ ] AC-1 Given the adapter is started by either launcher, When `GET /assistant/chats` is called on the adapter, Then it answers 200 from the child service, and the process list shows `assistant-server.cjs` whose parent pid is the adapter's — human (process list) + integration
- [ ] AC-2 Given `assistant.db` is absent and the shared DB holds chats, When the service starts, Then `GET /assistant/chats` returns the same ids, titles and `tokensUsed`; a second start leaves the count unchanged — integration
- [ ] AC-3 Given a fixture provider stream, When a message is sent, Then the response is `text/event-stream`, at least one `delta` arrives before `done`, and `done.usage` equals the fixture's usage chunk — unit
- [ ] AC-4 Given a fixture stream splitting one tool call into ≥3 fragments, When the loop runs, Then the tool executes once with the reassembled arguments, one `step` event is emitted, and the 8-step cap with a final `tool_choice:'none'` still holds — unit
- [ ] AC-5 Given a stream in progress, When the client disconnects, Then the provider request's signal is aborted and the stored reply is marked `interrupted` with `tokensEstimated: true` — unit
- [ ] AC-6 `PATCH /assistant/chats/:id {title}` → 200 and the title persists; empty title → 400; unknown id → 404 `unknown chat: <id>` — unit
- [ ] AC-7 `DELETE /assistant/chats/:id` → 204 then `GET` → 404; during a send → 409 `busy`; a message appended after deleting rows gets an id never used before in that chat — unit
- [ ] AC-8 Regenerate replaces the last reply and its tool rows, `tokensUsed` grows; a chat at its budget → 409 with zero provider calls — unit
- [ ] AC-9 Edit of user message `:mid` deletes every later row, replaces its content and re-runs; editing an assistant row → 400 — unit
- [ ] AC-10 With the child killed, the next `/assistant/*` request returns 503 `assistant service unavailable` and the child is respawned once; a second crash within 60 s keeps 503 — unit (adapter forwarder)
- [ ] AC-11 `GET /vault/search?q=` returns hits only under `10-Projects` and `30-Knowledge`; a word present only in `20-Areas` returns `[]` — unit
- [ ] AC-12 After migration, `assistant_chats`/`assistant_messages` and the old in-adapter assistant handlers are gone from the adapter; the registry test that no tool reaches a create/update/delete method still passes — unit + grep
- [ ] AC-13 Web: a reply containing a GFM table renders a `<table>`, a fenced block renders `<pre><code>` with a Copy button that writes exactly the code to the clipboard — vitest
- [ ] AC-14 Web: with a mocked stream, reply text is visible before `done`; Stop aborts the request — vitest
- [ ] AC-15 Web: rename, delete (with confirm in-page, not `window.confirm`) and search in the chat list call the right routes and update the list — vitest
- [ ] AC-16 In the real app, "Dịch sang tiếng Anh: tôi đang bận" gets a translation with 0 steps and no "I can only answer about your work data" refusal — human
- [ ] AC-17 An ADR amendment covering the separate process, own DB, streaming and regenerate/edit as explicit requests is merged — review
- [ ] AC-18 The packaged app vendors `assistant-server.cjs` and the installed app answers `/api/assistant/models` 200 — human

### Scores
| # | Dimension | Score | Why exactly this — evidence | What it needs to reach 9 |
|---|---|---|---|---|
| 1 | Problem & value | 9 | carried | — |
| 2 | Scope & boundary | 9 | carried | — |
| 3 | Technical contract | 10 | routes from read code; streaming shape cross-checked web + live probe | — |
| 4 | Prior art & constraints | 9 | carried | — |
| 5 | Edges & failure | 9 | carried | — |
| 6 | NFR | 9 | carried | — |
| 7 | Acceptance criteria | 9 | 18 criteria, each names its surface and can fail (e.g. AC-11 fails if the 20-Areas guard is dropped; AC-4 fails if fragments are parsed per chunk) | — |

**TOTAL = MIN = 9**. Previous round: 7 → 9. New evidence? **YES** (2 sources).

### Score history
| # | Dimension | R0 | R1 | R2 | R3 | R4 |
|---|---|---|---|---|---|---|
| 1 | Problem & value | 5 | 7 | 9 | 9 | 9 |
| 2 | Scope & boundary | 5 | 5 | 8 | 9 | 9 |
| 3 | Technical contract | 3 | 5 | 7 | 8 | 10 |
| 4 | Prior art | 3 | 8 | 9 | 9 | 9 |
| 5 | Edges & failure | 2 | 3 | 6 | 9 | 9 |
| 6 | NFR | 2 | 2 | 6 | 9 | 9 |
| 7 | Acceptance criteria | 1 | 1 | 3 | 7 | 9 |
| | **MIN** | **1** | **1** | **3** | **7** | **9** |

## ✅ All dimensions ≥ 9 after 4 rounds

| # | Dimension | Score | WHY it earned 9 |
|---|---|---|---|
| 1 | Problem & value | 9 | Butter's ask; the prompt that blocks general chat is at `assistant-chat.ts:31-39` |
| 2 | Scope & boundary | 9 | six product decisions answered by Butter (rounds 1-3); out: memory, projects, files, web search, writes |
| 3 | Technical contract | 10 | current routes/store/proxy read; streaming verified live on gpt-5.6-luna and matches the published shape |
| 4 | Prior art | 9 | ADR 2026-10-24 amendment needs a new amendment (AC-17); launch-path and vendoring gotchas drive AC-1/AC-18 |
| 5 | Edges & failure | 9 | 9 cases tied to code facts (busy set, COUNT+1 ids, abort, 404 detection) |
| 6 | NFR | 9 | 12/12, 5 assumed with stated defaults |
| 7 | Acceptance criteria | 9 | 18 falsifiable criteria, surface named |

Exemptions: none
Unproven assumptions carried forward:
- first `delta` < 3 s is a default, not measured
- respawn-once-then-503 policy is my proposal, not Butter's words
- Azure api-version behaviour for streaming was probed on the v1-style endpoint only
Rounds: 4 · evidence: 26 citations across code (17), ADR/gotcha (4), web (2), live probe (1), Butter (3 decision sets)
Report: docs/reports/assistant-chatgpt-like-chat-discovery.md
