import * as fs from 'fs'
import * as path from 'path'
import type { ConversationOperations } from '../../core/domain/interfaces/conversation-repository.interface'
import type { Conversation, ConversationMessage, ConversationAction } from '../../core/domain/task-types'

export function exportConversationMarkdown(
  svc: ConversationOperations,
  conversationId: string,
  contentRoot = process.env.CHODA_CONTENT_ROOT || ''
): string | null {
  if (!contentRoot) return null

  const conv = svc.getConversation(conversationId)
  if (!conv) return null

  const allForProject = svc.findConversations(conv.projectId)
  const index = allForProject.findIndex((c) => c.id === conversationId)
  const humanNumber = index >= 0 ? allForProject.length - index : 1

  const messages = svc.getConversationMessages(conversationId)
  const actions = svc.getConversationActions(conversationId)

  const body = renderConversationSection(conv, humanNumber, messages, actions)
  const filePath = conversationsMarkdownPath(contentRoot, conv.projectId)

  writeOrReplaceSection(filePath, conv.id, body)
  return filePath
}

function renderConversationSection(
  conv: Conversation,
  humanNumber: number,
  messages: ConversationMessage[],
  actions: ConversationAction[]
): string {
  const statusTag = conv.status.toUpperCase()
  const lines: string[] = []
  lines.push(`<!-- conversation:${conv.id} -->`)
  lines.push(`## #${humanNumber} — ${conv.title} \`${statusTag}\``)
  lines.push('')
  for (const msg of messages) {
    lines.push(renderMessageLine(msg))
  }
  lines.push('')
  if (conv.decisionSummary) {
    lines.push(`**Decision:** ${conv.decisionSummary}`)
  }
  if (actions.length > 0) {
    lines.push('**Actions:**')
    for (const action of actions) {
      const check = action.status === 'done' ? 'x' : ' '
      const taskSuffix = action.linkedTaskId ? ` (→ ${action.linkedTaskId})` : ''
      lines.push(`- [${check}] ${action.assignee}: ${action.description}${taskSuffix}`)
    }
  }
  lines.push('<!-- /conversation -->')
  return lines.join('\n')
}

function renderMessageLine(msg: ConversationMessage): string {
  const date = msg.createdAt.slice(0, 10)
  const oneLine = msg.content.split('\n').join(' ')
  return `- **${date} ${msg.authorName} (${msg.messageType}):** ${oneLine}`
}

function conversationsMarkdownPath(contentRoot: string, projectId: string): string {
  return path.join(contentRoot, '10-Projects', projectId, 'conversation.md')
}

const SECTION_START = (id: string): string => `<!-- conversation:${id} -->`
const SECTION_END = '<!-- /conversation -->'

function writeOrReplaceSection(filePath: string, conversationId: string, body: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
  const startMarker = SECTION_START(conversationId)
  const startIdx = existing.indexOf(startMarker)

  let next: string
  if (startIdx === -1) {
    next = (existing ? existing.trimEnd() + '\n\n' : '# Conversations\n\n') + body + '\n'
  } else {
    const endIdx = existing.indexOf(SECTION_END, startIdx)
    const after = endIdx === -1 ? '' : existing.slice(endIdx + SECTION_END.length)
    next = existing.slice(0, startIdx) + body + after
  }

  fs.writeFileSync(filePath, next, 'utf-8')
}
