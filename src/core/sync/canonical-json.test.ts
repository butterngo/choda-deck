import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { canonicalJson } from './canonical-json'

describe('canonicalJson — properties', () => {
  it('sorts object keys alphabetically (recursively)', () => {
    const out = canonicalJson({ z: 1, a: { y: 2, b: 3 }, m: 4 })
    expect(out).toBe('{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "m": 4,\n  "z": 1\n}\n')
  })

  it('uses LF line endings only — never CRLF', () => {
    const out = canonicalJson({ a: 1, b: [1, 2, 3], c: { d: 4 } })
    expect(out).not.toMatch(/\r/)
  })

  it('ends with a trailing newline', () => {
    expect(canonicalJson({ a: 1 }).endsWith('\n')).toBe(true)
    expect(canonicalJson([]).endsWith('\n')).toBe(true)
    expect(canonicalJson({}).endsWith('\n')).toBe(true)
  })

  it('drops undefined properties (parity with JSON.stringify)', () => {
    const out = canonicalJson({ a: 1, b: undefined, c: 3 })
    expect(out).toBe('{\n  "a": 1,\n  "c": 3\n}\n')
  })

  it('preserves array order (caller-controlled)', () => {
    const out = canonicalJson([3, 1, 2])
    expect(out).toBe('[\n  3,\n  1,\n  2\n]\n')
  })

  it('renders empty containers compactly', () => {
    expect(canonicalJson({ empty: {}, list: [] })).toBe('{\n  "empty": {},\n  "list": []\n}\n')
  })

  it('escapes strings via standard JSON encoding', () => {
    const out = canonicalJson({ s: 'a"b\nc\\d' })
    expect(out).toBe('{\n  "s": "a\\"b\\nc\\\\d"\n}\n')
  })

  it('round-trips Unicode via JSON.stringify (BMP and astral)', () => {
    const out = canonicalJson({ u: '→ é 中 🌟' })
    expect(JSON.parse(out).u).toBe('→ é 中 🌟')
  })

  it('throws on NaN', () => {
    expect(() => canonicalJson({ x: NaN })).toThrow(/non-finite/)
  })

  it('throws on Infinity', () => {
    expect(() => canonicalJson({ x: Infinity })).toThrow(/non-finite/)
  })

  it('is deterministic — two runs on same input produce identical bytes', () => {
    const input = { z: 1, a: [{ b: 2 }, { c: 3 }], m: { y: 4, x: 5 } }
    expect(canonicalJson(input)).toBe(canonicalJson(input))
  })

  it('is order-invariant — same logical object with shuffled keys produces identical bytes', () => {
    const a = { x: 1, y: 2, z: 3 }
    const b = { z: 3, x: 1, y: 2 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })
})

describe('canonicalJson — cross-platform invariance (AC #12d)', () => {
  // Fixture exercises sorted keys at depth, escaped strings, unicode, all primitive types,
  // empty containers, and nested arrays of objects. SHA-256 below is the canonical hash
  // of canonicalJson(FIXTURE) — independent of the OS / Node version this test runs on.
  // If this hash changes, the canonical-JSON serializer changed (intentionally or not).
  // Schema additions to choda-deck domain types do NOT touch this fixture.
  const FIXTURE = {
    zebra: [3, 2, 1],
    alpha: {
      nested: { z: null, a: 'value' },
      arr: [
        { b: 2, a: 1 },
        { d: 4, c: 3 }
      ]
    },
    string_with_quotes: 'He said "hi"',
    unicode: '→ é 中',
    integer: 42,
    float: 3.14,
    bool_t: true,
    bool_f: false,
    nullval: null,
    empty_obj: {},
    empty_arr: []
  }

  it('produces a stable SHA-256 across platforms', () => {
    const out = canonicalJson(FIXTURE)
    const hash = createHash('sha256').update(out, 'utf8').digest('hex')
    expect(hash).toBe('bfd82a40a0763bfc078d563fc8fb00c3d536ef66b79ab9bcc905267b4b0389df')
  })
})
