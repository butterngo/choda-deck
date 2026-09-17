# Adapter bundle size

Written by `scripts/record-bundle-size.mjs` on every `pnpm run build:companion`.
`dist/` is gitignored, so this file is the only record of the size that does not
require a rebuild — see TASK-1941 AC-3.

| Field | Value |
|-------|-------|
| `dist/companion-server.cjs` | **10,759,172 bytes** (10.26 MB) |
| Recorded | 2026-09-17 |
| Commit | `c38fa4b` |

## What drives this number

mermaid (11.x) and happy-dom are **bundled**, not external — decided in TASK-1941
on four measurements, and the size here is the smaller half of that decision:

- external would cut this file to ~732 KB but ship ~99 MB of loose package files,
  costing **+5.44 MB** in the compressed installer (1.28 MB → 6.73 MB at 7z mx=9);
- and it would turn the first `/diagram/check` after an install from **71 ms**
  into **71 seconds**, because node would walk mermaid's 22-dependency graph
  across those loose files instead of reading one inlined blob.

So a large number in the table above is the intended state. What is worth
investigating is a **change** to it: if this figure jumps in a PR diff, something
new reached the adapter's import graph.
