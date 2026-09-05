// TASK-1843 — the one part of config validation that costs money, and the one
// part that can be wrong in a way no test catches.
//
// ## The key lives here, never in the renderer
//
// english-companion calls the model browser-direct because it has no server, and
// ADR-001 accepts the key sitting in the browser with a written warning: "Not
// safe for a multi-user or hosted deployment." This app is not that shape. It
// ships this adapter, which already holds the bridge token in a process the page
// never sees. Same user, same machine, strictly less exposure, and no new
// plumbing — the file beside bridge-token.txt is a second instance of a pattern
// rather than a new one.
//
// ## Why a file and not an environment variable
//
// A process environment is inherited by every child the adapter spawns and is
// readable by anything that can list the process. `resolveBridgeToken` already
// established the alternative in this exact directory: mkdir, then write with
// mode 0o600.
//
// CHODA_AI_KEY is still how a key ARRIVES — it is just not where it lives. The
// shape mirrors resolveBridgeToken exactly: read the file, and if it is absent,
// mint it. The only difference is that a bridge token is minted from randomness
// and this one is minted from the environment, because a key cannot be invented.
// That also keeps the task's own rule intact: the key never comes from a request.
//
// ## Borrowed from english-companion, minus one header
//
// `src/lib/claude.js` gives the shape worth copying: one entry point with fetch
// injectable so it is testable without a network, schema-constrained output so
// the answer is renderable and checkable, and a typed error union so each
// failure produces one actionable message instead of a crash.
//
// What is NOT copied is `anthropic-dangerous-direct-browser-access`. That header
// exists to opt a BROWSER past a CORS refusal; sending it from a Node process
// would be cargo-cult, announcing a risk this caller does not take.

import * as fs from 'fs'
import * as path from 'path'

const AI_KEY_FILE = 'ai-key.txt'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 2048

/**
 * One kind per failure a caller can act on differently. `no_key` is not an
 * error in the usual sense — it is the normal state of a machine that never
 * configured a model, and the route turns it into a 501 rather than a 5xx.
 */
export type AiErrorKind =
  | 'no_key'
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'refusal'
  // TASK-1856 — a reasoning deployment can answer HTTP 200 with an EMPTY body:
  // it spends the whole token budget thinking and has nothing left to write
  // with. That is not a parse failure, and calling it one sends the reader to
  // debug a prompt when the fix is a number.
  | 'budget'
  | 'parse'
  | 'api'

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    /** Present only for rate limits the provider told us how long to wait for. */
    readonly retryAfter: string | null = null
  ) {
    super(message)
    this.name = 'AiError'
  }
}

export interface ReviewNote {
  checkId: string
  message: string
  /** The span the note is about, quoted from the submitted text, or null. */
  quote: string | null
}

/**
 * The key for this data profile, or null when none is configured.
 *
 * Mirrors resolveBridgeToken: read the file, mint it if absent. A
 * present-but-empty file is treated as absent, the same way a truncated bridge
 * token is re-minted rather than returned.
 */
export function resolveAiKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const keyPath = path.join(dataDir, AI_KEY_FILE)
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // missing file — fall through to the environment
  }

  const fromEnv = env.CHODA_AI_KEY?.trim()
  if (!fromEnv) return null

  // Persist it out of the environment, so a child process the adapter spawns
  // does not inherit it and anything listing processes cannot read it.
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(keyPath, fromEnv, { mode: 0o600 })
  return fromEnv
}

/**
 * The response shape. Constrained by schema rather than parsed out of prose:
 * an unschema'd model answer is a string somebody has to guess the shape of,
 * and the guess is what breaks silently when the wording drifts.
 */
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['checkId', 'message', 'quote'],
        properties: {
          checkId: { type: 'string' },
          message: { type: 'string' },
          quote: { type: ['string', 'null'] }
        }
      }
    }
  }
} as const

const SYSTEM = [
  'You review a configuration file and report ONLY judgements a schema cannot make.',
  'Never report anything a deterministic check already answers: missing fields, malformed JSON,',
  'byte-order marks, key-set mismatches. Those are checked elsewhere and repeating them is noise.',
  'Report at most five notes. An empty list is a valid and common answer.',
  'Quote the span you are talking about when there is one; otherwise use null.'
].join(' ')

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>

/**
 * Ask the model about one file. `fetchImpl` is injectable for the same reason
 * english-companion's is: every failure path below has to be testable without a
 * network, and a test that needs the internet is a test nobody runs.
 */
export async function reviewFile(opts: {
  key: string | null
  rel: string
  text: string
  checkId?: string
  fetchImpl?: FetchLike
}): Promise<ReviewNote[]> {
  if (!opts.key) throw new AiError('no_key', 'no model configured')

  const doFetch = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike))
  const focus = opts.checkId ? ` Focus on: ${opts.checkId}.` : ''

  let res: Response
  try {
    res = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': opts.key,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM + focus,
        messages: [{ role: 'user', content: `File: ${opts.rel}\n\n${opts.text}` }],
        output_config: { format: { type: 'json_schema', schema: REVIEW_SCHEMA } }
      })
    })
  } catch (err) {
    // A transport failure is a different fact from a provider that answered
    // badly, and a reader can act on it differently — check the network, not
    // the key.
    throw new AiError('network', err instanceof Error ? err.message : 'request failed')
  }

  if (res.status === 401 || res.status === 403) {
    throw new AiError('auth', 'the configured key was rejected')
  }
  if (res.status === 429) {
    throw new AiError('rate_limit', 'rate limited', res.headers.get('retry-after'))
  }
  if (!res.ok) {
    throw new AiError('api', `provider returned ${res.status}`)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    throw new AiError('parse', 'provider response was not JSON')
  }

  const stop = (data as { stop_reason?: string })?.stop_reason
  if (stop === 'refusal') {
    throw new AiError('refusal', 'the model declined to answer')
  }

  // Thinking blocks come back alongside text ones and carry no JSON; dropping
  // them here is what keeps the parse below about the answer.
  const blocks = (data as { content?: { type?: string; text?: string }[] })?.content ?? []
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')

  let parsed: { notes?: unknown }
  try {
    parsed = JSON.parse(text) as { notes?: unknown }
  } catch {
    throw new AiError('parse', 'provider response did not match the requested schema')
  }
  if (!Array.isArray(parsed.notes)) {
    throw new AiError('parse', 'provider response did not match the requested schema')
  }

  return parsed.notes.map((n) => {
    const note = n as Partial<ReviewNote>
    return {
      checkId: typeof note.checkId === 'string' ? note.checkId : 'review',
      message: typeof note.message === 'string' ? note.message : '',
      quote: typeof note.quote === 'string' ? note.quote : null
    }
  })
}
