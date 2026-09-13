// TASK-1941 AC-3 — write the adapter bundle's size where a reader finds it
// WITHOUT rebuilding.
//
// `dist/` is gitignored, so the built artifact itself is not a record: a month
// from now the only ways to answer "how big is the adapter?" are to rebuild it
// or to trust a number quoted in a task body. Both failed us on this very task —
// TASK-1934's report said 10,723,340 and the real file was 10,729,085, a drift
// nobody could see without rebuilding.
//
// So the number is written to a tracked file on every build:companion.
//
// Deliberately NOT a JSON blob: this is read by people, and a markdown table
// diffs legibly in a PR when the number moves. A jump in this file's diff is the
// signal that a dependency landed in the adapter.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "companion-server.cjs");
const OUT = path.join(ROOT, "docs", "adapter-bundle-size.md");

if (!fs.existsSync(BUNDLE)) {
  console.error(`[bundle-size] ${path.relative(ROOT, BUNDLE)} not found — run build:companion first`);
  process.exit(1);
}

const bytes = fs.statSync(BUNDLE).size;
const mb = (bytes / 1048576).toFixed(2);

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
} catch {
  // a build outside a git checkout still records the size; the sha is the extra
}

const date = new Date().toISOString().slice(0, 10);

const body = `# Adapter bundle size

Written by \`scripts/record-bundle-size.mjs\` on every \`pnpm run build:companion\`.
\`dist/\` is gitignored, so this file is the only record of the size that does not
require a rebuild — see TASK-1941 AC-3.

| Field | Value |
|-------|-------|
| \`dist/companion-server.cjs\` | **${bytes.toLocaleString("en-US")} bytes** (${mb} MB) |
| Recorded | ${date} |
| Commit | \`${commit}\` |

## What drives this number

mermaid (11.x) and happy-dom are **bundled**, not external — decided in TASK-1941
on four measurements, and the size here is the smaller half of that decision:

- external would cut this file to ~732 KB but ship ~99 MB of loose package files,
  costing **+5.44 MB** in the compressed installer (1.28 MB → 6.73 MB at 7z mx=9);
- and it would turn the first \`/diagram/check\` after an install from **71 ms**
  into **71 seconds**, because node would walk mermaid's 22-dependency graph
  across those loose files instead of reading one inlined blob.

So a large number in the table above is the intended state. What is worth
investigating is a **change** to it: if this figure jumps in a PR diff, something
new reached the adapter's import graph.
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, body);
console.error(`[bundle-size] ${bytes.toLocaleString("en-US")} bytes → ${path.relative(ROOT, OUT)}`);
