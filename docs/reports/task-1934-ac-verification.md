# TASK-1934 — AC verification

**Adapter: the fence parser + POST /workspace-docs/diagram/check**
Session SESSION-1789036239404-32 · branch `feat/task-1934-mermaid-fence-check` · PR #287
Verified 2026-09-10 by the `/choda-burn-backlog` runner (unattended).

**Result: 4 / 5 ticked. AC-5 fails as written and is NOT reinterpreted. Task held at IMPLEMENTED.**

## Per criterion

### AC-1 (machine) — both real defects refused, both repairs accepted ✅

Evidence: `src/adapters/companion/mermaid-check.test.ts`, four tests driving the live route.

| input | verdict |
|---|---|
| `H-->>LA: PageResult&lt;AccountListItem&gt;` | `ok:false`, `line: 4` |
| the same with `#lt;`/`#gt;` (CONTROL) | `ok:true` |
| `SS[SecretStore\n{{secrets.KEY}}]` | `ok:false` |
| the same, label quoted (CONTROL) | `ok:true` |

Both fixtures are verbatim copies of the diagrams that failed in
`C:\dev\mantu\ABCV2\docs\knowledge` on 2026-09-10.

**The controls were not ceremony.** The flowchart pair went red on the first run:
mermaid needs a DOM to parse flowchart labels (DOMPurify), so *both* halves
returned `ok:false` — a checker that answers identically for every input, while
looking correct. See "Findings" below.

### AC-2 (machine) — free, keyless, offline ✅

Evidence: a recording wrapper over `globalThis.fetch`; after a successful check the
recorded calls, filtered to anything not addressed to the test's own local server,
is `[]`. Status 200 with `ok:true` and no key file anywhere in the fixture
environment.

### AC-3 (machine) — three fences located in the real document ✅ (with a stated divergence)

Evidence: `listMermaidFences` over
`src/adapters/companion/__fixtures__/adr-pure-mcp-tools-as-module-adapter.md`
returns 3 fences; for each, `lines.slice(start - 1, end).join('\n') === code`, and
no slice starts or ends with a ``` marker. Fence 0 begins `sequenceDiagram`,
fence 2 begins `flowchart TD`. A document with no fence returns `[]` (control).

**Divergence, stated rather than hidden:** the criterion says "the real
`adr-pure-mcp-tools-as-module-adapter.md`". That file lives in another repository
(`C:\dev\mantu\ABCV2`); a test reading it would pass here and fail on any other
machine and in CI. It is therefore checked in as a **byte-for-byte copy**. The
bytes are real; the path is not the original. This is a workaround, not a
reinterpretation of what the criterion asks.

### AC-4 (machine) — CRLF is found, not silently skipped ✅

Evidence: the same fixture re-joined with `\r\n` yields the same fence count and a
byte-identical first fence body; a CRLF fence parses, i.e. no `\r` reaches the
grammar. The CRLF input is built by explicit joining rather than by committing a
CRLF file, which git may normalise on checkout — a committed fixture would
quietly become LF and the test would pass while proving nothing.

### AC-5 (machine) — bundle growth ≤ 4.5 MB, figures recorded ❌ FAILS

```
dist/companion-server.cjs   before:    723,288 bytes   (main, before this branch)
                            after:  10,723,340 bytes
                            growth: 9.54 MB            cap: 4.5 MB
```

Half the criterion is satisfied: the before/after byte counts are recorded, in the
commit message and here. The cap is not.

**Why the cap was wrong.** It came from TASK-1931's discovery, which measured an
esbuild probe of a bare `mermaid.parse` entry **with `--minify`** and got 3.34 MB.
`pnpm run build:companion` does not minify. And `happy-dom` — needed for the DOM
fix below — was not known to be part of the cost at all when the number was
written.

The number was mis-derived at planning time, and the body locked at IN-PROGRESS
before that was discoverable. **The criterion has not been edited to make it
pass.** It stands, failed, and the task stays at IMPLEMENTED.

## Findings

1. **"`mermaid.parse` runs in plain node with no DOM" is only half true**, and the
   half that is false is the dangerous one. `sequenceDiagram` parses; `flowchart`
   dies on `DOMPurify.addHook is not a function` because flowchart labels are
   sanitised. The discovery measured it under vitest's jsdom environment in the web
   package and recorded a conclusion that environment had already provided for it.

   The failure presents as a **rejection**, so without a paired control it is
   invisible: every flowchart, broken or not, comes back `ok:false` and the route
   looks like it is working. Fixed with a lazy `happy-dom` window (`ensureDom`).

2. **Route registration order is load-bearing.** `/workspace-docs/diagram/check`
   matches the docs route's `FILE_ROUTE_PREFIX`; registered second it is read as
   `workspaceId="diagram", rel="check"` and answers 404 for an unknown workspace —
   a wrong answer that looks like a missing workspace rather than a shadowed route.
   Pinned by a test.

3. **The full suite reports `Errors: 1`** — `[vitest-pool]: Worker forks emitted
   error`, 156 of 157 files, 2078 tests passed and 0 failed. This is the documented
   worker-death flake, distinct from the PTY flake recorded in the inbox on
   2026-09-09. Both `mermaid-check.test.ts` and `pty-session.test.ts` ran green in
   this run.

## Needs a decision (not a defect to paper over)

Getting under any sane size cap means **not bundling** mermaid and happy-dom —
`--external:mermaid --external:happy-dom`, resolved at runtime from the vendored
`resources/adapter/node_modules`. That changes the packaging contract and belongs
with TASK-1938 (release + vendoring), so the runner did not do it unilaterally.

Until that is decided, AC-5 stays unticked and TASK-1934 stays IMPLEMENTED.
