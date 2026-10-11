# TASK-2380 — AC verification

`src/adapters/companion/inbox-decide.ts`: `GET /inbox/pending`, `POST /inbox/:id/convert`,
`POST /inbox/:id/archive` — the data behind the companion's "Cần anh quyết" screen. Only tagged
items from automated sources (`[activity-digest]`, `[improve:<ws>]`, `[improve-note:<ws>]`), digest
first, bridge-token gated.

## Done — 4/4

| # | Criterion | Evidence |
|---|---|---|
| 0 | Pending list: only raw automated items, digest first then newest, title without the tag | `inbox-decide.test.ts`: raw digest + archived digest + raw `[improve:web]` + raw untagged capture → exactly `[digest, improve]`. The digest item is the OLDER one, so newest-first alone would fail; mutating the digest-first rank made the test fail (1 failed), restoring it passes |
| 1 | Convert → 200 `{ inboxId, taskId }`, task `## Context` holds the item text; untagged 404, non-raw 409 | route tests; the task carries the item's `- [ ]` line into its Acceptance |
| 2 | Archive needs a reason; empty/missing → 400 `{ field: "reason" }`, nothing changes | route test: whitespace reason and `{}` both 400, item still `raw`; with a reason → `archived` |
| 3 | 401 without the bridge token on all three | route test, and live: `GET /inbox/pending` without a token → 401 |

## Live

Service restarted on the new adapter: `GET /inbox/pending` returns 6 items, all
`activity-digest` (INBOX-2150, 2151, 2159, 2170, 2196, 2197), out of 417 raw inbox items.

## Findings

- INBOX-2150 is still pending although TASK-2385 now covers it; it can be archived from the
  decide screen once that exists.
- Full suite: only the documented `mermaid-check` / `workspace-diagram` timing flakes failed;
  29/29 on a solo rerun. `GET /inbox` (unfiltered) is untouched.
