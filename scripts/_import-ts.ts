import { SqliteTaskService } from '../src/tasks/sqlite-task-service'
import { VaultImporter } from '../src/tasks/vault-importer'

const DB_PATH = process.env.CHODA_DB_PATH || 'C:\\dev\\choda-deck\\choda-deck.db'
const CONTENT_ROOT = process.env.CHODA_CONTENT_ROOT || 'C:\\Users\\hngo1_mantu\\vault'
const projects = (process.argv[2] || 'automation-rule').split(',')

const svc = new SqliteTaskService(DB_PATH)
const importer = new VaultImporter(svc, CONTENT_ROOT)
const result = importer.importAll(projects)
console.log(JSON.stringify(result, null, 2))
svc.close()
