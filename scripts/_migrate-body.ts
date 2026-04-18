import * as fs from 'fs'
import { SqliteTaskService } from '../src/tasks/sqlite-task-service'

const DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
const svc = new SqliteTaskService(DB_PATH)

const tasks = svc.findTasks({})
let migrated = 0
let skipped = 0
let missing = 0

for (const task of tasks) {
  if (task.body) {
    skipped++
    continue
  }
  if (!task.filePath) {
    missing++
    continue
  }
  if (!fs.existsSync(task.filePath)) {
    missing++
    continue
  }
  try {
    const content = fs.readFileSync(task.filePath, 'utf-8')
    svc.updateTask(task.id, { body: content })
    migrated++
  } catch (e) {
    console.error(`Failed ${task.id}:`, e)
  }
}

console.log(JSON.stringify({ migrated, skipped, missing, total: tasks.length }, null, 2))
svc.close()
