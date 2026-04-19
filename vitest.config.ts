import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true
    // Use `// @vitest-environment jsdom` docblock in .tsx test files
    // (environmentMatchGlobs has path issues on Windows)
  }
})
