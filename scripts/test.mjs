import { execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(root, 'node_modules/electron/dist/electron.exe')
const vitest = resolve(root, 'node_modules/vitest/vitest.mjs')

const args = [vitest, ...process.argv.slice(2)]

execFileSync(electron, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
