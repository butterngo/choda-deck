import * as fs from 'fs'

// TASK-2596 — `choda-deck mermaid check <file | ->`. The parse check from
// TASK-1934 was reachable only through the adapter route; /choda-plan runs in
// the CLI with no adapter, so a plan could not prove its `## Sequence` parses
// before approval. Same check, same caveat: PARSE, not render (mermaid-check.ts).
//
// Exit codes: 0 every fence parses (or there is none) · 1 a fence fails ·
// 2 usage error or missing file — the same 2 the other commands use.

export const MERMAID_HELP = `mermaid check <file | ->
  Parse every \`\`\`mermaid fence in a markdown file (- reads stdin).
  Prints "ok: N fence(s)" and exits 0, or one line per failing fence
  "fence K, line L: <error>" (L is the line in the file) and exits 1.
`

export interface MermaidCheckIo {
  out: (s: string) => void
  err: (s: string) => void
  readStdin: () => Promise<string>
}

/** One failure line per bad fence; K is 1-based, L is the line in the FILE. */
export async function runMermaidCheck(target: string, io: MermaidCheckIo): Promise<number> {
  let markdown: string
  if (target === '-') {
    markdown = await io.readStdin()
  } else {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      io.err(`file not found: ${target}\n`)
      return 2
    }
    markdown = fs.readFileSync(target, 'utf8')
  }

  const { listMermaidFences, checkMermaid } = await import('../companion/mermaid-check')
  const fences = listMermaidFences(markdown)
  const failures: string[] = []
  for (const fence of fences) {
    const result = await checkMermaid(fence.code)
    if (result.ok) continue
    // The parser counts lines inside the fence body; the file line is that
    // offset from the body's first line. No line in the message → the fence
    // start. A parser that trips at end of input can name a line past the body,
    // so the answer is clamped to the fence's last line.
    const fileLine =
      result.line !== null ? Math.min(fence.start + result.line - 1, fence.end) : fence.start
    failures.push(`fence ${fence.index + 1}, line ${fileLine}: ${oneLine(result.error)}`)
  }

  if (failures.length === 0) {
    io.out(`ok: ${fences.length} fence(s)\n`)
    return 0
  }
  io.err(`${failures.join('\n')}\n`)
  return 1
}

/**
 * mermaid's message is several lines: "Parse error on line 3:", the source
 * excerpt, a caret, then "Expecting …, got …". The first and last lines carry
 * the meaning; the excerpt would break the one-line-per-failure output.
 */
function oneLine(message: string): string {
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length <= 1) return lines[0] ?? message
  const first = lines[0]
  const last = lines[lines.length - 1]
  return first === last ? first : `${first} ${last}`
}

function readProcessStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

export async function dispatchMermaid(sub: string | undefined, args: string[]): Promise<number> {
  if (sub !== 'check') {
    process.stderr.write(
      `error: unknown mermaid subcommand "${sub ?? ''}" — only "mermaid check" is supported\n\n${MERMAID_HELP}`
    )
    return 2
  }
  if (args.length !== 1) {
    process.stderr.write(`error: mermaid check takes one file path, or - for stdin\n\n${MERMAID_HELP}`)
    return 2
  }
  return runMermaidCheck(args[0], {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    readStdin: readProcessStdin
  })
}
