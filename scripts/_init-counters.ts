import { SqliteTaskService } from '../src/tasks/sqlite-task-service'

const DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
const svc = new SqliteTaskService(DB_PATH)

// Delete the stray timestamp task created earlier
const stray = svc.findTasks({}).filter((t) => /^TASK-\d{10,}/.test(t.id))
for (const t of stray) {
  console.log(`Deleting stray: ${t.id} [${t.projectId}] ${t.title}`)
  svc.deleteTask(t.id)
}

// Show counter state
const Database = require('better-sqlite3')
const db = new Database(DB_PATH)
const counters = db.prepare('SELECT * FROM project_task_counters').all()
console.log('Counters:', counters)

svc.close()
db.close()
