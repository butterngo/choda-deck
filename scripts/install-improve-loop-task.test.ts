import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ALLOWED_TOOLS,
  DAILY_AT,
  TASK_NAME,
  buildLauncher,
  buildVbs,
  claudeArgs,
  pickScheduled,
  readImproveConfig,
  runScheduled
} from './install-improve-loop-task.mjs'

// TASK-2361 — the pure half of the installer and the launcher's choice of
// workspaces. The Task Scheduler registration is verified live on the dev
// machine (see the AC report), not here.

function workspaceDir(mode?: string, model?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-ws-'))
  if (mode !== undefined) {
    fs.mkdirSync(path.join(dir, '.choda'))
    fs.writeFileSync(
      path.join(dir, '.choda', 'improve.json'),
      JSON.stringify({ mode, ...(model ? { model } : {}) })
    )
  }
  return dir
}

describe('install-improve-loop-task', () => {
  it('AC-1: of three workspaces (scheduled / manual / off), only the scheduled one is invoked', () => {
    const dirs = [workspaceDir('scheduled', 'opus'), workspaceDir('manual'), workspaceDir('off')]
    const invoked: string[] = []
    try {
      const results = runScheduled(
        [
          { id: 'web', cwd: dirs[0], archivedAt: null },
          { id: 'api', cwd: dirs[1], archivedAt: null },
          { id: 'docs', cwd: dirs[2], archivedAt: null }
        ],
        {
          invoke: (ws: string, model: string) => {
            invoked.push(`${ws}:${model}`)
            return 0
          },
          log: () => {}
        }
      )
      expect(invoked).toEqual(['web:opus'])
      expect(results).toEqual([{ id: 'web', code: 0 }])
    } finally {
      for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
    }
  })

  it('skips no config, an unreadable config, an archived workspace and an unsafe id', () => {
    const none = workspaceDir()
    const broken = workspaceDir()
    fs.mkdirSync(path.join(broken, '.choda'))
    fs.writeFileSync(path.join(broken, '.choda', 'improve.json'), '{ not json')
    const archived = workspaceDir('scheduled')
    const unsafe = workspaceDir('scheduled')
    try {
      expect(
        pickScheduled([
          { id: 'a', cwd: none, archivedAt: null },
          { id: 'b', cwd: broken, archivedAt: null },
          { id: 'c', cwd: archived, archivedAt: '2026-10-01' },
          { id: 'd&calc', cwd: unsafe, archivedAt: null }
        ])
      ).toEqual([])
      expect(readImproveConfig(broken)).toBeNull()
    } finally {
      for (const d of [none, broken, archived, unsafe])
        fs.rmSync(d, { recursive: true, force: true })
    }
  })

  it('runs every scheduled workspace in order, even after one fails, with sonnet as the default model', () => {
    const configs: Record<string, unknown> = {
      '/a': { mode: 'scheduled' },
      '/b': { mode: 'scheduled', model: 'bad model; rm' },
      '/c': { mode: 'scheduled', model: 'haiku' }
    }
    const calls: string[] = []
    const results = runScheduled(
      ['a', 'b', 'c'].map((id) => ({ id, cwd: `/${id}`, archivedAt: null })),
      {
        readConfig: (cwd: string) => configs[cwd],
        invoke: (ws: string, model: string) => {
          calls.push(`${ws}:${model}`)
          return ws === 'a' ? 1 : 0
        },
        log: () => {}
      }
    )
    expect(calls).toEqual(['a:sonnet', 'b:sonnet', 'c:haiku'])
    expect(results.map((r: { code: number }) => r.code)).toEqual([1, 0, 0])
  })

  it('claude gets the skill, the model and exactly the skill’s tools', () => {
    expect(claudeArgs('web', 'sonnet')).toEqual([
      '-p',
      '/improve-loop web',
      '--model',
      'sonnet',
      '--allowedTools',
      'Bash Read Glob Task mcp__choda-tasks__inbox_add mcp__choda-tasks__inbox_list'
    ])
    expect(ALLOWED_TOOLS).toHaveLength(6)
  })

  it('the launcher sets the data dir, runs --run with an absolute claude, and logs', () => {
    const cmd = buildLauncher({
      nodeExe: 'C:\\n\\installation\\node.exe',
      script: 'C:\\dev\\choda-deck\\scripts\\install-improve-loop-task.mjs',
      claudeCmd: 'C:\\n\\installation\\claude.cmd',
      dataDir: 'C:\\dev\\choda-deck\\data',
      repoRoot: 'C:\\dev\\choda-deck',
      logFile: 'C:\\dev\\choda-deck\\data\\logs\\improve-loop.log'
    })
    expect(cmd).toContain('set "CHODA_DATA_DIR=C:\\dev\\choda-deck\\data"')
    expect(cmd).toContain(
      '"C:\\n\\installation\\node.exe" "C:\\dev\\choda-deck\\scripts\\install-improve-loop-task.mjs" --run --claude "C:\\n\\installation\\claude.cmd"'
    )
    expect(cmd).toContain('>> "C:\\dev\\choda-deck\\data\\logs\\improve-loop.log" 2>&1')
  })

  it('the VBS wrapper runs hidden and waits; the task runs daily at 08:45', () => {
    expect(buildVbs('C:\\x\\l.cmd')).toBe(
      'WScript.Quit CreateObject("Wscript.Shell").Run("""C:\\x\\l.cmd""", 0, True)\r\n'
    )
    expect(TASK_NAME).toBe('ChodaImproveLoop')
    expect(DAILY_AT).toBe('08:45')
  })
})
