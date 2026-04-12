@CLAUDE.local.md

# Choda Deck

Desktop workstation (Electron + React + xterm.js + node-pty) that hosts one live interactive `claude` session per project in a tabbed sidebar. Long-term identity: the unified surface where the vault + Choda collaboration system comes together. This repo is in MVP build after an end-to-end spike (commits `1953bed`, `7187791`, `d2c9623`).

## Vault context

Knowledge artifacts live in the vault. Always read them before making non-trivial changes.

- Architecture (components, IPC contract, flows): `docs/architecture.md`
- Decisions: `docs/decisions/`

## Authoritative in-repo specs

- `docs/requirements.md` — MVP scope, Q1/Q2 decisions, big-picture vision. **Authoritative** for scope.
- `docs/research.md` — open research backlog (R1, R3, R4, R6, R11 block MVP quality).

When docs/vault context disagrees with code: code describes current spike state, docs describe MVP target state. Do not "fix" code to match doc prose unless the task is explicitly that MVP refactor.

## Conventions

- `.claude/rules/typescript.md` — TS style (single quotes, no semi, 100 cols, explicit return types on public functions)
- `.claude/rules/react.md` — React 19 patterns actually used (function components, useRef for imperative handles, cleanup in useEffect)
- `.claude/rules/electron-ipc.md` — IPC channel naming, invoke vs send, per-session event streams, preload surface rules

## Per-layer context

- `src/main/CLAUDE.md` — Electron main process, PTY lifecycle, session map
- `src/preload/CLAUDE.md` — contextBridge API surface, what can and cannot live here
- `src/renderer/CLAUDE.md` — React renderer, xterm mount, `window.api`-only rule

## Graph CLI

This project has a knowledge graph backed by Neo4j. Use the graph CLI for context queries:

```bash
npx ts-node src/graph/graph-cli.ts context <id>        # e.g. context TASK-130
npx ts-node src/graph/graph-cli.ts context <id> -f json # JSON output
npx ts-node src/graph/graph-cli.ts list tasks -p <project>
npx ts-node src/graph/graph-cli.ts info <id>
npx ts-node src/graph/graph-cli.ts cheatsheet           # all commands
```

When asked for "context" of a task/feature/decision, use the graph CLI first — it returns the full dependency tree from Neo4j. Fall back to vault file search only if Neo4j is unavailable.

## Working style

- **KISS first.** This is a spike → MVP. Simplest thing that satisfies the requirement. No premature abstractions.
- **Clarify before implementing** when scope is ambiguous. Ask one focused question, do not guess.
- **No auto-commits.** Commits only on explicit request.
- **No dev server claims without proof.** For UI changes, launch `npm run dev`, exercise the feature in the actual Electron window, then report. Type-check alone is not validation.
- **Respect the research backlog.** If a task touches resize, shutdown, PATH, or xterm rendering edge cases, read the relevant `Rxx` in `docs/research.md` first — those items exist because the answer is not obvious.
- **The MVP target is polymorphic main pane.** Current `App.tsx` is a single-terminal spike. Any renderer change should either leave the door open for `<ViewRouter>`, or be part of that refactor explicitly.
