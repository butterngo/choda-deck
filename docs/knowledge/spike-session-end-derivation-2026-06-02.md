---
title: "Spike: session_end derivation — data-source catalog (TASK-985 AC #1)"
date: 2026-06-02
status: complete
linked_task: TASK-985
related_adrs: [ADR-031, ADR-029, ADR-009]
---

# Spike: session_end derivation data sources (TASK-985 AC #1)

## TL;DR

All three derivation sources are reachable, but **the transcript has no stored link to a choda `SESSION-xxx` row** — that correlation is the one real design decision before AC #4. `commits[]` (git) and `filesChanged[]` (channel-1 events) are clean deterministic wins. `resumePoint` (transcript) is a usable best-effort heuristic with two known rough edges. Confirms ADR-031's tiering.

## Source catalog

| Field | Source | Reachable from MCP server? | Determinism |
|---|---|---|---|
| `commits[]` | `git log --since/--until` over session window, `--grep=TASK-` | Yes — async subprocess in the handler | Deterministic |
| `filesChanged[]` | `session_events` rows `kind='file_modified'` (channel 1, ADR-029) | Yes — same SQLite DB, already aggregated by `aggregateSessionSummary` | Deterministic |
| `resumePoint` | Last text-bearing assistant turn in the CC transcript JSONL | Yes IF the transcript file can be located (see gap) | Best-effort heuristic |
| `decisions[]` | — | — | **Not derived (ADR-031 Tier 3)** — AI keeps passing it |

## Transcript format (verified on this live session)

- **Location:** `~/.claude/projects/<cwd-slug>/<ccSessionId>.jsonl`, where `<cwd-slug>` = cwd with non-alphanumerics → `-` (e.g. `C:\dev\choda-deck` → `C--dev-choda-deck`).
- **Format:** JSONL, one event per line. Verified ~215 lines on a mid-size session.
- **Row `type` values seen:** `assistant`, `user`, `system`, `mode`, `attachment`, `file-history-snapshot`, `last-prompt`, `ai-title`.
- **Per-row keys useful for correlation:** `sessionId` (CC UUID = filename), `cwd`, `gitBranch`, `timestamp` (ISO), `uuid`/`parentUuid` (DAG threading), `message`.
- **Assistant message shape:** `message.content` is an array of blocks (`text` | `tool_use` | …). `resumePoint` = the **last block of type `text`**, walking turns backward — the literal last assistant turn is frequently `tool_use`-only and carries no text.

## Findings / risks

1. **Correlation gap (blocking design decision).** The choda `sessions` row stores `startedAt`/`endedAt` but **no CC `sessionId` and no transcript path** (`grep` of `src/core/domain/` + `session-tools.ts` → nothing). The MCP server cannot, at `session_end`, deterministically know which `.jsonl` is "this session." Three options:
   - **(a) Capture at session_start.** Add an optional `transcriptPath` / `ccSessionId` param the agent passes through. Cleanest + deterministic, but pushes one field back onto the protocol (mild tension with the task's own goal — though it's one stable id, not the whole handoff).
   - **(b) Heuristic correlate at session_end.** Pick the newest `.jsonl` under the cwd-slug dir whose `timestamp` range overlaps `[startedAt, endedAt]` and whose `gitBranch` matches. No protocol change; fragile under parallel sessions in one cwd (ADR-009 allows multiple active sessions per workspace).
   - **(c) Hook-supplied.** A `SessionStart`/`PostToolUse` hook writes the CC `sessionId` into the session row (the hook has it via env). Consistent with ADR-029's existing file-edit hook; per-machine opt-in.
   - **Recommendation:** (a) as the primary path, (b) as the no-config fallback. `resumePoint` is best-effort anyway, so a fallback miss just means the AI supplies it — no correctness loss.

2. **cwd-slug is cwd-derived, not workspace-derived.** Worktrees produce separate project dirs (`C--dev-choda-deck--claude-worktrees-…`). Path resolution must slug the *session's actual cwd*, not the repo root.

3. **`resumePoint` heuristic is mid-stream, not a clean summary.** On this session the last text block was narration preceding tool calls, not a tidy "stopping point." Acceptable per ADR-031 (labelled best-effort, AI-overridable), but do not oversell it as a true resume point.

4. **`gitBranch` is a free bonus** carried per transcript row — usable to enrich the handoff or to disambiguate correlation option (b).

5. **CRLF.** Transcript read + split must use `splitLines()` (`src/core/utils/lines.ts`), per the repo CRLF rule — files on Windows carry `\r\n`.

6. **Async boundary holds (ADR-031).** Both git log and transcript read are async I/O → they run in the `session_end` MCP handler, before the sync `endSession` txn. `filesChanged[]` stays inside the txn (reads already-persisted channel-1 rows). No change to the sync/pure domain layer.

## AC #1 verdict

Catalog complete. No blocker to implementation **except** picking a correlation strategy (finding 1) — that choice should be appended to ADR-031 before AC #4 (`resumePoint`) is built. AC #3 (`commits[]` + `filesChanged[]`) has no such dependency and can proceed immediately.
