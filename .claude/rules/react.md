---
paths:
  - 'src/renderer/**/*.tsx'
  - 'src/renderer/**/*.ts'
---

# React conventions — Choda Deck renderer

React 19 + TypeScript. Renderer is the **only** place React code lives — main and preload are plain Node. Patterns below are observed in `src/renderer/src/App.tsx`; follow them unless you have a concrete reason not to.

## Component style

- **Function components only.** No class components anywhere.
- **Return type annotated as `React.JSX.Element`** — see App.tsx:7: `function App(): React.JSX.Element`
- **No `React.FC`** — typed return value on the function is the project's choice
- **Named exports or `export default`** — App.tsx uses `export default App`. Follow existing file's convention when editing.

## Hooks

- `useState`, `useEffect`, `useRef` — the current surface. No `useReducer` / `useContext` yet (decision pending — see R6 in `docs/research.md`). **Do not introduce Redux / Zustand / Jotai without updating R6 first.**
- **`useRef` is used for imperative handles** to non-React objects (Terminal, FitAddon, ResizeObserver) — see App.tsx:8-10. This is correct for wrapping libraries like xterm.js that own their own DOM.
- **`useEffect` with empty deps** runs the boot sequence exactly once (App.tsx:14). Cleanup function (return) disposes everything. Follow this pattern for any effect that owns external resources.

## Cleanup discipline (non-negotiable)

Anything created inside an effect MUST be cleaned up in the effect's return function. The boot effect in App.tsx shows the pattern:

```ts
useEffect(() => {
  let disposed = false
  let cleanupData: (() => void) | null = null
  let cleanupExit: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null

  async function boot(): Promise<void> {
    // ... if (disposed) return after every await
  }
  boot().catch(...)

  return () => {
    disposed = true
    if (cleanupData) cleanupData()
    if (cleanupExit) cleanupExit()
    if (resizeObserver) resizeObserver.disconnect()
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
    }
  }
}, [])
```

Rules:

- **`disposed` flag** after every `await` in an async boot — prevents setState on unmounted component
- **Null checks before disposing** — cleanup may run before boot completes
- **Dispose in reverse creation order** — listeners first, resize observer, then terminal
- **Null out refs after disposal** so a re-mount starts clean

If you add a new resource (another listener, a timer, a subscription), add its cleanup to the return. No exceptions.

## Accessing Electron from the renderer

- **Only via `window.api`.** Never `require`, never `process`, never direct `ipcRenderer`. The preload bridge (`src/preload/index.ts`) is the entire allowed surface.
- `window.api.pty.*` — terminal session ops
- `window.api.project.*` / `task.*` / `phase.*` / `feature.*` / `vault.*` — feature-scoped namespaces (see `src/preload/index.ts`)
- Type definitions for `window.api` live in `src/preload/index.d.ts` — keep them in sync with `src/preload/index.ts`

## State management

MVP does NOT have a global state library yet. Decision deferred to research item **R6**.

For now:

- Local `useState` per component
- Props for parent→child
- Refs for imperative / non-reactive values

If a task needs cross-component state, surface the need — do not unilaterally introduce Context or Zustand. R6 closes that decision first.

## xterm.js integration

- **One `Terminal` instance per project tab.** Mount once, never recreate on switch.
- **Font:** `'Cascadia Code, Consolas, "Courier New", monospace'`, size 14 — see App.tsx:29-30. Match when adding new terminals.
- **Theme:** `{ background: '#1e1e1e', foreground: '#d4d4d4' }` — dark default. Theming is deferred (V2+).
- **FitAddon.fit()** is called after `term.open()` AND from the ResizeObserver. Do not skip either.
- **ResizeObserver → fitAddon → pty.resize** chain must stay intact. See R4 for known edge cases.

## CSS

- Plain CSS files imported at the module top (`./assets/deck.css`). No CSS-in-JS, no Tailwind. If adding styles, use the existing `.deck-*` class convention.
- xterm.js base CSS is imported from the package: `'@xterm/xterm/css/xterm.css'` — keep it.

## What NOT to do

- No class components
- No Redux / Zustand / Jotai / Recoil until R6 is closed
- No direct Electron / Node API access from renderer — use `window.api`
- No creating a second `Terminal` instance per tab
- No skipping cleanup in effects
