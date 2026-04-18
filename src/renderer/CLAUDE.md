# Choda Deck — Renderer (React UI)

## Purpose

React 19 + TypeScript UI for Choda Deck. Hosts the xterm.js terminal(s), sidebar, and all visual state. Talks to the outside world **only** through `window.api` — no direct Node, no direct IPC, no fs. Uses a polymorphic `<ViewRouter>` main pane (Terminal, Tasks, Focus tabs) plus a project/workspace sidebar.

## What belongs here

- React components, JSX, hooks
- xterm.js `Terminal` instances + FitAddon + ResizeObserver wiring
- Per-project UI state (active project, session state machine, restart banner visibility)
- CSS files under `src/renderer/src/assets/`
- Keyboard shortcut handlers (Ctrl+1..9, Ctrl+Tab — MVP target, not yet implemented)

## What does NOT belong here

- **Node APIs** — no `require`, no `process`, no `fs`, no `path`. Use `window.api`.
- Direct `ipcRenderer` access — the preload script is the only allowed path
- pty.spawn / node-pty imports — renderer has no access and should not try
- File writes, environment reads — push to main via new IPC if truly needed
- Global state libraries (Redux / Zustand / Jotai / Recoil) — **deferred** to research item R6. Do not introduce before R6 closes.

## Key types / entry points

- `App.tsx` — top-level orchestrator. Loads projects via `window.api.project.list()`, renders Sidebar + ViewRouter.
- `window.api` — the entire IPC surface (see `src/preload/index.ts`). Always typed through `src/preload/index.d.ts`.
- `main.tsx` — React root mount. Standard React 19 pattern.
- `assets/deck.css` — visual theme. Uses `.deck-*` class prefix. Keep the prefix when adding styles.

## Layer-specific rules

- **All renderer effects that own external resources MUST return a cleanup function.** See `App.tsx` boot effect for the template (`disposed` flag after every `await`, null checks before dispose, reverse-order cleanup). This is not optional — xterm / pty / ResizeObserver leaks corrupt later sessions.
- **One `Terminal` instance per project tab, mounted exactly once.** Switching tabs hides/shows, never disposes. The whole point of Choda Deck is session persistence across switches.
- **xterm theme + font are fixed** for MVP: Cascadia Code 14pt, `#1e1e1e` bg, `#d4d4d4` fg. Theming is V2+. Do not add a theme picker.
- **Fit on mount AND on resize.** `fitAddon.fit()` is called after `term.open()` and again from the ResizeObserver callback. Skip either and the pty gets wrong cols/rows.
- **Propagate resize all the way to the pty.** ResizeObserver → `fitAddon.fit()` → read `term.cols` / `term.rows` → `window.api.pty.resize(id, cols, rows)`. Never skip the last step.
- **Await every `window.api.pty.spawn` before attaching listeners.** Listeners attached before spawn completes can miss the first bytes.
- **Use `React.JSX.Element` as the return type** on function components — project convention, see `App.tsx:7`.
- **No inline styles beyond trivial overrides.** Use the `.deck-*` CSS classes.
- **Keyboard shortcuts** (when implemented) go through a single top-level listener — do not attach per-tab keydown handlers that would fire while tab is backgrounded.

## Architectural note — polymorphic view container

The MVP target is not "one xterm per project" but a polymorphic `<ViewRouter>` that picks a view type per project. V2+ adds `note`, `tasks`, `adr`, `memory`, `graph` view types. When touching the renderer structure:

- Leave room for multiple view types. Don't bake "terminal" into component names if it would block a future `note` view.
- The xterm instance is a detail of the `terminal` view type, not of the main pane.
- Tab persistence (mount-once) applies to all view types, not just terminal.

Concrete: a refactor that introduces `<ProjectWorkspace>` + `<ViewRouter>` + `<TerminalView>` is the intended MVP shape. A refactor that hardcodes "Terminal" into the sidebar or main pane is a step backwards even if it works.

## Research items affecting this layer

- **R1** — xterm.js TUI fidelity. Alt-screen, mouse, bracketed paste edge cases may require xterm addon changes or Terminal options tweaks.
- **R4** — Resize propagation. Debounce + font-ready wait pattern belongs here, not in main.
- **R6** — State management. Affects every component organizing cross-project state.

Read the relevant R item in `docs/research.md` before making structural changes in those areas.
