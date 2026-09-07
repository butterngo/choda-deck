---
type: gotcha
title: An upgrade has no response object and no framing — refusals must destroy, relays must rebuild
projectId: choda-deck
scope: project
refs:
  - path: src/adapters/companion/terminal-socket.ts
    commitSha: 8f91a70c96b3edb146cd5ecde49850e365b102c8
createdAt: 2026-09-07
lastVerifiedAt: 2026-09-07
affectedFeatureId: feature-companion-cockpit
---

**Trigger:** you are adding a WebSocket route to the adapter, or teaching the Electron proxy to carry one. Everything else on this surface is request/response, and the habits from that do not transfer.

## Context

Until TASK-1877 the adapter had never streamed anything and the proxy (`electron/static-proxy-server.cjs`, which injects the bridge token) had never handled an `upgrade`. Two unknowns at once, under a PTY, would have meant a failure could be the socket, the proxy, or the shell — so an echo-only socket shipped first, deliberately useless, to make the transport known-good before anything rode on it.

Three things bit, none of which has an equivalent in the request/response world.

## Business rule

**1. A refusal must DESTROY the socket, not merely decline.**

There is no `ServerResponse` during an upgrade — no `sendJson`, no status helper. You write a status line by hand. The temptation is to stop there, and the result is a **half-open door**: the caller holds a live TCP connection to a server that has decided not to talk to it.

From the client this is *indistinguishable* from a refusal that worked. Assert `socket.destroyed`, not that no message arrived — and drive it with a raw `net` socket, because the `ws` client swallows the error once a caller handles `unexpected-response`.

*(Injecting the missing `destroy()` turned three refusal tests red by **hanging** — the hang is the bug, rendered.)*

**2. Attach with `noServer: true` and own the `upgrade` event.**

Handing the http server to `WebSocketServer` lets `ws` answer **every** path, and the token check has to happen *before* any handshake completes. With `noServer`, the route check and the token check run first and the refusal above is yours to make.

**3. A relay is byte-level, and rebuilds rather than forwards.**

After the handshake there is no body to pipe — the socket carries frames. So the proxy rebuilds the 101 status line and headers rather than forwarding a response. Two further obligations, both silent when missed:

- `unshift` any buffered head bytes back on **both** sides, or the first frame is eaten.
- Either end closing must destroy the other. Without it a dropped adapter leaves the browser holding a socket nobody reads, and a refusal leaves it waiting on a handshake that will never complete.

## Resolution

- `terminal-socket.ts` — `noServer`, explicit `refuse()` that writes a status line then destroys, one removal path for every way a socket can end.
- `static-proxy-server.cjs` — `relayUpgrade()`; only `/api` upgrades are relayed, a static path has no socket behind it.
- Test the relay with **raw sockets**, not a `ws` client: the relay does not parse frames, so raw bytes are the actual contract.
- A leak test must open and close **ten** times. One would pass against a set that never deletes.

## Related

- TASK-1877 (transport alone), TASK-1878 (the PTY that rides it), TASK-1503 (the bridge token)
- `COMPANION_BIND = '127.0.0.1'` — the bound that makes this acceptable at all
