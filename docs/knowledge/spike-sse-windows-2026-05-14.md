---
title: Spike Gate B — Hono SSE keep-alive on Windows Node (Phase 2 companion)
date: 2026-05-14
status: complete
linked_task: TASK-738
related_adrs: [companion-ui-system, ADR-019]
---

# Spike: Hono `streamSSE` keep-alive on Windows Node

## TL;DR

**PASS** — Hono `streamSSE` helper holds a single long-running EventStream connection on Windows Node 24 for ~90s (30 events @ 3s). No disconnect, no buffer/boundary corruption, all events in order. Use SSE (not polling) for Phase 2 `/api/queue/live`.

## Configuration

| Item | Value |
|---|---|
| Node | `v24.14.0` |
| OS | Windows 11 Enterprise (10.0.26200.8246) |
| Hono | `4.12.18` |
| `@hono/node-server` | `1.19.14` |
| Helper | `streamSSE` from `hono/streaming` |
| Listen | `127.0.0.1:8989` |
| Schedule | 30 events × 3s = ~90s wall-clock |
| Event format | `{ event: "tick", data: JSON.stringify({seq, ts}), id: <seq> }` |
| Spike folder | `C:\dev\choda-deck-companion\packages\server\__spikes__\sse-windows\` |

## Verify results (4/4 PASS)

1. **30/30 events received in order** — client counter `30 / 30`, no out-of-order detection.
2. **`readyState === 1 (OPEN)`** held throughout — verified in DevTools console + on-page status line.
3. **Single long-running connection** — DevTools Network panel showed one EventStream entry, no retry/reconnect rows.
4. **JSON parse success** — every `tick` event parsed cleanly (`parseFail=0`). No event-boundary corruption / merged events / CRLF artifacts.

## Edge cases / notes

- `stream.sleep(ms)` was used between events (not `setInterval`) — that's the idiomatic pattern for Hono's `streamSSE` and avoids back-pressure issues.
- `stream.writeSSE({ event, data, id })` — `id` field set per event so any reconnect would `Last-Event-ID` from a known seq. Not exercised in this spike (no disconnect occurred).
- `@hono/node-server` uses Node's native HTTP server — no Edge/Workers runtime quirks on Windows.
- `pnpm tsx server.ts` from inside the workspace failed because pnpm's deps-status check runs `pnpm install` and the workspace blocks the esbuild build script. Workaround: invoke `node_modules/.bin/tsx server.ts` directly. **Real fix for TASK-739**: scaffold `packages/server/` as a workspace package and let the root `pnpm-workspace.yaml` `allowBuilds: esbuild` cover it (already wired for the notifier package).

## Recommendation

**Use Hono `streamSSE`** for Phase 2 `/api/queue/live`. No polling fallback needed at this point — the connection model is solid on the target platform.

When implementing TASK-739:
- Set an `id` per event so a reconnect can resume.
- Send a periodic comment-line keep-alive (`: ping\n\n`) every ~15s as defense against intermediate proxies / OS idle drops (not strictly needed here on `127.0.0.1`, but cheap insurance for LAN mode).
- Close the stream cleanly when the underlying `queue.jsonl` writer terminates (`run.finished` / `run.failed` event).

## Related

- TASK-738 — this spike
- TASK-739 — Phase 2 viewer (unblocked by this)
- ADR-019 — `queue.jsonl` event schema (the real stream Phase 2 will tail)
- `companion-ui-system.md` § Phase 2 Gates + § Live indicator
