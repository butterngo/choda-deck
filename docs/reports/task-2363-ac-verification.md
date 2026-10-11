# TASK-2363 — AC verification

`lcpStable(a, b)` (max(50 ms, 20% of the smaller)) and `lcpPairStable(before, after, config)`
in `src/core/domain/improve/measure-engine.ts`: the tolerance TASK-2356 AC-1 lacked, checked
only on the pages the config scores for LCP.

## The criterion changed once, with Butter's approval

The first draft's unit-test example, "160 vs 224 ms → stable", contradicted the approved formula
(64 ms > max(50, 32) = 50 ms). A first set of 6 runs (2026-10-11, 02:46–02:57) then showed
`/#/sync` failing the tolerance even in a clean pair (176 → 252 ms), while `/#/projects`, the only
page with an `lcp:` criterion, passed every pair. Two of those runs overlapped other work: an
improve run started through the companion, and the 0.18.6 release build. The runner stopped and
asked. Butter chose: require stability only on pages named by an `lcp:` criterion, and correct
the example. The task body records both changes.

## Done — 3/3

Measured on companion `59c5fc6`, 6 back-to-back runs (03:19–03:30) with port 5173 free and no
other measure, build or improve run in flight. The config scores LCP on `/#/projects` only.

| Pair | `/#/projects` (scored) | console, screenshots, flows equal | 2nd run `uiChanged` | `/#/sync` (not scored) |
|---|---|---|---|---|
| 1–2 | 196 / 204 ✅ | yes | false, false, false | 276 / 272 |
| 3–4 | 192 / 220 ✅ | yes | false, false, false | 268 / 276 |
| 5–6 | 184 / 224 ✅ | yes | false, false, false | 276 / 292 |

| # | Criterion | Evidence |
|---|---|---|
| 0 | `lcpStable` with the four examples | `measure-engine.test.ts`: 160/200 stable, 160/224 not, 1000/1190 stable, 1000/1260 not; symmetric and exact at 100/150 vs 100/151. `lcpPairStable` drops unscored pages, and its controls fail a moved page and a missing reading |
| 1 | 3 clean pairs: every `lcp:`-scored page passes | the table above; worst pair is 184/224 (40 ms ≤ 50) |
| 2 | Same pairs: equal console counts, flow results and screenshot names; 2nd run `uiChanged: false` | the table above |

## Findings

- **Interference, not the dev server, caused most of the noise.** Without concurrent work,
  `/#/sync` also stayed within tolerance (worst 276/292). The earlier 40% swings coincided with
  other runs on the machine. An unattended measure should not share the machine with a build.
- **`tests` still differ between runs.** Runs 1–2 report 843/845 instead of 993/993: the
  companion's intermittent `DocDiagrams` pair, plus a total that drops to 845 when it happens. Not
  part of this criterion.
- Gates: typecheck; improve tests 33/33; lint 0 errors; `build:cli` ok. The full suite failed only
  the documented `mermaid-check` / `workspace-diagram` timing flakes; one rerun failed too, the
  next passed 29/29. They are now flaky under load more often than before.
