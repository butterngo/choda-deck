import { SqliteTaskService } from '../src/tasks/sqlite-task-service'

const DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
const svc = new SqliteTaskService(DB_PATH)
const projects = ['automation-rule', 'choda-deck', 'task-management']

const removed: string[] = []
for (const projectId of projects) {
  const tasks = svc.findTasks({ projectId })
  for (const task of tasks) {
    if (!task.body) {
      svc.deleteTask(task.id)
      removed.push(`${task.id} [${projectId}] — ${task.title}`)
    }
  }
}

console.log(JSON.stringify({ removed: removed.length, tasks: removed }, null, 2))
svc.close()
