// TASK-1856 — Azure AI Foundry as the review provider.
//
// Not a base-URL swap on ai-review.ts. Anthropic and Azure differ in four
// places at once — the auth header, where the system prompt goes, how a schema
// is declared, and where the answer lands — so squeezing both through one
// request builder would produce a function whose every line is a conditional.
// They are two implementations sharing a return type.
//
// Every constant below was measured against the real resource on 2026-09-05,
// not read from documentation. The three that would not have been guessed:
//
//   * The deployments listing needs api-version 2023-03-15-preview. The
//     api-version the chat calls use (2024-10-21) returns 404 Resource not
//     found on that route.
//   * GET {endpoint}/models returns the REGION CATALOG — 428 entries — not
//     what this resource has deployed. A picker built from it offers 422
//     options that answer DeploymentNotFound.
//   * A reasoning deployment can return HTTP 200 with an EMPTY string when the
//     token budget is too small: it spends the whole budget thinking and has
//     nothing left to write with. See BUDGET_EXHAUSTED below.

import * as fs from 'fs'
import * as path from 'path'
import { AiError, type ReviewNote } from './ai-review'

const AI_KEY_FILE = 'ai-key.txt'
const PROVIDER_FILE = 'ai-provider.json'

/**
 * Only this api-version answers on the deployments route. Deliberately NOT the
 * one the chat calls use — 2024-10-21 returns 404 there, which reads like a
 * wrong URL and is actually a wrong version.
 */
const DEPLOYMENTS_API_VERSION = '2023-03-15-preview'

/**
 * Deployments whose budget is consumed by reasoning before any answer is
 * written. Two consequences, both measured: they reject `max_tokens` outright,
 * and they need an order of magnitude more of it.
 *
 * Matched on a prefix rather than an exact id because a deployment is named by
 * whoever created it — `gpt-5-mini`, `gpt-5-mini-prod`, `gpt-5-mini-2` are all
 * the same model with the same two constraints.
 */
const REASONING_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4']

const MAX_TOKENS = 2048
/** Reasoning burns budget before writing; 2048 measured as empty, 4096 as fine. */
const REASONING_MAX_TOKENS = 4096

export interface AzureConfig {
  endpoint: string
  deployment: string
  key: string
}

/** A deployment this resource actually has, filtered to the ones worth offering. */
export interface AzureModel {
  id: string
  model: string
}

export function isReasoningDeployment(deployment: string): boolean {
  const id = deployment.toLowerCase()
  return REASONING_PREFIXES.some((p) => id.startsWith(p))
}

/**
 * The config, or null when Azure was never set up.
 *
 * Secret and non-secret live in separate files on purpose: ai-provider.json is
 * readable when diagnosing a wrong endpoint, and doing that must not mean
 * opening a file with a key in it. The key keeps the location and the 0600
 * intent ai-review.ts established.
 */
export function resolveAzureConfig(dataDir: string): AzureConfig | null {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(dataDir, PROVIDER_FILE), 'utf8')
  } catch {
    return null
  }

  let cfg: { provider?: string; endpoint?: string; deployment?: string }
  try {
    cfg = JSON.parse(raw) as typeof cfg
  } catch {
    // A malformed config is not "no provider configured" — that would silently
    // degrade to 501 and send the reader looking for a key they already set.
    throw new AiError('no_key', `${PROVIDER_FILE} is not valid JSON`)
  }

  if (cfg.provider !== 'azure') return null
  if (!cfg.endpoint || !cfg.deployment) {
    throw new AiError('no_key', `${PROVIDER_FILE} is missing endpoint or deployment`)
  }

  const key = resolveAiKeyFile(dataDir)
  if (key === null) return null

  return { endpoint: cfg.endpoint.replace(/\/+$/, ''), deployment: cfg.deployment, key }
}

/**
 * The key, read from its file — or minted into that file from CHODA_AI_KEY when
 * the file is absent. Moved here from ai-review.ts when the Anthropic
 * implementation was deleted (TASK-1856); the behaviour and its reasoning are
 * TASK-1843's and are unchanged.
 *
 * The environment is how a key ARRIVES, not where it LIVES. A process
 * environment is inherited by every child the adapter spawns and is readable by
 * anything that can list the process, so the value is persisted out of it at
 * mode 0600, mirroring resolveBridgeToken in this same directory. A
 * present-but-empty file is treated as absent, the same way a truncated bridge
 * token is re-minted rather than returned.
 *
 * On Windows the 0600 is advisory — NTFS protection comes from the user's
 * directory ACL, not the POSIX mode. Stated rather than assumed away.
 */
export function resolveAiKeyFile(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const keyPath = path.join(dataDir, AI_KEY_FILE)
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim()
    if (existing.length > 0) return existing
  } catch {
    // missing file — fall through to the environment
  }

  const fromEnv = env.CHODA_AI_KEY?.trim()
  if (!fromEnv) return null

  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(keyPath, fromEnv, { mode: 0o600 })
  return fromEnv
}

