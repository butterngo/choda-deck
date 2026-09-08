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
lastVerifiedAt: 2026-09-08
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
