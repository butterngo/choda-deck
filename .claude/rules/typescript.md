---
paths:
  - '**/*.ts'
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

Run `pnpm run format` before committing if unsure. Do not fight prettier.

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

## SOLID principles (enforced)

Apply SOLID when designing/refactoring modules. These are the practical checks for this codebase:

### S — Single Responsibility

One class / one module = one reason to change. `src/tasks/repositories/` is the canonical example: each repository owns exactly one table family (task, phase, feature, conversation, …) — the facade `SqliteTaskService` composes them.

Red flags that signal an SRP violation:

- A class touches more than one table (or more than one HTTP endpoint, or more than one IPC namespace) outside a thin facade.
- A file mixes row mappers, SQL, business rules, and filesystem I/O.
- A method name contains "and" or "or" — usually two responsibilities glued together.

### O — Open/Closed (via composition, not inheritance)

New functionality = new module, not editing existing ones. When adding an M1 domain (Session, Context, Conversation) we added new repositories, did **not** extend an existing class. Prefer composition (facade holding repos) over deep class hierarchies.

### L — Liskov

Rarely an issue here (no deep class trees). If you subclass, the subclass must be substitutable — don't narrow preconditions or widen postconditions.

### I — Interface segregation

Per-domain interfaces live in `src/tasks/interfaces/` — one per operation cluster (`TaskOperations`, `PhaseOperations`, `ConversationOperations`, `Lifecycle`, …). The composite `TaskService` interface extends them. Consumers depend on the narrow interface they need, not the fat one.

When adding a new domain: add its own `*-repository.interface.ts` file, do **not** bolt methods onto `TaskService` directly.

### D — Dependency inversion

High-level code depends on abstractions. The facade references interfaces (`TaskService`, `SessionOperations`, …), not concrete repository classes from outside the `repositories/` folder. The concrete wiring happens **only** in the facade constructor.

## File + method length limits

These are guidelines, not hard CI gates — but treat exceeding them as a refactor signal, not a free pass.

| Unit                | Soft limit | Hard limit | If exceeded                                              |
| ------------------- | ---------- | ---------- | -------------------------------------------------------- |
| File (`.ts`/`.tsx`) | 200 lines  | 300 lines  | Split by responsibility (see Repository pattern example) |
| Class               | 150 lines  | 250 lines  | Extract helpers or split into composed classes           |
| Function / method   | 30 lines   | 60 lines   | Extract private helpers; name each intent                |
| Interface           | 10 methods | 20 methods | Segregate per I principle above                          |

Exceptions (flag in code comment):

- Schema DDL files (`repositories/schema.ts`) — many table definitions are ok in one place; splitting fragments the source of truth.
- Pure type definitions (`task-types.ts`) — data shapes don't need per-file splitting.

## Lint

ESLint config is `@electron-toolkit/eslint-config-ts` + `eslint-config-prettier`. Run `pnpm run lint` before considering TypeScript work done.
