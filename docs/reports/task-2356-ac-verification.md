# TASK-2356 — AC verification

`choda-deck improve measure <workspace>`: `src/adapters/cli/improve-command.ts` (Playwright
driver + shell) and `src/core/domain/improve/measure-{engine,runner}.ts` (pure scorecard +
orchestration). Measured for real against choda-deck-companion at `3e94f53`.

## Done — 6/7

| # | Criterion | Evidence |
|---|---|---|
| 0 | `mode: off` / no config → exit 0, no file | `improve measure main` (no `.choda/improve.json`) → `skipped`, exit 0, no `improve/main/`; unit tests cover `mode: off` |
| 2 | >1% pixel change → `uiChanged: true`; identical → `false` | engine tests: 50/10,000 px = 0.005 (not changed), 200/10,000 = 0.02 (changed), size change = 1; runner test flags only the changed page |
| 3 | Companion output: test rate, LCP `/projects`, console count, 3 PNGs on disk | real run: tests 975/975 (rate 1), `/#/projects` LCP 156–232 ms, console errors 0, `2026-10-10/{sync,projects,activity}.png` exist |
| 4 | No model client / no `claude` spawn in the improve modules | test `no improve module imports an AI client or spawns claude`. It caught a comment of mine on its first run, so it does fail |
| 5 | Nothing listens on the port of an app the command started | every real run started `pnpm dev` itself (5173 was down); `netstat` shows 0 listeners on 5173 afterwards (Windows tree kill via `taskkill /T`) |
| 6 | `build:cli` works; `improve measure --help` prints usage | `dist/cli.cjs` with `--external:playwright`; help printed, exit 0 |

## Not done — 1

**AC-1, two runs on the same commit: equal deterministic fields, `uiChanged: false`, LCP ≤20%.**
Most of it holds: across 4 run pairs the screenshots, console counts and flow results were
equal, and every second run had `uiChanged: false` on every page. Two parts are at the mercy
of noise this command does not control:

- **LCP.** At 150–230 ms on the vite dev server, back-to-back runs moved up to 40%
  (`/#/sync` 160 → 224 ms) even after adding a warm-up pass over every page, a per-page
  warm-up load, and the median of 5 loads. With one sample the swing reached 55%. Other pairs
  stayed within 2–20%.
- **Tests.** One run out of 8 got 825/827. The companion suite has an intermittent 2-test
  failure, and it also happens with no dev server alongside. A real run that hits it records
  it correctly, so the scorecard is right and the test counts differ between runs.

The criterion needs a decision, not more code: an absolute LCP tolerance (for example ±50 ms
or ±20%, whichever is larger), or measuring a `vite build && vite preview` bundle instead of
the dev server.

## Findings

- **Run tests before starting the app.** The first real run started the dev server and then
  ran the suite, and 2 timing-sensitive companion tests failed (825/827). With tests first,
  runs reach 975/975.
- **`pnpm add` runs `prepare`**, which rebuilt `dist/companion-server.cjs` (the bundle the
  companion service runs) and rewrote `docs/adapter-bundle-size.md`. The recorded size
  (10.32 MB at `286fb43`, the improve routes) is accurate and is committed here.
- **`activity-command.test.ts` bundles the CLI with its own externals list**, which had to
  learn `playwright` too. Any new runtime-only dependency of the CLI needs adding in both
  places.
- **`axe:` measures validate but are not measured yet.** They score `null` with a note;
  nothing in the plan uses them.
- The scorecard now names failing tests (`tests.failures`, from vitest `FAIL` lines), so a
  flaky suite shows up as names rather than a bare count.
