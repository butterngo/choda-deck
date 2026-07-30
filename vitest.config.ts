import { defineConfig } from 'vitest/config'
// Shared with scripts/test.mjs, which asserts every file matched here actually ran.
import { INCLUDE } from './scripts/lib/test-files.mjs'

export default defineConfig({
  test: {
    include: INCLUDE,
    globals: true,
    // Linux CI runners hit beforeEach > 10s under parallel test pressure
    // (mkdtempSync + new Database + initSchema runs many DDL + ALTER statements).
    // Local Windows runs comfortably under 1s; this is purely a ceiling for slow
    // shared CI hardware, not a real per-hook expectation.
    hookTimeout: 30000,
    testTimeout: 15000
  }
})
