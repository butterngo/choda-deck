// TASK-2734 — the tools the chat assistant may call. All of them read; none
// writes (ADR adr-when-this-project-may-call-a-model, 2026-10-24 amendment).
//
// The registry is built from AssistantReadServices, a type that has only
// search/get/list methods. A tool cannot reach a create, update or delete even
// by mistake, because nothing it is handed has one. The binding to the real
// services lives in assistant-read-services.ts.
//
// execute() never throws: an unknown tool, unparseable arguments or a failing
// service all come back as `{"error": …}` for the model to read, and the loop
// carries on. Every result is redacted, then capped, before it is returned.

import { cap, redact } from './assistant-redact'

/** The read-only surface the tools are allowed to touch. Nothing here may write. */
export interface AssistantReadServices {
  search(query: string, limit: number): Promise<unknown>
  getTask(id: string): Promise<unknown | null>
  listTasks(filter: { projectId?: string; status?: string; query?: string; limit: number }): Promise<unknown[]>
  searchKnowledge(query: string, limit: number): Promise<unknown>
  getKnowledge(slug: string): Promise<unknown | null>
  listInbox(filter: { projectId?: string; status?: string; limit: number }): Promise<unknown[]>
  getConversation(id: string): Promise<unknown | null>
  findMeetings(query: string | undefined, limit: number): Promise<unknown[]>
  getMeeting(id: string): Promise<unknown | null>
  getRuns(goalId: string | undefined): Promise<unknown[]>
  getDailyReport(date: string | undefined): Promise<unknown>
  searchVault(query: string, limit: number): Promise<unknown[]>
  readVaultNote(path: string): Promise<string | null>
  searchChats(query: string, limit: number): Promise<unknown[]>
  getChat(id: string): Promise<unknown | null>
}

/** OpenAI / Azure function-tool format. */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string; enum?: string[] }>
      required: string[]
      additionalProperties: false
    }
  }
}

type Args = Record<string, unknown>

interface ToolSpec {
  def: ToolDefinition
  run: (read: AssistantReadServices, args: Args) => Promise<unknown>
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

function str(args: Args, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

function need(args: Args, key: string): string {
  const v = str(args, key)
  if (v === undefined) throw new Error(`${key} is required`)
  return v
}

function limit(args: Args): number {
  const v = args.limit
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return DEFAULT_LIMIT
  return Math.min(v, MAX_LIMIT)
}

function tool(
  name: string,
  description: string,
  properties: ToolDefinition['function']['parameters']['properties'],
  required: string[],
  run: ToolSpec['run']
): ToolSpec {
  return {
    def: {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false }
      }
    },
    run
  }
}

const QUERY = { type: 'string', description: 'Words to search for.' }
const LIMIT = { type: 'integer', description: `Maximum results, 1-${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` }
const PROJECT = { type: 'string', description: 'Project id, e.g. choda-deck. Omit for all projects.' }

