import { SqliteTaskService } from '../src/tasks/sqlite-task-service'

const DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
const svc = new SqliteTaskService(DB_PATH)

const tasks = svc.findTasks({})
const missing = tasks.filter((t) => !t.body)
console.log(JSON.stringify(
  missing.map((t) => ({ id: t.id, title: t.title, status: t.status, filePath: t.filePath, projectId: t.projectId })),
  null, 2
))
svc.close()
