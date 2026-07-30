import { spawnSync } from 'child_process'
import { globSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { INCLUDE, toRelPosix, parseFilters, matchesFilters, findMissing } from './lib/test-files.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')
const argv = process.argv.slice(2)

// Watch mode never exits, so there is no completed run to audit — passthrough.
const isRun = argv[0] === 'run'

if (!isRun) {
  const { status } = spawnSync(process.execPath, [vitest, ...argv], { cwd: root, stdio: 'inherit' })
  process.exit(status ?? 1)
}

const reportDir = mkdtempSync(join(tmpdir(), 'choda-test-report-'))
const reportPath = join(reportDir, 'run.json')

const { status } = spawnSync(
  process.execPath,
  [vitest, ...argv, '--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`],
  { cwd: root, stdio: 'inherit' }
)

const exitCode = status ?? 1

let ran = []
let reportRead = false
try {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  // jest-style shape (`testResults[].name`) is what the json reporter emits; the
  // `files[].filepath` branch keeps this working if that shape changes under us,
  // since a reporter change must not silently turn the guard into a no-op.
  const names = Array.isArray(report.testResults)
    ? report.testResults.map((r) => r.name)
    : Array.isArray(report.files)
      ? report.files.map((f) => f.filepath)
      : []
  ran = names.filter(Boolean).map((p) => toRelPosix(p, root))
  reportRead = true
} catch {
  // Report missing/unparseable — vitest died before writing it. The exit code is the
  // signal in that case; do not invent a second failure on top of it.
} finally {
  rmSync(reportDir, { recursive: true, force: true })
}

if (reportRead) {
  const filters = parseFilters(argv)
  const onDisk = INCLUDE.flatMap((pattern) => globSync(pattern, { cwd: root })).map((p) =>
    toRelPosix(p, root)
  )
  const expected = [...new Set(onDisk)].filter((p) => matchesFilters(p, filters))

  // An empty expected set means our substring model of the CLI filters did not match
  // the way vitest resolved them (a regex filter, or a flag value read as a
  // positional). Skipping beats failing a run that is actually fine.
  if (expected.length > 0) {
    const missing = findMissing(expected, ran)
    if (missing.length > 0) {
      console.error(
        `\n✖ ${missing.length} test file(s) exist on disk but never ran — the reported ` +
          `pass count covers ${ran.length} of ${expected.length} files:\n` +
          missing.map((p) => `    ${p}`).join('\n') +
          `\n\n  A file disappears from a run like this when its worker cannot start —\n` +
          `  most often a missing environment devDependency (see the '@vitest-environment'\n` +
          `  pragma at the top of the file). Check the unhandled errors above, then\n` +
          `  reinstall dependencies: pnpm install\n`
      )
      process.exit(1)
    }
  }
}

process.exit(exitCode)
