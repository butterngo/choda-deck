---
type: decision
title: "ADR: When this project may call a model — one explicit request, one subject, no unattended sweep"
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/ac-review.ts
    commitSha: fffdd1767e9263074e69c6ccb04b879bb7edb6ae
  - path: src/adapters/companion/azure-review.ts
    commitSha: fffdd1767e9263074e69c6ccb04b879bb7edb6ae
  - path: src/adapters/mcp/server-bootstrap.ts
    commitSha: fffdd1767e9263074e69c6ccb04b879bb7edb6ae
createdAt: 2026-09-08
lastVerifiedAt: 2026-10-10
---

- **Status:** Accepted
- **Date:** 2026-09-08
- **Context:** discovery for AI agents in the MCP server (`docs/reports/ai-agents-in-companion-discovery.md`), round 4

## Context

Until now this project called a model in exactly one place, from exactly one
trigger: a human clicking Review in the companion's web UI, which POSTs to
`/tasks/ac-review`. The rule governing that call was written as a code comment
(`src/adapters/companion/ac-review.ts:14`) — its own route, reached only on an
explicit request, `/tasks` stays free.

A comment was enough while a human click was the only way to spend money. It
stops being enough the moment the same grader becomes an MCP tool: `/choda-plan`
and `/choda-burn-backlog` can call a tool thirty times in a loop with nobody
watching, and a person cannot mis-click thirty times.

There is a second reason to write this down rather than leave it implicit. The
one cost fact already recorded on this machine is from another project — a
130 USD/month AI ceiling whose entire lesson is that *a budget alert does not
stop spending*
(`juvenis-maxime/docs/knowledge/cost-ceiling-enforced-by-policy-deny-not-budget-alert.md`).
Nothing in choda-deck enforces a ceiling in code, and this ADR does not add one.
What it can do is bound how many calls the codebase is capable of initiating.

## Decision

**1. A model call happens only on an explicit request naming its subject.**
No read path, no list endpoint, no page load and no background timer may call a
model. `/tasks` stays free; so does every route and tool that answers a
question SQLite can answer.

**2. One subject per call. A tool never fans out internally.**
`ac_review` takes one `taskId` and grades that task. A tool that accepted an
array — or looped over a query result itself — would turn one caller decision
into N charges, which is the failure mode a human clicking a button cannot
produce.

**3. A caller that iterates must be bounded by the human who started it.**
A skill may call an agent tool once per item it was asked to work on. It may not
sweep a backlog, a query result or a whole project on its own initiative. When a
skill wants a sweep, it asks first and names the count.

**4. No automatic retry.**
`AiError` already separates the kinds a caller acts on differently — `rate_limit`
carries `retry-after`, `budget` means the deployment spent its tokens thinking.
These are surfaced to the caller, never retried in a loop
(`src/adapters/companion/ac-review.ts:216-226`).

**5. A model-calling surface is stdio-only by default.**
A new agent tool is absent from `REMOTE_TOOL_ALLOWLIST`
(`src/adapters/mcp/server-bootstrap.ts:52-71`), so a remote connector cannot
trigger spending. Exposing one remotely is a separate, deliberate decision with
the three coordinated edits that allowlist already requires.

**6. The key lives in a file, never in an environment.**
`ai-key.txt` mode 0600 beside `bridge-token.txt`; `CHODA_AI_KEY` is how a key
ARRIVES, not where it lives (`src/adapters/companion/azure-review.ts:105-140`).
A provider's response body is never forwarded to a caller — a reflected request
can echo the key back (`src/adapters/companion/ac-review.ts:222-225`).

## Consequences

* Adding an agent means adding a tool that obeys 1-6, and citing this ADR. No
  registry, no framework — an agent is `askAzureJson` with a name, a system
  prompt and a schema.
* Anything wanting a sweep — "grade every READY task" — needs a human to ask for
  it by name. That is a deliberate limit on convenience, and the reason is that
  an unattended loop is how a bill arrives without a decision behind it.
* This ADR sets **no monetary ceiling**, and nothing here would stop a
  sufficiently large single request. A real ceiling is an Azure-side control, per
  the cross-project note above. If one is wanted, it is its own task.
* Point 3 is a rule for skills, which are prose — nothing enforces it at compile
  time. It is written here so a reviewer can point at it, not because the
  codebase can check it.

## Amendment — 2026-10-10: opt-in scheduled runs (improve loop)

TASK-2352 Q2. The improve loop (`/improve-loop <ws>`) calls a model from the
`ChodaImproveLoop` scheduled task (`scripts/install-improve-loop-task.mjs`),
which is a background timer and so breaks point 1 as written. It is allowed as
a bounded exception:

* **Opt-in per workspace, in that workspace's own file.** The launcher runs a
  workspace only when its `.choda/improve.json` says `mode: "scheduled"`, read
  fresh at every run. `manual`, `off`, a missing config and a config that does
  not parse are all skipped. Installing the task opts nothing in.
* **One run per opted-in workspace per day**, sequentially, under the
  workspace's own `model`. The skill itself is bounded: the evaluator is called
  only when a page's screenshot changed, and it files at most `maxProposals`
  proposals.
