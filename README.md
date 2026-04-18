# Choda Deck

An Electron desktop app that orchestrates multiple interactive Claude Code sessions across projects — one workspace, one unified UI, one click to switch between live sessions in different repos.

> **Status:** Early spike. The MVP goal is an Obsidian-style UX where a sidebar lists your projects and the main pane shows a live interactive `claude` session for whichever project is selected. This repo is the initial spike proving the core PTY + xterm.js + Electron pipeline works.

## Why

If you work across several repos every day, the usual alternatives all hurt:

- Multiple Windows Terminal tabs — labels get lost, no project context, alt+tab hell
- Multiple VS Code windows — terminal is a side panel, claude is not first-class
- `claude -p` headless — loses interactive context, can't follow up, one-shot only

Choda Deck treats a **project** as the unit of navigation and the **interactive claude session** as first-class content. Sidebar holds the project list, main pane hosts live PTY-backed terminals, keyboard-switch between them with zero friction.

## Stack

| Layer              | Choice                                            | Why                                                               |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------- |
| Shell              | Electron                                          | Mature, rich ecosystem, proven for terminal apps (VS Code, Hyper) |
| Renderer framework | React + TypeScript                                | Familiar, large ecosystem, matches primary dev stack              |
| Build tooling      | electron-vite + Vite 7                            | Fast HMR, out-of-the-box main/preload/renderer pipeline           |
| Terminal renderer  | [xterm.js](https://xtermjs.org/)                  | Industry standard, used by VS Code, Hyper, Theia                  |
| PTY layer          | [node-pty](https://github.com/microsoft/node-pty) | Official Microsoft fork, ConPTY on Windows, prebuilt binaries     |

## Dev

```bash
npm install
npm run dev
```

Requires Node 20+ and a working `claude` CLI on PATH (Windows: `claude.cmd` via npm global).

## Spike smoke test

A plain-Node PTY validation that doesn't involve Electron at all — useful when diagnosing native module or PTY issues:

```bash
node scripts/spike-pty.mjs
```

Spawns `claude.cmd` in a target cwd, captures ANSI output, sends Ctrl+C, and reports whether the interactive TUI rendered correctly.

## Roadmap

- [x] **Spike** — prove Electron + xterm.js + node-pty + claude interactive mode work on Windows
- [ ] **MVP** — sidebar with N hardcoded projects, click to switch, session persists across switches
- [ ] **Config** — JSON file for project list, add/remove via UI
- [ ] **Status indicators** — show whether each session is idle / working / waiting for input
- [ ] **Command palette** — quick jump to project by name
- [ ] **Layout persistence** — restore workspace on relaunch
- [ ] **Theming** — light / dark / custom
- [ ] **Cross-platform** — macOS, Linux builds
- [ ] **Plugins / extensibility**

## License

MIT — see [LICENSE](LICENSE).
