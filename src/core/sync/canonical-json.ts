/**
 * Deterministic JSON serializer for content-stable hashing and file output.
 *
 * Guarantees on the output bytes:
 * - Object keys sorted alphabetically (recursively)
 * - LF (`\n`) line endings only — never CRLF
 * - 2-space indent
 * - Trailing newline
 * - `undefined` properties dropped
 * - Same string for the same logical value across Node versions and OSes
 *
 * Throws on `NaN`, `Infinity`, functions, or symbols. Caller must hand off
 * already-cleaned data.
 *
 * The same serializer must be used both for hashing AND for writing files
 * to disk so the hash never disagrees with what hits disk.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, 0) + '\n'
}

const INDENT = 2

function serialize(v: unknown, depth: number): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number ${v}`)
    return JSON.stringify(v)
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return serializeArray(v, depth)
  if (typeof v === 'object') return serializeObject(v as Record<string, unknown>, depth)
  throw new Error(`canonicalJson: unsupported type ${typeof v}`)
}

function serializeArray(arr: unknown[], depth: number): string {
  if (arr.length === 0) return '[]'
  const inner = ' '.repeat((depth + 1) * INDENT)
  const close = ' '.repeat(depth * INDENT)
  const items = arr.map((item) => inner + serialize(item, depth + 1))
  return '[\n' + items.join(',\n') + '\n' + close + ']'
}

function serializeObject(obj: Record<string, unknown>, depth: number): string {
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  if (keys.length === 0) return '{}'
  const inner = ' '.repeat((depth + 1) * INDENT)
  const close = ' '.repeat(depth * INDENT)
  const lines = keys.map(
    (k) => `${inner}${JSON.stringify(k)}: ${serialize(obj[k], depth + 1)}`
  )
  return '{\n' + lines.join(',\n') + '\n' + close + '}'
}