* **It stops itself.** When every criterion is marked good enough, or nothing
  improved for `stopAfterFlat` runs, the skill writes `mode: "off"` and says why
  in the inbox, so an opted-in workspace does not keep spending on a plateau.
* **Points 2–6 still hold.** The run is a local `claude -p` with a fixed
  `--allowedTools` list (no remote surface, no retry loop, no key in the
  environment).

No other scheduled or background model call is covered by this amendment. A
new one needs its own amendment.

## Amendment — 2026-10-24: companion chat assistant

TASK-2732, for goal TASK-2731 (discovery
`docs/reports/companion-chat-assistant-discovery.md`, thread
CONV-1792821501482-50). The companion's chat assistant answers a question by
calling read-only tools, so one message can lead to several model calls. Point 2
("one subject per call, a tool never fans out internally") does not cover that.
It is allowed as a bounded exception:

* **One user message is one explicit request.** Nothing calls the model on page
  load, on opening a chat or on changing the model; only pressing Send does
  (point 1). One message runs **at most 8 executed tool calls**. When the eighth
  has run, the loop makes **one final call with `tool_choice: 'none'`**, so the
  model must answer with what it has, and the reply is marked `capped`.
* **Every tool in the loop is read-only.** The tool registry is built from a
  service interface that exposes only list, get and search methods. A tool that
  creates, updates or deletes anything is not covered here and **needs its own
  amendment**.
* **A per-chat token budget.** Each chat has a budget, **default 300000 tokens,
  allowed 200000–400000**, set when the chat is created. It is **checked before
  the first call of a message**: a chat at or over its budget refuses the
  message with no provider call. One message may finish past the budget; the
  next one is refused. Tokens come from the response `usage`
  (`prompt_tokens + completion_tokens`); when `usage` is missing, an estimate
  is recorded and marked as one. Steps and tokens are shown under every reply.
* **Tool output is redacted and capped before it reaches the provider.** Every
  IPv4 address becomes `[ip]` and every line naming a password, token, secret,
  API key or connection string becomes `[line redacted]`; the result is then
  **capped at 16000 characters**. The vault holds client infrastructure notes,
  which is why this is a rule and not an option.
* **Chats stay on this machine.** They are stored in their own tables, which are
  not in the remote sync allowlist (`src/core/sync/sync-apply.ts`).
* **Points 1, 4, 5 and 6 still hold:** no call without a sent message, **no
  automatic retry** (`rate_limit` and the other `AiError` kinds are shown to the
  user), **no remote surface** (the routes live in the companion adapter and
  nothing is added to `REMOTE_TOOL_ALLOWLIST`), and the key stays in
  **`ai-key.txt`**; a provider's response body is never forwarded.

No other multi-call loop is covered by this amendment. A new one needs its own
amendment.

## Amendment — 2026-10-26: assistant service

TASK-2753, for goal TASK-2751 (discovery
`docs/reports/assistant-chatgpt-like-chat-discovery.md`, thread
CONV-1792980384690-64). The chat assistant moves out of the companion adapter
into a process of its own, streams its replies, and gains regenerate and
edit-and-resend. The 2026-10-24 amendment assumed the routes live in the
adapter and that one message runs one non-streamed loop; this amendment covers
the new shape. Everything the 2026-10-24 amendment allows, it still allows, on
the same terms:

* **A separate local process, reached only through the adapter.** The assistant
  runs as its own process, spawned by the companion adapter as a child and
  bound to 127.0.0.1. Nothing else starts it. The web reaches it only through
  the adapter's `/assistant/*` forward, which carries the bridge token as every
  other companion route does. Nothing is added to `REMOTE_TOOL_ALLOWLIST`, so no
  remote connector can reach the assistant (point 5).
* **Its own database, never synced.** Chats live in `<dataDir>/assistant.db`,
  a file of their own that is never synced: it is not the shared database and
  is not named in the remote sync allowlist (`src/core/sync/sync-apply.ts`). The
  chat rows that already exist in the shared database are copied into it once;
  they are not dropped.
* **Regenerate and edit-and-resend are requests of their own.** Each is a new
  explicit request, made only when the user presses its button, gated by the
  same budget check as Send before any provider call, and counted again: its
  tokens are added to the chat's total like any other message.
* **A streamed reply still records what it cost.** A streamed reply records
  `usage` from the final chunk of the stream (`stream_options.include_usage`).
  A stream that ends without it (the user pressed Stop, the connection dropped)
  records an estimate, marked as one, exactly as a non-streamed reply without
  `usage` does.
* **The 2026-10-24 limits still hold:** the 8-step cap with one final call on
  `tool_choice: 'none'`, redaction of tool output plus the 16000-character cap
  before it reaches the provider, no automatic retry (point 4), and the key in
  `ai-key.txt` (point 6). Tools stay read-only; the service reads work data
  through the adapter's read routes and writes nothing but its own chats.

No other process, stream or loop is covered by this amendment. A new one needs
its own amendment.