/** The resource root, i.e. the endpoint with the /openai/v1 suffix removed. */
function resourceBase(endpoint: string): string {
  return endpoint.replace(/\/openai\/v1\/?$/, '')
}

/**
 * The deployments this resource has, narrowed to chat-capable and succeeded.
 *
 * The narrowing is a JOIN against the catalog's own capability flags, not a
 * name-prefix guess. `text-embedding-*` happens to be the convention today;
 * the first model that breaks it would otherwise be offered in a picker and
 * answer 404 when chosen. Verified correct across all six deployments here.
 */
export async function listAzureModels(
  cfg: AzureConfig,
  fetchImpl: typeof fetch = fetch
): Promise<AzureModel[]> {
  const base = resourceBase(cfg.endpoint)
  const headers = { 'api-key': cfg.key }

  const [depRes, catRes] = await Promise.all([
    fetchImpl(`${base}/openai/deployments?api-version=${DEPLOYMENTS_API_VERSION}`, { headers }),
    fetchImpl(`${cfg.endpoint}/models`, { headers })
  ])

  if (!depRes.ok) throw new AiError('api', `deployments listing returned ${depRes.status}`)
  if (!catRes.ok) throw new AiError('api', `model catalog returned ${catRes.status}`)

  const deployments = ((await depRes.json()) as {
    data?: { id?: string; model?: string; status?: string }[]
  }).data ?? []
  const catalog = ((await catRes.json()) as {
    data?: { id?: string; capabilities?: { chat_completion?: boolean } }[]
  }).data ?? []

  const chatCapable = new Set(
    catalog.filter((m) => m.capabilities?.chat_completion === true).map((m) => m.id)
  )

  return deployments
    .filter((d) => d.status === 'succeeded')
    .filter((d) => typeof d.id === 'string' && typeof d.model === 'string')
    .filter((d) => chatCapable.has(d.model as string))
    .map((d) => ({ id: d.id as string, model: d.model as string }))
}

const SYSTEM =
  'You review configuration files for the things a schema cannot judge: whether a ' +
  'description says WHEN to trigger rather than only what it does, whether two entries ' +
  'duplicate each other, whether an acceptance criterion can actually fail. ' +
  'Return JSON only. Say nothing a deterministic check could have said.'

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

/**
 * One schema-constrained call to the configured deployment, returning the parsed
 * object. Extracted for TASK-1860: grading acceptance criteria needs the same
 * request, the same per-family budget rule and the same error mapping as a file
 * review, and only a different prompt and schema. Copying those would have meant
 * two places to get the reasoning-budget case wrong.
 */
export async function askAzureJson<T>(opts: {
  cfg: AzureConfig
  system: string
  user: string
  schema: unknown
  schemaName: string
  model?: string
  fetchImpl?: typeof fetch
}): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch
  const deployment = opts.model ?? opts.cfg.deployment
  const reasoning = isReasoningDeployment(deployment)

  // The field name is not a preference: a reasoning deployment REJECTS
  // max_tokens with a 400, and the others do not know max_completion_tokens.
  const budget = reasoning
    ? { max_completion_tokens: REASONING_MAX_TOKENS }
    : { max_tokens: MAX_TOKENS }

  let res: Response
  try {
    res = await doFetch(`${opts.cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': opts.cfg.key
      },
      body: JSON.stringify({
        model: deployment,
        ...budget,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: opts.schemaName, strict: true, schema: opts.schema }
        }
      })
    })
  } catch (err) {
    // A transport failure is a different fact from a provider that answered
    // badly, and a reader acts on it differently — check the network, not the key.
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

  const choice = (data as {
    choices?: { finish_reason?: string; message?: { content?: string; refusal?: string | null } }[]
  })?.choices?.[0]

  if (choice?.message?.refusal) {
    throw new AiError('refusal', 'the model declined to answer')
  }

  const text = choice?.message?.content ?? ''

  // Measured, and the reason this branch exists at all: a reasoning deployment
  // given too small a budget spends ALL of it thinking and returns 200 with an
  // empty string. Falling through to the parse below would report "the model
  // answered badly" and send the reader to debug the wrong thing entirely —
  // the answer was never written, and the fix is a number, not a prompt.
  if (choice?.finish_reason === 'length' && text.trim().length === 0) {
    throw new AiError(
      'budget',
      `${deployment} used its whole token budget before answering — raise it and retry`
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new AiError('parse', 'provider response did not match the requested schema')
  }
}

export async function reviewFileAzure(opts: {
  cfg: AzureConfig
  rel: string
  text: string
  /** Overrides the configured default — this is what the pane's picker sends. */
  model?: string
  checkId?: string
  fetchImpl?: typeof fetch
}): Promise<ReviewNote[]> {
  const focus = opts.checkId ? ` Focus on: ${opts.checkId}.` : ''

  const parsed = await askAzureJson<{ notes?: unknown }>({
    cfg: opts.cfg,
    system: SYSTEM + focus,
    user: `File: ${opts.rel}

${opts.text}`,
    schema: REVIEW_SCHEMA,
    schemaName: 'review',
    model: opts.model,
    fetchImpl: opts.fetchImpl
  })

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
