// TASK-2755 — the assistant service's free routes. None of these calls a model:
// the model list reads the resource's deployment listing, the chat routes read
// and write assistant.db.
//
//   GET    /assistant/models          → { models: [{id, model}], selected }
//   GET    /assistant/chats?q=        → [{ id, title, model, tokensUsed, tokenBudget, updatedAt }]
//   POST   /assistant/chats           { title?, model?, tokenBudget? } → 201 chat
//   GET    /assistant/chats/:id       → { chat, messages }
//   PATCH  /assistant/chats/:id       { title } → 200 chat
//   DELETE /assistant/chats/:id       → 204
//
// Every route is token-gated. A missing chat answers `unknown chat: <id>`, never
// a bare `not found`, so the web can tell "no such chat" from "this build
// predates the route".

import type { IncomingMessage, ServerResponse } from 'http'
import { AiError } from '../companion/ai-review'
import { listAzureModels, resolveAzureConfig } from '../companion/azure-review'
import { MAX_TOKEN_BUDGET, MIN_TOKEN_BUDGET, type ChatStore } from './chat-store'

/** Butter's default (discovery CONV-1792821501482-50, decision C). */
export const PREFERRED_ASSISTANT_MODEL = 'gpt-5.6-luna'

const MODELS_ROUTE = '/assistant/models'
const CHATS_ROUTE = '/assistant/chats'
const CHAT_DETAIL = /^\/assistant\/chats\/([^/]+)$/
const MAX_BODY_BYTES = 64 * 1024

export interface AssistantRoutesOptions {
  bridgeToken: string
  store: ChatStore
  dataDir?: string
  fetchImpl?: typeof fetch
  /** Chats with a message in flight; the message routes add to it. */
  busy: Set<string>
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function readBody(req: IncomingMessage): Promise<Buffer | null> {
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

/** Parses a JSON object body; answers the error itself and returns null when it is not one. */
export async function readJsonObject(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return null
  }
  let parsed: unknown
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: 'body must be a JSON object' })
    return null
  }
  return parsed as Record<string, unknown>
}

/** Returns true when it handled the request. */
export async function handleAssistantRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AssistantRoutesOptions
): Promise<boolean> {
  const [rawPath = '', search = ''] = (req.url ?? '').split('?')
  const detail = rawPath.match(CHAT_DETAIL)
  if (rawPath !== MODELS_ROUTE && rawPath !== CHATS_ROUTE && !detail) return false

  const method = req.method ?? 'GET'
  const { store } = opts

  if (rawPath === MODELS_ROUTE) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await sendModels(res, opts)
    return true
  }

  if (rawPath === CHATS_ROUTE) {
    if (method === 'GET') {
      const q = new URLSearchParams(search).get('q') ?? ''
      sendJson(
        res,
        200,
        store.listChats(q).map((c) => ({
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
    const body = await readJsonObject(req, res)
    if (body === null) return true
    const budget = body.tokenBudget
    if (
      budget !== undefined &&
      (typeof budget !== 'number' || !Number.isInteger(budget) || budget < MIN_TOKEN_BUDGET || budget > MAX_TOKEN_BUDGET)
    ) {
      sendJson(res, 400, { error: 'tokenBudget must be 200000-400000' })
      return true
    }
    const chat = store.createChat({
      title: typeof body.title === 'string' ? body.title : undefined,
      model: typeof body.model === 'string' && body.model !== '' ? body.model : null,
      tokenBudget: budget as number | undefined
    })
    sendJson(res, 201, chat)
    return true
  }

  const id = decodeURIComponent(detail?.[1] ?? '')
  if (method === 'GET') {
    const chat = store.getChat(id)
    if (chat === null) {
      sendJson(res, 404, { error: `unknown chat: ${id}` })
      return true
    }
    sendJson(res, 200, { chat, messages: store.listMessages(id) })
    return true
  }

  if (method === 'PATCH') {
    const body = await readJsonObject(req, res)
    if (body === null) return true
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (title === '') {
      sendJson(res, 400, { error: 'title is required' })
      return true
    }
    const chat = store.renameChat(id, title)
    if (chat === null) {
      sendJson(res, 404, { error: `unknown chat: ${id}` })
      return true
    }
    sendJson(res, 200, chat)
    return true
  }

  if (method === 'DELETE') {
    if (store.getChat(id) === null) {
      sendJson(res, 404, { error: `unknown chat: ${id}` })
      return true
    }
    if (opts.busy.has(id)) {
      sendJson(res, 409, { error: 'busy' })
      return true
    }
    store.deleteChat(id)
    res.writeHead(204)
    res.end()
    return true
  }

  sendJson(res, 405, { error: 'method not allowed' })
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
    const selected = models.some((m) => m.id === PREFERRED_ASSISTANT_MODEL) ? PREFERRED_ASSISTANT_MODEL : cfg.deployment
    sendJson(res, 200, { models, selected })
  } catch (err) {
    if (!(err instanceof AiError)) throw err
    sendJson(res, 502, { error: 'model listing unavailable', kind: err.kind })
  }
}
