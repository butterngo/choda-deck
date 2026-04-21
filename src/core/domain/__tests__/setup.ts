import { beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test__.db')

export let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('test-proj', 'Test Project', '/tmp/test')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})