const SPECS: ToolSpec[] = [
  tool(
    'search',
    'Search task titles and knowledge entries across every project. Start here when the user names a topic but no id.',
    { query: QUERY, limit: LIMIT },
    ['query'],
    (r, a) => r.search(need(a, 'query'), limit(a))
  ),
  tool(
    'get_task',
    'Read one task by id: title, status, priority, body with its acceptance criteria, and its subtasks.',
    { id: { type: 'string', description: 'Task id, e.g. TASK-12.' } },
    ['id'],
    (r, a) => r.getTask(need(a, 'id'))
  ),
  tool(
    'list_tasks',
    'List tasks, optionally filtered by project, status (TODO, READY, IN-PROGRESS, IMPLEMENTED, DONE, CANCELLED) or title words.',
    {
      projectId: PROJECT,
      status: {
        type: 'string',
        description: 'Task status.',
        enum: ['TODO', 'READY', 'IN-PROGRESS', 'IMPLEMENTED', 'DONE', 'CANCELLED']
      },
      query: QUERY,
      limit: LIMIT
    },
    [],
    (r, a) =>
      r.listTasks({ projectId: str(a, 'projectId'), status: str(a, 'status'), query: str(a, 'query'), limit: limit(a) })
  ),
  tool(
    'search_knowledge',
    'Semantic search over knowledge entries: decisions (ADRs), gotchas, features, learnings.',
    { query: QUERY, limit: LIMIT },
    ['query'],
    (r, a) => r.searchKnowledge(need(a, 'query'), limit(a))
  ),
  tool(
    'get_knowledge',
    'Read one knowledge entry by slug, with its full body.',
    { slug: { type: 'string', description: 'Knowledge slug.' } },
    ['slug'],
    (r, a) => r.getKnowledge(need(a, 'slug'))
  ),
  tool(
    'list_inbox',
    'List inbox items (raw ideas and notices), optionally for one project or status (raw, researching, ready, converted, archived).',
    {
      projectId: PROJECT,
      status: {
        type: 'string',
        description: 'Inbox status. Default raw.',
        enum: ['raw', 'researching', 'ready', 'converted', 'archived']
      },
      limit: LIMIT
    },
    [],
    (r, a) => r.listInbox({ projectId: str(a, 'projectId'), status: str(a, 'status') ?? 'raw', limit: limit(a) })
  ),
  tool(
    'get_conversation',
    'Read one conversation thread by id (CONV-…): participants, messages and decision.',
    { id: { type: 'string', description: 'Conversation id.' } },
    ['id'],
    (r, a) => r.getConversation(need(a, 'id'))
  ),
  tool(
    'find_meetings',
    'List recorded meetings, newest first, optionally only those whose title contains the given words.',
    { query: { type: 'string', description: 'Words in the meeting title. Omit for all.' }, limit: LIMIT },
    [],
    (r, a) => r.findMeetings(str(a, 'query'), limit(a))
  ),
  tool(
    'get_meeting',
    'Read one meeting by id: its drafted note (decisions, actions, questions) when one exists, otherwise its transcript.',
    { id: { type: 'string', description: 'Meeting id, from find_meetings.' } },
    ['id'],
    (r, a) => r.getMeeting(need(a, 'id'))
  ),
  tool(
    'get_runs',
    'Progress of autopilot goal runs: goal, items done out of total, the current item and the last activity time. Use for "what are you working on" and "when will it be done"; it holds no dates for the future, so answer with progress, never a date.',
    { goalId: { type: 'string', description: 'Goal task id. Omit for every run.' } },
    [],
    (r, a) => r.getRuns(str(a, 'goalId'))
  ),
  tool(
    'get_daily_report',
    'The daily report: what moved yesterday, each project focus, and outstanding work.',
    { date: { type: 'string', description: 'YYYY-MM-DD. Omit for today.' } },
    [],
    (r, a) => r.getDailyReport(str(a, 'date'))
  ),
  tool(
    'search_vault',
    "Search Butter's notes (project notes and knowledge notes) by words in their path or text. Returns paths for read_vault_note.",
    { query: QUERY, limit: LIMIT },
    ['query'],
    (r, a) => r.searchVault(need(a, 'query'), limit(a))
  ),
  tool(
    'read_vault_note',
    'Read one note by the path search_vault returned, e.g. 10-Projects/ichiba-devops/context.md.',
    { path: { type: 'string', description: 'Path relative to the vault root.' } },
    ['path'],
    async (r, a) => {
      const text = await r.readVaultNote(need(a, 'path'))
      if (text === null) throw new Error('note not found or outside the readable folders')
      return text
    }
  ),
  tool(
    'search_chats',
    'Search earlier assistant chats by words in their messages. Use when the user refers to a previous chat.',
    { query: QUERY, limit: LIMIT },
    ['query'],
    (r, a) => r.searchChats(need(a, 'query'), limit(a))
  ),
  tool(
    'get_chat',
    'Read an earlier assistant chat by id (CHAT-…): its messages in order.',
    { id: { type: 'string', description: 'Chat id.' } },
    ['id'],
    (r, a) => r.getChat(need(a, 'id'))
  )
]

export interface AssistantTools {
  definitions: ToolDefinition[]
  /** Never throws. The result is redacted and capped. */
  execute(name: string, argsJson: string): Promise<string>
}

function finish(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return cap(redact(text))
}

export function createAssistantTools(read: AssistantReadServices): AssistantTools {
  const byName = new Map(SPECS.map((s) => [s.def.function.name, s]))
  return {
    definitions: SPECS.map((s) => s.def),
    async execute(name, argsJson) {
      const spec = byName.get(name)
      if (!spec) return finish({ error: 'unknown tool' })
      let args: Args
      try {
        const parsed: unknown = argsJson.trim() === '' ? {} : JSON.parse(argsJson)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish({ error: 'invalid arguments' })
        }
        args = parsed as Args
      } catch {
        return finish({ error: 'invalid arguments' })
      }
      try {
        const out = await spec.run(read, args)
        return finish(out === null ? { error: 'not found' } : out)
      } catch (err) {
        return finish({ error: err instanceof Error ? err.message : 'tool failed' })
      }
    }
  }
}
