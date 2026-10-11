# TASK-2377 — AC verification

Fix 2 failing DocDiagrams tests (improve-loop proposal INBOX-2199, workspace choda-deck-companion).
Merged: companion PR #181 → `36f1552` (ancestry proven against `origin/main`).

## Done — 2/2

| # | Criterion | Evidence |
|---|---|---|
| 1 | Test pass rate: next `improve measure` shows all tests passing, value 1 | `improve measure choda-deck-companion` on `36f1552`: tests 1017/1017, failed 0, criterion value 1. The total grew from 845 since the proposal; the criterion is the rate. |
| 2 | Both DocDiagrams.test.tsx cases pass | Load repro (two full web suites + the file ×3 in parallel): before the fix 3/5 runs failed both cases; after, 10/10 green over two rounds. |

## Not done / needs a human

None.

## Root cause

The failure only appears under load. In a two-fence render, block `mermaid-7` was drawn by the vitest mock and block `mermaid-8` by the **real** mermaid package; its `dmermaid-8` scratch node was left in `<body>`. Evaluating the real 84 MB package blocked the event loop past the 10 s hook timeout (`Hook timed out in 10000ms` on "reports the index…"), RTL cleanup never ran, and the next test found two "Diagram 1" labels.

Pre-importing `mermaid` at the top of the test file did not help (2/5 still failed), so the registry itself served the real module to a later `import()`. Fix: `MermaidBlock` memoizes the import promise at module level, so every block on a page shares one import; a rejected import is not cached.

## Steps

1. `npx vitest run DocDiagrams.test.tsx` alone: passes, so the failure depends on timing.
2. Parallel load repro → reproduced and captured the DOM dump.
3. Fix → same load scenario ×2 rounds: 10/10 green, no `dmermaid` node in any output.
4. Gates: typecheck, lint, build exit 0; full web suite 863/863.

## Findings

- `pnpm run lint` was red on main since #152 (`no-useless-escape` in `MeetingSave.tsx`); fixed in the same PR with identical regex behaviour. The companion repo has no CI, so this went unnoticed.
- The same measure run shows **Console errors 0 → 2** on all three pages. It is unrelated to this change; the likely cause is the 0.19.0 `/inbox/pending` poll getting 401 without a bridge token. Filed as TASK-2399.
