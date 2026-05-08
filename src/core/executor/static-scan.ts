import * as fs from 'fs'

export interface ScanViolation {
  rule: string
  line: number
  excerpt: string
}

export interface ScanResult {
  ok: boolean
  violations: ScanViolation[]
}

const ONLY_RE = /(?:^|\W)test\.only\s*\(/
const SKIP_RE = /(?:^|\W)test\.skip\s*\(/
const UPDATE_SNAPSHOTS_RE = /--update-snapshots\b/
const RETRIES_RE = /\bretries\s*:\s*(\d+)\b/
const SOFT_RE = /(?:^|\W)expect\.soft\s*\(/
const JUSTIFY_RE = /\/\/\s*justify:/i

export function scanSpec(content: string): ScanResult {
  const violations: ScanViolation[] = []
  const lines = content.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1

    if (ONLY_RE.test(line)) {
      violations.push({ rule: 'test.only', line: lineNo, excerpt: line.trim() })
    }
    if (SKIP_RE.test(line)) {
      violations.push({ rule: 'test.skip', line: lineNo, excerpt: line.trim() })
    }
    if (UPDATE_SNAPSHOTS_RE.test(line)) {
      violations.push({
        rule: '--update-snapshots flag',
        line: lineNo,
        excerpt: line.trim()
      })
    }
    const retriesMatch = RETRIES_RE.exec(line)
    if (retriesMatch && parseInt(retriesMatch[1], 10) > 0) {
      violations.push({ rule: 'retries > 0', line: lineNo, excerpt: line.trim() })
    }
    if (SOFT_RE.test(line)) {
      const ctx = lines.slice(Math.max(0, i - 2), i + 1).join('\n')
      if (!JUSTIFY_RE.test(ctx)) {
        violations.push({
          rule: 'expect.soft without // justify: comment',
          line: lineNo,
          excerpt: line.trim()
        })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

export function scanSpecFile(filePath: string): ScanResult {
  const content = fs.readFileSync(filePath, 'utf8')
  return scanSpec(content)
}

export function formatViolations(violations: ScanViolation[]): string {
  return violations.map((v) => `  - L${v.line} [${v.rule}] ${v.excerpt}`).join('\n')
}
