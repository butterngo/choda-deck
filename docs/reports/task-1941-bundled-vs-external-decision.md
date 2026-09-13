# Decision — the adapter keeps mermaid and happy-dom BUNDLED

**TASK-1941** · decided 2026-09-13 · measured at `ad53eeb` on Windows 11, node 24

**Decision: keep bundling. Do not add `--external:mermaid --external:happy-dom`.**

**The number that made the call: 71 ms versus 71,111 ms** — the first
`/diagram/check` after an install, bundled against external. The installer-size
figure pointed the same way (+5.44 MB for external) and would have been enough on
its own, but latency is the one a person feels, and it is three orders of magnitude.

---

## 1. What was actually compared

Both bundles built from the same source, same flags apart from the two `--external`
entries. Nothing here is quoted from an earlier report — the previous figure on
record (10,723,340) had drifted from the real file by 5,745 bytes, so everything was
re-derived.

| | bundled (kept) | external (rejected) |
|---|---|---|
| `dist/companion-server.cjs` | 10,729,085 B (10.23 MB) | 732,277 B (0.70 MB) |
| additional files to ship | none | **~99 MB loose** — mermaid 83 MB, happy-dom 16 MB |
| **compressed payload** (7z `mx=9`) | **1,346,244 B (1.28 MB)** | **7,053,561 B (6.73 MB)** |
| first `/diagram/check` — cold process, warm FS | 64–71 ms *(3 runs)* | 874–909 ms *(2 runs)* |
| first `/diagram/check` — cold process, **cold FS cache** | ~71 ms | **71,111 ms** |
| second call onward | 8–10 ms | 7–11 ms |
| esbuild time | 9.9 s | 29 ms |
| vendor step | unchanged | 2 trees + mermaid's 22 transitive deps |
| failure mode if mis-vendored | none | route 500s **only** in the packaged app |

## 2. Installer size — the premise in the task was wrong

TASK-1941 was filed saying *"installer total — roughly unchanged either way; the
bytes move, they do not vanish."*

They do not move. They **multiply**. esbuild tree-shakes mermaid's dependency graph
and emits one file containing only reachable code. The on-disk package tree carries
source maps, `.d.ts` declarations, duplicate ESM and CJS builds, tests and docs —
none of which the adapter ever loads, all of which a naive vendor step copies.

Compressed with the installer's own compressor, external costs **+5.44 MB**, or
**5.2× the bundled payload**.

**Why this was not measured by building two installers.** It could have been, at
roughly 40 minutes and two 200 MB artifacts. The compressed-payload comparison
answers the same question — electron-builder's NSIS target compresses with LZMA,
which is what `7z mx=9` is — and the difference measured (5.44 MB) is far outside
any plausible error from packaging overhead. If the two options had landed within
a megabyte of each other, the installers would have been worth building.

**Caveat, stated rather than buried.** 6.73 MB assumes a vendor copying both trees
whole. A pruned vendor (dist only) would land somewhere between 1.28 and 6.73 MB.
It cannot beat bundled — bundled already ships only reachable code — but the gap
would narrow. The latency gap would not narrow at all: that is module resolution,
not file size.

## 3. Latency — the decisive axis

Measured against a real adapter process over real HTTP, one fresh process per
measurement, with a `flowchart` (the diagram type that needs the DOM, so happy-dom
is exercised too; a `sequenceDiagram` would understate it).

- **Bundled: 64–71 ms.** One already-inlined blob is read.
- **External, warm FS cache: 874–909 ms.** ~13× slower.
- **External, cold FS cache: 71,111 ms — 71 seconds.**

The 71 s figure is not an outlier to be averaged away. It is the **first-ever read**
of those 99 MB, which is exactly the state of a machine right after the installer
runs, or after a reboot. A user installs the app, opens a document, checks a
diagram, and waits over a minute with nothing on screen explaining it.

**Confirmed in the shipped app, not only in the harness.** The running packaged
0.12.6 (PID 8484, port 63994, serving `resources/adapter/companion-server.cjs`)
answered its first check in **80 ms** and subsequent ones in 10–13 ms — independent
agreement with the bundled column, from the binary a user actually runs.

## 4. A correction this decision rests on

TASK-1931's report originally recorded *"first `/diagram/check` on a cold process
takes ~36 s … the cost lands on the user's first diagram check in the packaged
app."* **That was wrong**, and it was carried into this task's own body as an
argument.

The 36 s was measured under vitest, which resolves mermaid from `node_modules`
un-bundled — i.e. **the external configuration**. The shipped app pays 64–71 ms.

The figure turned out to be useful anyway: it was an accidental early measurement of
the option being rejected here. But it was written into two records as a property of
the product before anyone had started the real adapter, and doing so took four
minutes. Both records are now corrected.

## 5. Consequences

- **`build:companion` is unchanged** in its flags. It gained one step:
  `scripts/record-bundle-size.mjs`, which writes `docs/adapter-bundle-size.md` on
  every build so the size is answerable without rebuilding (AC-3). `dist/` is
  gitignored, which is how the earlier figure drifted unnoticed.
- **TASK-1938's vendor step is unchanged.** It was sequenced against this decision;
  bundling wins, so nothing there moves.
- **TASK-1934's AC-5 is superseded, not met** — left unticked with its disposition
  written into `docs/reports/task-1934-ac-verification.md`. Its 4.5 MB cap was
  mis-derived from a `--minify` probe against a build that does not minify, and
  happy-dom was never counted; the criterion is unsatisfiable as written, so
  ticking it would certify a threshold nobody validated.
- **No mitigation is needed for a cold-start warm-up.** The two ideas floated
  earlier — warming the import at boot, or having the client announce a first call —
  addressed a cost the bundled build does not pay. Both are dropped.
- **What to watch:** a jump in `docs/adapter-bundle-size.md` in a PR diff means
  something new reached the adapter's import graph. The size is intended to be
  large; a *change* to it is the signal.

## 6. How to reproduce

```bash
# bundled (current build, plus the size record)
pnpm run build:companion
cat docs/adapter-bundle-size.md

# external variant
npx esbuild src/adapters/companion/index.ts --bundle --platform=node \
  --target=node20 --format=cjs --outfile=dist/companion-external.cjs \
  --external:better-sqlite3 --external:sqlite-vec \
  --external:@huggingface/transformers --external:onnxruntime-node \
  --external:onnxruntime-web --external:sharp --external:node-pty \
  --external:mermaid --external:happy-dom

# compressed payloads
7z a -t7z -mx=9 bundled.7z  dist/companion-server.cjs
7z a -t7z -mx=9 external.7z dist/companion-external.cjs node_modules/mermaid node_modules/happy-dom
```

Latency: start each bundle as its own process with a temp `CHODA_DATA_DIR`, then
time the first `POST /workspace-docs/diagram/check`. **Say which filesystem-cache
state the number came from** — the first-ever read of the external tree cost 71 s
and every later run 0.9 s, and a measurement that does not distinguish them is
unreadable.
