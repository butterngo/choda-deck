import { defineConfig } from 'vitest/config'
// Shared with scripts/test.mjs, which asserts every file matched here actually ran.
import { INCLUDE } from './scripts/lib/test-files.mjs'

export default defineConfig({
  test: {
    include: INCLUDE,
    globals: true,
    // Detects Docker once per run for the Postgres harness (TASK-2473).
    globalSetup: ['src/test/pg-docker-global-setup.ts'],
    // Linux CI runners hit beforeEach > 10s under parallel test pressure
    // (mkdtempSync + new Database + initSchema runs many DDL + ALTER statements).
    // Local Windows runs comfortably under 1s; this is purely a ceiling for slow
    // shared CI hardware, not a real per-hook expectation.
    hookTimeout: 30000,
    testTimeout: 15000,
    // TASK-2634 — cap the fork pool. Uncapped, vitest starts cores-1 workers (15
    // on a 16-core laptop) and the full suite took ~63 s there; at 8 it takes
    // ~38 s. CI runners have fewer cores, so the cap does not bind there.
    //
    // The cap does NOT stop the "Worker exited unexpectedly" drops. Those are a
    // native abort in the worker (exit 0xC0000409) from Node 24.15.0 on Windows:
    // ~1 run in 3 dropped a worker on 24.15.0, 0 in 8 on 24.14.0 and 0 in 8 on
    // 24.22.1, same code. Run the suite on a Node other than 24.15.0.
    maxWorkers: 8
  }
})
