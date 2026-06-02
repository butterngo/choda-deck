---
type: decision
title: "ADR-031: session_end field derivation — deterministic auto-fill, heuristic candidates, AI-wins override"
projectId: choda-deck
scope: project
refs: []
createdAt: 2026-06-02
lastVerifiedAt: 2026-06-02
---

# ADR-031: session_end field derivation — deterministic auto-fill, heuristic candidates, AI-wins override

> AI-Context: `session_end` stops requiring the AI to hand-pass every handoff field. The server derives what it can from observable state — `commits[]` (git log over the session window) and `filesChanged[]` (channel-1 events, already aggregated per ADR-029) are auto-filled deterministically; `resumePoint` is a best-effort transcript heuristic. All derivation runs in the **async MCP tool handler** (git + transcript are async I/O — the domain `endSession` is a sync better-sqlite3 transaction and stays pure). Merge rule is AI-wins (ADR-029 precedent). Transcript-mined `decisions[]` is **explicitly rejected** — the AI keeps passing those; TASK-998 already drafts gotchas from them.

## Context

Per the choda-deck philosophy ("give the AI enough context to propose without asking"), the Session primitive currently leaks its protocol onto the agent. `session_end` asks the AI to manually pass `resumePoint`, `decisions[]`, `commits[]`, `filesChanged[]`, `looseEnds[]`, and `summary{…}`. If the AI forgets a field or misclassifies one (an action item lands in `looseEnds` instead of becoming a `task_create`), the handoff degrades **silently** — the failure mode TASK-985 exists to kill.

This question was first raised — and deliberately deferred — in **ADR-028 Option D** ("auto-emit on `session_end`, server derives from handoff, no AI input"). It was rejected then because the handoff lacked any reliable source for `acCoverage` / `openItems` / `commits` attribution. Two things have shipped since that change the calculus:

| New substrate | What it gives us | Source |
|---|---|---|
| Channel-1 `file_modified` events + summary aggregator | `filesChanged[]` already auto-derives inside `endSession`, AI-wins merge | ADR-029 (TASK-913) |
| `gotcha_draft` candidate rail | Server emits heuristic scaffolds as `memoryCandidate:true` rows; the agent refines post-session, human gates | TASK-998 |

So the substrate for partial derivation now exists. This ADR decides **which `session_end` fields the server should derive, how, and where the derivation runs** — the AC #2 deliverable of TASK-985.

## Constraints (load-bearing)

1. **The domain layer is a synchronous transaction.** `SessionLifecycleService.endSession` runs inside `this.db.transaction(...)` (better-sqlite3, sync). It cannot `await` — no git subprocess, no file read, no LLM call. The code states this directly (`session-lifecycle-service.ts:370`: *"Deterministic, no LLM (the domain layer runs inside a sync DB transaction)"*).
2. **An AI-wins merge contract already exists.** `aggregateSessionSummary` (ADR-029, `session-lifecycle-service.ts:248-274`) fills only the gaps the AI left and appends `+ K auto-detected` suffixes. This is the override contract — reuse it, do not reinvent.
3. **TASK-998 derives from `handoff.decisions`, NOT from the transcript.** Its gotcha drafts consume fields the AI *still passes*. There is therefore **no existing precedent** for reading the Claude Code transcript (`~/.claude/projects/...`). That capability — and its reliability — is the genuinely new risk this ADR must rule on.

## Options considered

| Option | Pro | Con |
|---|---|---|
| A. Status quo — AI passes all fields | Zero work; max fidelity when AI complies | The silent-degradation failure TASK-985 targets remains |
| B. Full server derivation incl. transcript-mined `decisions[]` (ADR-028 Option D, maximal) | Protocol burden fully gone | `decisions[]` mined by regex from raw transcript text reintroduces the *exact* silent-misclassification failure; LLM extraction is impossible in the sync txn |
| **C. Tiered derivation (this ADR)** | Removes burden where derivation is reliable; keeps the AI authoritative where it isn't; reuses ADR-029 merge + TASK-998 rail | Two code paths (deterministic vs candidate); async derivation must live outside the domain txn |
| D. Derive everything in a post-`session_end` async pass, rewrite the handoff row | Sidesteps the sync-txn constraint cleanly | A second write after close breaks atomicity; handoff briefly incomplete; readers race the rewrite |

## Decision

**Chosen: Option C — tiered derivation.** Classify each field by how reliably the server can produce it, and route each tier through the mechanism that already exists for it.

