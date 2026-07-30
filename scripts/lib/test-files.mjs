// Single source of truth for which files are test files, shared by vitest.config.ts
// (which globs them) and scripts/test.mjs (which asserts every one of them actually
// ran). Keeping both sides on one constant is the point — a drifting second copy of
// these patterns would silently re-open the hole this guard exists to close.
//
// Why the guard exists: a vitest worker that cannot start (missing environment
// devDependency, e.g. the `// @vitest-environment happy-dom` files under
// extension/lib) drops its test file from the run entirely. The summary line then
// reads "Test Files 10 passed (10)" — green to any human or agent reading output —
// while two files were never executed. vitest does exit non-zero in that case, but an
// exit code is easy to lose (a `| tail` in the invoking shell masks it), and a file
// dropped without an error would not be caught at all. Comparing what ran against
// what exists on disk catches both.

export const INCLUDE = ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'extension/**/*.test.js']

/** Normalize a path to forward slashes, relative to root when absolute. */
export function toRelPosix(filePath, root) {
  const posix = String(filePath).replace(/\\/g, '/')
  const base = String(root).replace(/\\/g, '/').replace(/\/$/, '')
  const lowered = posix.toLowerCase()
  const loweredBase = base.toLowerCase()
  // Windows paths differ in drive-letter case between vitest's report and process.cwd().
  return lowered.startsWith(loweredBase + '/') ? posix.slice(base.length + 1) : posix
}

/**
 * Split a vitest argv into the positional file filters, dropping the mode verb and
 * any flags. Values attached with `=` stay on their flag, so only bare positionals
 * survive — the same things vitest itself treats as file filters.
 */
export function parseFilters(argv) {
  return argv.filter((arg, i) => {
    if (arg.startsWith('-')) return false
    if (i === 0 && (arg === 'run' || arg === 'watch' || arg === 'related')) return false
    return true
  })
}

/**
 * vitest treats a positional as a match when it appears anywhere in the test file's
 * path. Substring semantics only — a filter written as a regex is not modelled here,
 * which is why the caller falls back to skipping the guard rather than failing when
 * this model produces an empty expected set (see scripts/test.mjs).
 */
export function matchesFilters(relPath, filters) {
  if (filters.length === 0) return true
  const lowered = relPath.toLowerCase()
  return filters.some((f) => lowered.includes(f.replace(/\\/g, '/').toLowerCase()))
}

/** Test files present on disk but absent from the run — the silent-skip set. */
export function findMissing(expected, actual) {
  const ran = new Set(actual.map((p) => p.toLowerCase()))
  return expected.filter((p) => !ran.has(p.toLowerCase())).sort()
}
