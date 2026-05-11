#!/usr/bin/env node
/**
 * Reference parser for `claude -p` output. Extracts cost, tokens, cache, turns,
 * AND tool-call breakdown (which tools, how many times each).
 *
 * Two modes:
 *  - default: spawns `claude -p ... --output-format stream-json` (full visibility,
 *    captures tool calls)
 *  - --quick: uses --output-format json (no tool data, but one-shot parse)
 *
 * Usage:
 *   node --experimental-strip-types scripts/measure-claude.ts "<prompt>" [extra claude flags...]
 *   node --experimental-strip-types scripts/measure-claude.ts --json-file <path>
 *   node --experimental-strip-types scripts/measure-claude.ts --stream-file <path>
 *
 * Spike: vault/10-Projects/choda-deck/spikes/headless-metrics-schema.md
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface ClaudeUsage {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use?: { web_search_requests: number; web_fetch_requests: number }
}

interface ClaudeModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
}

interface ClaudeResult {
  type: 'result'
  subtype: string
  is_error: boolean
  api_error_status: string | null
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  result: string
  stop_reason: string
  session_id: string
  total_cost_usd: number
  usage: ClaudeUsage
  modelUsage: Record<string, ClaudeModelUsage>
  permission_denials: unknown[]
  terminal_reason?: string
  fast_mode_state: 'on' | 'off'
  uuid: string
  errors?: string[]
}

export interface ToolCall {
  name: string
  count: number
  inputs: unknown[]
}

export interface Metrics {
  isError: boolean
  errorReason: string | null
  costUsd: number
  tokens: { input: number; output: number; cacheCreate: number; cacheRead: number }
  cacheHitRatio: number
  durationMs: number
  apiDurationMs: number
  numTurns: number
  sessionId: string
  models: Array<{ id: string; costUsd: number }>
  resultText: string
  toolCalls: ToolCall[]
}

function metricsFromResult(r: ClaudeResult, toolCalls: ToolCall[] = []): Metrics {
  // Gotcha #1: subtype:"success" can co-exist with is_error:true. Trust is_error.
  // Gotcha #2: usage.* may be all-zero on budget-exceeded; modelUsage is the truth.
  // Gotcha #3: `errors` only present on certain error subtypes.
  const usage = r.usage ?? ({} as ClaudeUsage)
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? 0
  const input = usage.input_tokens ?? 0
  const totalIn = input + cacheRead + cacheCreate

  let errorReason: string | null = null
  if (r.is_error) {
    if (r.errors?.length) errorReason = r.errors.join('; ')
    else if (r.subtype !== 'success') errorReason = r.subtype
    else errorReason = r.result || 'unknown error'
  }

  const models = Object.entries(r.modelUsage ?? {}).map(([id, m]) => ({
    id,
    costUsd: m.costUSD,
  }))

  return {
    isError: r.is_error,
    errorReason,
    costUsd: r.total_cost_usd ?? 0,
    tokens: {
      input,
      output: usage.output_tokens ?? 0,
      cacheCreate,
      cacheRead,
    },
    cacheHitRatio: totalIn === 0 ? 0 : cacheRead / totalIn,
    durationMs: r.duration_ms ?? 0,
    apiDurationMs: r.duration_api_ms ?? 0,
    numTurns: r.num_turns ?? 0,
    sessionId: r.session_id,
    models,
    resultText: r.result ?? '',
    toolCalls,
  }
}

export function parseMetrics(json: string): Metrics {
  return metricsFromResult(JSON.parse(json) as ClaudeResult)
}

interface AssistantContentBlock {
  type: string
  name?: string
  input?: unknown
}

interface StreamAssistantEvent {
  type: 'assistant'
  message: { content: AssistantContentBlock[] }
}

interface StreamResultEvent extends ClaudeResult {
  type: 'result'
}

type StreamEvent = StreamAssistantEvent | StreamResultEvent | { type: string }

export function parseStreamMetrics(ndjson: string): Metrics {
  const lines = ndjson.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
  const tools = new Map<string, ToolCall>()
  let result: ClaudeResult | null = null

  for (const line of lines) {
    let evt: StreamEvent
    try {
      evt = JSON.parse(line) as StreamEvent
    } catch {
      continue
    }
    if (evt.type === 'assistant') {
      const blocks = (evt as StreamAssistantEvent).message?.content ?? []
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.name) {
          const existing = tools.get(b.name) ?? { name: b.name, count: 0, inputs: [] }
          existing.count += 1
          existing.inputs.push(b.input)
          tools.set(b.name, existing)
        }
      }
    } else if (evt.type === 'result') {
      result = evt as StreamResultEvent
    }
  }

  if (!result) throw new Error('No result event found in stream-json output')
  const toolCalls = Array.from(tools.values()).sort((a, b) => b.count - a.count)
  return metricsFromResult(result, toolCalls)
}

function spawnClaude(
  args: string[],
  stdinText: string,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let stdout = ''
    proc.stdout?.on('data', (d) => (stdout += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ stdout, code: code ?? 0 }))
    proc.stdin?.setDefaultEncoding('utf8')
    proc.stdin?.end(stdinText, 'utf8')
  })
}

function fmt(m: Metrics): string {
  const tools =
    m.toolCalls.length === 0
      ? '—  (no tool data; use stream-json mode to capture)'
      : m.toolCalls.map((t) => `${t.name}×${t.count}`).join(', ')
  const lines = [
    '',
    '─── result ──────────────────────────────────────────',
    m.resultText || '(empty)',
    '─── metrics ─────────────────────────────────────────',
    `error       : ${m.isError ? `YES — ${m.errorReason}` : 'no'}`,
    `cost_usd    : $${m.costUsd.toFixed(6)}`,
    `tokens      : in=${m.tokens.input} out=${m.tokens.output} cache_create=${m.tokens.cacheCreate} cache_read=${m.tokens.cacheRead}`,
    `cache_hit   : ${(m.cacheHitRatio * 100).toFixed(1)}%`,
    `duration    : ${m.durationMs}ms (api ${m.apiDurationMs}ms)`,
    `turns       : ${m.numTurns}`,
    `tools       : ${tools}`,
    `models      : ${m.models.map((x) => `${x.id}=$${x.costUsd.toFixed(6)}`).join(', ') || '—'}`,
    `session_id  : ${m.sessionId}`,
    '',
  ]
  return lines.join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(
      'Usage:\n' +
        '  node --experimental-strip-types scripts/measure-claude.ts "<prompt>" [extra claude flags...]\n' +
        '  node --experimental-strip-types scripts/measure-claude.ts --quick "<prompt>"        # json mode (no tool breakdown)\n' +
        '  node --experimental-strip-types scripts/measure-claude.ts --json-file <path>\n' +
        '  node --experimental-strip-types scripts/measure-claude.ts --stream-file <path>\n',
    )
    process.exit(0)
  }

  const jsonFileIdx = argv.indexOf('--json-file')
  if (jsonFileIdx !== -1) {
    const path = argv[jsonFileIdx + 1]
    if (!path) {
      process.stderr.write('--json-file requires a path\n')
      process.exit(2)
    }
    const metrics = parseMetrics(readFileSync(path, 'utf8'))
    process.stdout.write(fmt(metrics) + '\n')
    process.exit(metrics.isError ? 1 : 0)
  }

  const streamFileIdx = argv.indexOf('--stream-file')
  if (streamFileIdx !== -1) {
    const path = argv[streamFileIdx + 1]
    if (!path) {
      process.stderr.write('--stream-file requires a path\n')
      process.exit(2)
    }
    const metrics = parseStreamMetrics(readFileSync(path, 'utf8'))
    process.stdout.write(fmt(metrics) + '\n')
    process.exit(metrics.isError ? 1 : 0)
  }

  const quickIdx = argv.indexOf('--quick')
  const useStream = quickIdx === -1
  const cleanArgs = argv.filter((a) => a !== '--quick')
  // Prompt = first non-flag arg. Pass it via stdin (UTF-8 safe on Windows);
  // remaining flags become claude args.
  const promptIdx = cleanArgs.findIndex((a) => !a.startsWith('-'))
  if (promptIdx === -1) {
    process.stderr.write('No prompt provided\n')
    process.exit(2)
  }
  const prompt = cleanArgs[promptIdx]
  const extra = cleanArgs.filter((_, i) => i !== promptIdx)
  const args = useStream
    ? ['-p', '--output-format', 'stream-json', '--verbose', ...extra]
    : ['-p', '--output-format', 'json', ...extra]
  const { stdout, code } = await spawnClaude(args, prompt)

  let metrics: Metrics
  try {
    metrics = useStream ? parseStreamMetrics(stdout) : parseMetrics(stdout)
  } catch {
    process.stderr.write(`Failed to parse Claude output.\nRaw output:\n${stdout}\n`)
    process.exit(code || 2)
  }
  process.stdout.write(fmt(metrics) + '\n')
  process.exit(code)
}

main().catch((e) => {
  process.stderr.write(`${e}\n`)
  process.exit(2)
})
