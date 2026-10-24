// TASK-2733 — the companion chat assistant's free routes. None of these calls a
// model: the model list reads the resource's deployment listing (as
// /claude-config/models does), and the chat routes read and write local SQLite.
// The one route that spends money, POST /assistant/chats/:id/messages, is
// TASK-2735's, and is deliberately not matched here.
//
//   GET  /assistant/models     → { models: [{id, model}], selected }
//   GET  /assistant/chats      → [{ id, title, model, tokensUsed, tokenBudget, updatedAt }]
//   POST /assistant/chats      { title?, model?, tokenBudget? } → 201 chat
//   GET  /assistant/chats/:id  → { chat, messages }
//
// Every route is token-gated: chats hold text read from the vault. The web
// reaches them through /api, whose proxy adds the token.
//
// A missing chat answers `unknown chat: <id>`, never the router's bare
// `not found`, so the web can tell "no such chat" from "this adapter predates
// the route" (gotcha a-new-adapter-route-is-invisible-to-the-shipped-companion…).

import type { IncomingMessage, ServerResponse } from 'http'
import { AiError } from './ai-review'
import { listAzureModels, resolveAzureConfig } from './azure-review'
import {
  MAX_TOKEN_BUDGET,
  MIN_TOKEN_BUDGET,
  type AssistantStore
} from './assistant-store'

/** Butter's default (discovery CONV-1792821501482-50, decision C). */
export const PREFERRED_ASSISTANT_MODEL = 'gpt-5.6-luna'

const MODELS_ROUTE = '/assistant/models'
const CHATS_ROUTE = '/assistant/chats'
const CHAT_DETAIL = /^\/assistant\/chats\/([^/]+)$/
const MAX_BODY_BYTES = 64 * 1024

export interface AssistantRoutesOptions {
  bridgeToken: string
  /** Null when the writable connection could not be opened → 501. */
  store: AssistantStore | null
  dataDir?: string
  fetchImpl?: typeof fetch
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** Returns true when it handled the request. */
export async function handleAssistantRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AssistantRoutesOptions
): Promise<boolean> {
  const rawPath = (req.url ?? '').split('?')[0] ?? ''
  const detail = rawPath.match(CHAT_DETAIL)
  if (rawPath !== MODELS_ROUTE && rawPath !== CHATS_ROUTE && !detail) return false

  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  const method = req.method ?? 'GET'

  if (rawPath === MODELS_ROUTE) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await sendModels(res, opts)
    return true
  }

  if (opts.store === null) {
    sendJson(res, 501, { error: 'assistant storage unavailable' })
    return true
  }
  const store = opts.store

  if (rawPath === CHATS_ROUTE) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        store.listChats().map((c) => ({
          id: c.id,
          title: c.title,
          model: c.model,
          tokensUsed: c.tokensUsed,
          tokenBudget: c.tokenBudget,
          updatedAt: c.updatedAt
        }))
      )
      return true
    }
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const raw = await readBody(req)
    if (raw === null) {
      sendJson(res, 413, { error: 'too large' })
      return true
    }
    let parsed: { title?: unknown; model?: unknown; tokenBudget?: unknown }
    try {
      parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as typeof parsed)
    } catch {
      sendJson(res, 400, { error: 'body is not valid JSON' })
      return true
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'body must be a JSON object' })
      return true
    }
    const budget = parsed.tokenBudget
    if (
      budget !== undefined &&
      (typeof budget !== 'number' ||
        !Number.isInteger(budget) ||
        budget < MIN_TOKEN_BUDGET ||
        budget > MAX_TOKEN_BUDGET)
    ) {
      sendJson(res, 400, { error: 'tokenBudget must be 200000-400000' })
      return true
    }
    const chat = store.createChat({
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : null,
      tokenBudget: budget
    })
    sendJson(res, 201, chat)
    return true
  }

  // GET /assistant/chats/:id
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const id = decodeURIComponent(detail?.[1] ?? '')
  const chat = store.getChat(id)
  if (chat === null) {
    sendJson(res, 404, { error: `unknown chat: ${id}` })
    return true
  }
  sendJson(res, 200, { chat, messages: store.listMessages(id) })
  return true
}

async function sendModels(res: ServerResponse, opts: AssistantRoutesOptions): Promise<void> {
  let cfg
  try {
    cfg = opts.dataDir ? resolveAzureConfig(opts.dataDir) : null
  } catch (err) {
    if (!(err instanceof AiError)) throw err
    cfg = null
  }
  if (cfg === null) {
    sendJson(res, 501, { error: 'no model configured' })
    return
  }
  try {
    const models = await listAzureModels(cfg, opts.fetchImpl ?? fetch)
    const selected = models.some((m) => m.id === PREFERRED_ASSISTANT_MODEL)
      ? PREFERRED_ASSISTANT_MODEL
      : cfg.deployment
    sendJson(res, 200, { models, selected })
  } catch (err) {
    if (!(err instanceof AiError)) throw err
    sendJson(res, 502, { error: 'model listing unavailable', kind: err.kind })
  }
}
