# TASK-2368 — AC verification

The Improve tab's Run now produced a 0-byte log even when the run worked. Cause, reproduced
outside the service with the same spawn shape and a one-line prompt: `detached: true` on Windows
starts the child with `DETACHED_PROCESS`, i.e. no console, and claude then writes nothing to the
inherited log handle (0 bytes). Without it the same call logged `pong`. cmd.exe's own error text
still reached the file, which is why the earlier "'claude' is not recognized" log was not empty
and hid the problem.

Fix (`src/adapters/companion/improve.ts`): `runSpawnOptions` never detaches on Windows. A Windows
child outlives its parent anyway, and `unref()` plus `windowsHide` keep it in the background. Runs
now start in the choda-deck checkout that owns the data dir (`improveRunCwd`: `<repo>/data/artifacts`
→ `<repo>`) instead of the service's `C:\Windows\System32`.

## Done — 3/3

| # | Criterion | Evidence |
|---|---|---|
| 0 | After Run now from the service, `GET /improve/:ws/runs/:id` returns a non-empty `log` with the final `improve-loop <ws>:` line | adapter rebuilt from this branch, service restarted, `POST /improve/choda-deck-companion/run` → run `684a2a71…` ended exit 0 with a 432-byte log starting `improve-loop choda-deck-companion: 2026-10-11 · evaluator skipped · 1 proposal (INBOX-2200) · running` |
| 1 | The run's working directory is the choda-deck repo root (transcript folder `C--dev-choda-deck`) | transcript `c--dev-choda-deck/513d1405…jsonl`, first `cwd` `C:\dev\choda-deck`, started 03:58:01 right after the restart. The previous run's transcript sat under `C--Windows-System32` |
| 2 | A run whose claude cannot start still writes its error into the log | the real `spawnClaudeRun`, bundled and run outside vitest with `CHODA_CLAUDE_CMD` pointing at a `.cmd` that prints `cannot start: boom` to stderr and exits 3 → `exit 3 | log: cannot start: boom` |

Unit tests: `runSpawnOptions` (win32 → `detached: false`, `cwd` set; linux → still detached) and
`improveRunCwd` + the route passing it to the spawner. `improve.test.ts` 17/17, full suite
185 files green.

## Findings

- **A real-spawn test cannot live in the suite.** A test calling `spawnClaudeRun` against a fake
  `.cmd` passed alone but made vitest's fork worker exit unexpectedly in a full run ("Worker forks
  emitted error"), silently dropping `improve.test.ts`: 184 files instead of 185, with exit 1. With
  the test skipped, the same folder ran 53/53 with exit 0. It was moved to the out-of-suite probe
  above. The companion service itself survived a full run: same PID before and after.
- **A service restart mid-run loses the rest of the log.** In the probe, a parent that exited
  before its child left the log empty. The service is long-lived, so this only matters if it
  restarts while a run is in progress.
- The cwd change does not move the token budget: the TASK-2366 quiet-day measurement (37,936) was
  already taken from `C:\dev\choda-deck`.
- This live run filed **INBOX-2200** ("Stop the last project row from being clipped"). TASK-2366's
  run B had dropped the same idea as a viewport artifact, so the loop is not consistent about it.
- 0.18.6's bundled adapter has neither this nor TASK-2366; the app's own Run now picks both up in
  the next companion release.
