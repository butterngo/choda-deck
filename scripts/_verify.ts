import { SqliteTaskService } from '../src/tasks/sqlite-task-service'

const DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
const svc = new SqliteTaskService(DB_PATH)
const projects = ['automation-rule', 'choda-deck', 'task-management']

for (const projectId of projects) {
  const tasks = svc.findTasks({ projectId })
  const withBody = tasks.filter((t) => !!t.body).length
  const empty = tasks.filter((t) => !t.body).length
  console.log(`${projectId}: ${tasks.length} total | ${withBody} with body | ${empty} empty`)
}
svc.close()
