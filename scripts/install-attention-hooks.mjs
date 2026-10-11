// TASK-2383 — register scripts/hooks/attention.mjs for UserPromptSubmit, Stop
// and Notification in ~/.claude/settings.json. Idempotent: an existing
// attention entry is replaced, never duplicated, and every other hook is kept.
// A copy of the previous file is written beside it before saving.
//
// Usage:
//   node scripts/install-attention-hooks.mjs                 # install / refresh
//   node scripts/install-attention-hooks.mjs --uninstall
//   Options: --settings <path> --data-dir <path> --node <path to node.exe>

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export const EVENTS = ['UserPromptSubmit', 'Stop', 'Notification']
const MARK = 'attention.mjs'

function isOurs(group) {
  return (group.hooks ?? []).some((h) =>
    [h.command, ...(h.args ?? [])].some((s) => typeof s === 'string' && s.includes(MARK))
  )
}

/** Pure: settings with exactly one attention entry per event (or none, to uninstall). */
export function withAttentionHooks(settings, { node, script, dataDir, remove = false }) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } }
  for (const ev of EVENTS) {
    const kept = (next.hooks[ev] ?? []).filter((g) => !isOurs(g))
    if (!remove) {
      kept.push({
        hooks: [{ type: 'command', command: node, args: [script, '--data-dir', dataDir] }]
      })
    }
    if (kept.length) next.hooks[ev] = kept
    else delete next.hooks[ev]
  }
  return next
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const file = arg('--settings') ?? path.join(os.homedir(), '.claude', 'settings.json')
  const node = arg('--node') ?? fs.realpathSync(process.execPath)
  if (/fnm_multishells/i.test(node)) {
    console.error(
      `[attention-hooks] refusing node at ${node}: it vanishes with this shell. Pass --node <stable path>.`
    )
    process.exit(1)
  }
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const next = withAttentionHooks(settings, {
    node,
    script: path.join(repoRoot, 'scripts', 'hooks', 'attention.mjs'),
    dataDir: path.resolve(arg('--data-dir') ?? path.join(repoRoot, 'data')),
    remove: process.argv.includes('--uninstall')
  })
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-attention`)
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  console.log(
    `[attention-hooks] ${process.argv.includes('--uninstall') ? 'removed from' : 'installed in'} ${file}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
