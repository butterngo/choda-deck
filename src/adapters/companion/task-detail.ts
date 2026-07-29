// TASK-1444 follow-up — task-detail read for the graph. GET /tasks/:id returns
// the full task (body / acceptance criteria / status / blockers) so clicking a
// task node in the companion graph can show its detail, the way /knowledge/:slug
// already does for knowledge nodes. Read-only, localhost-only, same contract as
// the other companion read routes. (POST /tasks/:id/ready lives in workflow.ts;
// this is GET-only and doesn't collide.)

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function handleTaskDetailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: BackendTaskService
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = url.pathname.match(/^\/tasks\/([^/]+)$/)
  if ((req.method ?? 'GET') !== 'GET' || !match) return false

  const id = decodeURIComponent(match[1])
  const task = await svc.getTask(id)
  if (!task) {
    sendJson(res, 404, { error: `unknown task: ${id}` })
    return true
  }
  sendJson(res, 200, task)
  return true
}
