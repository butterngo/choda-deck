import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globals: true,
    // Linux CI runners hit beforeEach > 10s under parallel test pressure
    // (mkdtempSync + new Database + initSchema runs many DDL + ALTER statements).
    // Local Windows runs comfortably under 1s; this is purely a ceiling for slow
    // shared CI hardware, not a real per-hook expectation.
    hookTimeout: 30000,
    testTimeout: 15000
  }
})