### Tier 1 — Deterministic auto-fill (AI-wins merge)

The server produces these from observable state; AI-supplied values win on conflict (ADR-029 contract).

| Field | Source | Notes |
|---|---|---|
| `filesChanged[]` | Channel-1 `file_modified` events + git diff vs session-start ref | **Already shipped** via `aggregateSessionSummary`. TASK-985 extends it to the handoff path, no new design. |
| `commits[]` | `git log` over the session window (`startedAt..endedAt`), filtered by task-ID tags in subjects | New. Async — see "Where derivation runs". |

### Tier 2 — Best-effort heuristic (clearly labelled, AI-wins)

| Field | Source | Notes |
|---|---|---|
| `resumePoint` | Last assistant message in the transcript | Weak but harmless heuristic — a wrong resume point is visibly wrong and cheap to fix. Labelled as auto-derived; any AI-supplied value wins. |

### Tier 3 — AI stays authoritative (NOT derived)

| Field | Why not derived |
|---|---|
| `decisions[]` | Regex-mining decisions from raw transcript text reintroduces the precise silent-misclassification failure TASK-985 is trying to eliminate, and an LLM pass is impossible inside the sync txn. The AI keeps passing `decisions[]` — and **TASK-998 already consumes them** to draft gotchas downstream. Deriving them server-side would degrade a field that currently works. |
| `looseEnds[]`, `summary{…}` | Forward-looking judgment with no observable source (unchanged from ADR-028's reasoning). |

### Where derivation runs (the one genuinely new architectural call)

Git log and transcript reads are **async I/O** and cannot run inside the domain transaction. They run in the **async MCP tool handler** (`session-tools.ts`), *before* `endSession` is invoked:

```
session_end handler (async):
  1. derive commits[]      ← await git log (session window)
  2. derive resumePoint    ← await read + parse transcript JSONL (last assistant msg)
  3. pass derived fields as INPUT to endSession(input)   ← domain stays sync + pure
  4. endSession merges AI-wins (existing aggregateSessionSummary path), writes handoff atomically
```

The domain layer never gains async dependencies; the handler owns all I/O; the single atomic write is preserved (rejecting Option D's post-close rewrite). `filesChanged[]` continues to derive *inside* the txn from already-persisted channel-1 rows — only git/transcript reads move to the handler.

### Transcript ↔ session correlation (decided after TASK-985 AC #1 spike)

The AC #1 spike (`docs/knowledge/spike-session-end-derivation-2026-06-02.md`) found a gap that blocks `resumePoint` derivation: the choda `sessions` row stores `startedAt`/`endedAt` but **no Claude Code `sessionId` and no transcript path**, so the server cannot deterministically locate "this session's" `.jsonl`. Transcripts live at `~/.claude/projects/<cwd-slug>/<ccSessionId>.jsonl` (cwd-slugged, so worktrees get separate dirs).

**Decision: capture at `session_start` (primary) + heuristic correlate (fallback).**

1. **Primary — capture.** `session_start` accepts an optional `ccSessionId` (or `transcriptPath`) the caller passes through; it is persisted on the session row. At `session_end` the transcript is located deterministically. This pushes exactly **one stable id** back onto the protocol — acceptable, and categorically different from the per-close handoff fields this ADR removes (an id set once at start vs. judgement re-entered every close).
2. **Fallback — correlate.** When the id is absent, pick the newest `.jsonl` under the session's cwd-slug dir whose row `timestamp` range overlaps `[startedAt, endedAt]` and whose `gitBranch` matches. Fragile under multiple active sessions in one cwd (ADR-009 permits them) — so it is a fallback, not the contract.

**Why a missed correlation is safe:** `resumePoint` is Tier 2 best-effort. If neither path resolves a transcript, the field is simply left for the AI to supply (or omitted) — no incorrect data is ever written. Correlation failure degrades to today's behaviour, never to a wrong handoff.

`commits[]` / `filesChanged[]` (Tier 1) do **not** depend on this — git window + channel-1 rows need no transcript — so AC #3 is unblocked regardless of how correlation lands.

### Scope of "derives the rest" (`session_end({ sessionId })`)

"Derives the rest" means the **handoff** fields — `commits[]` (Tier 1) and `resumePoint` (Tier 2). `filesChanged[]` is a **summary** field (ADR-028), not a handoff field, and stays opt-in: a bare `session_end({ sessionId })` with no `summary` does **not** synthesize a summary row. This preserves ADR-028's deliberate "coverage stays AI-opt-in" stance — when the agent does pass a `summary`, `aggregateSessionSummary` (ADR-029) still auto-fills `filesChanged` from channel-1 events as before. No bare-session summary fabrication.

### Override contract

Reuse ADR-029 verbatim: **AI input wins; derivation fills gaps only.** `session_end({ sessionId })` with no other fields yields a complete handoff; `session_end({ sessionId, resumePoint })` lets the AI override the heuristic while still auto-filling `commits[]`/`filesChanged[]`. No new merge semantics.

## Consequences

**Positive**
- Real protocol-burden removal where it's safe: `commits[]` + `filesChanged[]` become zero-effort and 100%-covered for closed sessions.
- No regression to TASK-998 — `decisions[]` stays AI-authored, so the gotcha-draft rail keeps its quality input.
- Domain layer stays sync + pure; no async creep into `endSession`; atomic close preserved.
- Override contract is the already-proven ADR-029 merge — no new mental model for callers.

**Negative / accepted tradeoffs**
- Transcript reading is new surface: path resolution under `~/.claude/projects/...`, JSONL parsing, CRLF-safety (`splitLines`), and graceful absence (no transcript → skip `resumePoint`, never crash the close).
- `resumePoint` heuristic ("last assistant message") will sometimes pick a trailing tool-result or a throwaway line — accepted because it's visibly wrong and AI-overridable.
- Two derivation locations (handler for git/transcript, domain for channel-1 events) — documented here so the split isn't surprising.

**Defers / rejects**
- **Rejects** transcript-mined `decisions[]` (Option B) — revisit only if a future async post-session pass with an LLM is introduced as a separate, non-atomic enrichment step (explicitly out of scope here).
- **Defers** cross-platform transcript path resolution (Mac/Linux) — Windows-first, mirroring ADR-029's hook stance.

## Revisit when

- An async LLM enrichment step is added after `session_end` (would reopen Tier-3 `decisions[]` derivation under different atomicity rules).
- `resumePoint` heuristic proves too noisy in practice → consider a marker convention the AI emits mid-session instead.

## Implementation roadmap (TASK-985)

| Order | Work | AC |
|---|---|---|
| 1 | Spike: confirm transcript path resolution + JSONL shape under `~/.claude/projects/...` | TASK-985 AC #1 |
| 2 | This ADR | TASK-985 AC #2 |
| 3 | `commits[]` derivation in handler (git log, session window) + AI-wins merge | AC #3 |
| 4 | `filesChanged[]` handoff-path extension (reuse `aggregateSessionSummary`) | AC #3 |
| 4.5 | `session_start` accepts + persists optional `ccSessionId`/`transcriptPath` (correlation primary path) | prereq for AC #4 |
| 5 | `resumePoint` transcript heuristic in handler (capture → fallback correlate → last text-bearing assistant turn) | AC #4 (note: `decisions[]` half of AC #4 is **rejected** by this ADR — update the task AC) |
| 6 | `session_end({ sessionId })` end-to-end + override preserved | AC #5, #6 |
| 7 | vitest per-derivation + integration (start → 2 commits + 3 edits → `session_end({sessionId})` → assert handoff) | AC #7 |

> **AC drift note:** TASK-985 AC #4 currently bundles `resumePoint` *and* `decisions[]` as transcript-derived. This ADR splits them — `resumePoint` ships (Tier 2), `decisions[]` is rejected (Tier 3). The task AC should be amended to match before implementation.

## Related

- [[ADR-028-session-end-structured-summary]] — Option D (server-derived) deferred here; this ADR reopens it with the substrate now in place
- [[ADR-029-session-activity-visibility]] — the `aggregateSessionSummary` AI-wins merge + channel-1 `file_modified` source this ADR reuses
- [[ADR-009-session-lifecycle]] — `session_end` semantics + workspace ↔ active-session resolution
- [[ADR-024-review-status-and-session-checkpoint]] — body-lock context for the broader session-flow family
- `docs/knowledge/spike-session-end-derivation-2026-06-02.md` — AC #1 data-source catalog; surfaced the correlation gap decided above
- TASK-985 — implementation of this ADR
- TASK-998 — downstream consumer of `decisions[]` (the reason Tier 3 keeps it AI-authored)

---

**Status: DRAFT — proposed ADR-031.** Number is provisional: TASK-999 has not yet frozen the in-flight ADR-NNN number, so reconcile before registering via `knowledge_create`. Not yet indexed in the knowledge layer.
