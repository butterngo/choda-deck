// `prepare` lifecycle hook — build dist/ on install (TASK-1102).
//
// pnpm runs `prepare` on every `pnpm install` AND on `pnpm prune`. The Docker
// build hits both at points where a build is impossible, so this guards instead
// of building unconditionally (TASK-1579):
//
//   Dockerfile install — runs before `COPY src ./src`, so there is no source yet.
//   Dockerfile prune   — runs after devDependencies are stripped, so no esbuild.
//
// Both must no-op rather than fail; the image builds dist/ via an explicit
// `pnpm run build` once src/ is present. A normal local install has both and
// still gets the build TASK-1102 asked for.

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const entrypoint = fileURLToPath(new URL('../src/adapters/mcp/server.ts', import.meta.url))
const hasSources = existsSync(entrypoint)

let hasEsbuild = true
try {
  require.resolve('esbuild')
} catch {
  hasEsbuild = false
}

if (!hasSources || !hasEsbuild) {
  const missing = [!hasSources && 'src/', !hasEsbuild && 'esbuild'].filter(Boolean).join(' + ')
  console.log(`[prepare] skipping build — ${missing} not available (expected during the Docker build)`)
  process.exit(0)
}

const result = spawnSync('pnpm', ['run', 'build'], { stdio: 'inherit', shell: true })
process.exit(result.status ?? 1)
