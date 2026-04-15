---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# TypeScript conventions — Choda Deck

These rules reflect what the code **actually** does (prettier config + observed patterns in `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`). Do not invent rules not grounded in the codebase.

## Formatting (from `.prettierrc.yaml` + `.editorconfig`)

- **Indent:** 2 spaces
- **Quotes:** single (`'`) — never double
- **Semicolons:** none at end of statements
- **Line width:** 100 columns
- **Trailing commas:** none
- **Line endings:** LF
- **Charset:** UTF-8
- **Final newline:** required

Run `npm run format` before committing if unsure. Do not fight prettier.

## Imports

- Absolute for packages (`import { app } from 'electron'`)
- Relative for in-repo (`import icon from '../../resources/icon.png?asset'`)
- Vite asset imports use `?asset` suffix (see main/index.ts line 4)
- Type-only imports allowed but not required — project uses mixed style

## Type declarations

- **Public API types → `interface`**, not `type`. Example: `ProjectConfig`, `WorkspaceConfig` in `src/preload/index.ts`
- Inline object types OK for local/private use
- **Return types are explicit on exported / public functions.** See preload/index.ts:
  ```ts
  spawn: (id: string, cwd: string, cols: number, rows: number): Promise<{ ok: boolean; id: string }> => ...
  ```
- Internal helpers may infer returns (e.g. `function createPtySession(...): void` is still annotated because it's called across scopes)

## Nullability + error handling

- Prefer `null` over `undefined` for "explicitly absent" refs (`useRef<T | null>(null)` — see App.tsx:8-10)
- No custom `Result<T>` pattern — errors thrown or returned in `{ ok: boolean, ... }` shape (see `pty.spawn` return)
- Fire-and-forget IPC on the main side uses `try { ... } catch { /* ignore */ }` only in shutdown paths (see `window-all-closed` in main/index.ts:131-137) — don't swallow errors elsewhere

## Module system

- ES modules throughout (`import`/`export`, not `require` in TS files)
- `package.json` has no explicit `"type": "module"`; electron-vite handles the bundling. Don't change this without reason.

## `any` / `unknown` / type assertions

- `process.env as { [key: string]: string }` is used once (main/index.ts:35) — specific, intentional cast where node-pty's env type is stricter than `process.env`. Do not broaden this pattern.
- `@ts-ignore` appears in preload/index.ts:50-53 for the non-isolated fallback path. Do not add new `@ts-ignore` lines without a comment explaining why.

## Naming

- **camelCase** for variables, functions, methods, props
- **PascalCase** for types, interfaces, React components
- **UPPER_SNAKE_CASE** for constants that represent stable config
- **No Hungarian notation**, no `I` prefix on interfaces (`ProjectConfig`, not `IProjectConfig`)

## Lint

ESLint config is `@electron-toolkit/eslint-config-ts` + `eslint-config-prettier`. Run `npm run lint` before considering TypeScript work done.
