// TASK-2757 — the routes that spend money: send, regenerate, edit-and-resend.
//
//   POST /assistant/chats/:id/messages             { content, model? }
//   POST /assistant/chats/:id/regenerate           { model? }
//   POST /assistant/chats/:id/messages/:mid/edit   { content, model? }
//
// Each is one explicit request (ADR adr-when-this-project-may-call-a-model,
// 2026-10-26 amendment). Every gate is checked before the first provider call
// and answers JSON, so a refused request costs nothing:
//   405 · 413 · 400 invalid JSON · 400 empty content · 404 unknown chat ·
//   409 busy · 400/404 the regenerate/edit checks · 409 budget exhausted ·
//   501 no model configured
// Past the gates the answer is 200 text/event-stream:
//   event: step   data: {tool, ok, chars}
//   event: delta  data: {text}
//   event: done   data: {reply, steps, capped, usage, chat}
//   event: error  data: {kind, retryAfter?}
// No retry; a provider's own body is never forwarded. A client that hangs up
// aborts the provider call, and what had arrived is stored as interrupted.

import type { IncomingMessage, ServerResponse } from 'http'
import { AiError } from '../companion/ai-review'
import { resolveAzureConfig, type AzureConfig } from '../companion/azure-review'
import type { ChatStore, ChatSummary } from './chat-store'
import { runChatLoop } from './chat-loop'
import { readJsonObject, sendJson } from './routes'
import type { AssistantTools } from './tools'

const SEND = /^\/assistant\/chats\/([^/]+)\/messages$/
const REGENERATE = /^\/assistant\/chats\/([^/]+)\/regenerate$/
const EDIT = /^\/assistant\/chats\/([^/]+)\/messages\/([^/]+)\/edit$/

export interface MessageRoutesContext {
  store: ChatStore
  busy: Set<string>
  dataDir: string
  fetchImpl?: typeof fetch
  /** Built per request, so a test can hand in fixture tools. */
  tools: () => AssistantTools
}

type Prepare = (chat: ChatSummary) => { error: [number, string] } | { run: () => void }

/** Returns true when it handled the request. */
export async function handleMessageRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: MessageRoutesContext
): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  const send = path.match(SEND)
  const regen = path.match(REGENERATE)
  const edit = path.match(EDIT)
  if (!send && !regen && !edit) return false

  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const body = await readJsonObject(req, res)
  if (body === null) return true

  const content = typeof body.content === 'string' ? body.content : ''
  if ((send || edit) && content.trim() === '') {
    sendJson(res, 400, { error: 'empty content' })
    return true
  }

  const chatId = decodeURIComponent((send ?? regen ?? edit)?.[1] ?? '')
  const chat = ctx.store.getChat(chatId)
  if (chat === null) {
    sendJson(res, 404, { error: `unknown chat: ${chatId}` })
    return true
  }
  if (ctx.busy.has(chatId)) {
    sendJson(res, 409, { error: 'busy' })
    return true
  }

  // What each route does to the stored chat before the loop runs, checked
  // before the budget so a malformed request is told so even on a full chat.
  let prepare: ReturnType<Prepare>
  if (send) {
    prepare = { run: () => void ctx.store.appendMessage(chatId, { role: 'user', content }) }
  } else if (regen) {
    const lastUser = [...ctx.store.listMessages(chatId)].reverse().find((m) => m.role === 'user')
    prepare = lastUser
      ? { run: () => void ctx.store.deleteMessagesAfter(chatId, lastUser.seq) }
      : { error: [400, 'nothing to regenerate'] }
  } else {
    const mid = decodeURIComponent(edit?.[2] ?? '')
    const msg = ctx.store.getMessage(mid)
    if (msg === null || !mid.startsWith(`${chatId}-M`)) prepare = { error: [404, `unknown message: ${mid}`] }
    else if (msg.role !== 'user') prepare = { error: [400, 'only a question can be edited'] }
    else
      prepare = {
        run: () => {
          ctx.store.deleteMessagesAfter(chatId, msg.seq)
          ctx.store.updateMessageContent(mid, content)
        }
      }
  }
  if ('error' in prepare) {
    sendJson(res, prepare.error[0], { error: prepare.error[1] })
    return true
  }

  if (chat.tokensUsed >= chat.tokenBudget) {
    sendJson(res, 409, { error: 'budget exhausted', tokensUsed: chat.tokensUsed, tokenBudget: chat.tokenBudget })
    return true
  }
  let cfg: AzureConfig | null
  try {
    cfg = resolveAzureConfig(ctx.dataDir)
  } catch (err) {
    if (!(err instanceof AiError)) throw err
    cfg = null
  }
  if (cfg === null) {
    sendJson(res, 501, { error: 'no model configured' })
    return true
  }

  const deployment = typeof body.model === 'string' && body.model !== '' ? body.model : chat.model ?? cfg.deployment
  ctx.busy.add(chatId)
  const abort = new AbortController()
  // The client hanging up (Stop, a closed tab) ends the provider call too.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  try {
    prepare.run()
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no'
    })
    const emit = (event: string, data: unknown): void => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      const result = await runChatLoop({
        store: ctx.store,
        chat,
        deployment,
        cfg,
        tools: ctx.tools(),
        fetchImpl: ctx.fetchImpl ?? fetch,
        signal: abort.signal,
        events: { step: (s) => emit('step', s), delta: (text) => emit('delta', { text }) }
      })
      if (!result.interrupted) {
        emit('done', {
          reply: result.reply,
          steps: result.steps,
          capped: result.capped,
          usage: result.usage,
          chat: result.chat
        })
      }
    } catch (err) {
      if (!(err instanceof AiError)) throw err
      // The adapter's own words only: a provider body can echo the key back.
      emit('error', err.retryAfter ? { kind: err.kind, retryAfter: err.retryAfter } : { kind: err.kind })
    }
    res.end()
  } finally {
    ctx.busy.delete(chatId)
  }
  return true
}
