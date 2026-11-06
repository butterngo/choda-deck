import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  activeProjects,
  foldWorktree,
  isoWeekOf,
  isValidWeek,
  projectForPath,
  readWeekPick,
  validatePick,
  weekDates,
  weekReport,
  writeWeekPick,
  type WorkspaceRef
} from './activity-week'

// TASK-3127 — rule 1 of personal-operating-rules.

const workspaces: WorkspaceRef[] = [
  { projectId: 'mavue-studio', cwd: 'C:\\dev\\mavue-studio' },
  { projectId: 'tms', cwd: 'C:\\dev\\test\\tms' },
  { projectId: 'tms', cwd: 'C:\\dev\\test\\tms\\fe' },
  { projectId: 'juvenis-maxime', cwd: 'C:\\dev\\test\\NewJuvenisMaxime' }
]
const opts = { homeDir: 'C:\\Users\\hngo1_mantu' }

function digest(rows: { workspace: string; activeMinutes: number }[]) {
  return {
    metrics: {
      byProject: rows.map((r) => ({
        ...r,
        prompts: 1,
        tokens: 0,
        interruptions: 0,
        corrections: 0
      }))
    }
  } as never
}

describe('ISO weeks', () => {
  it('labels and expands 2026-W45 as Mon 2026-11-02 .. Sun 2026-11-08', () => {
    expect(isoWeekOf('2026-11-02')).toBe('2026-W45')
    expect(isoWeekOf('2026-11-08')).toBe('2026-W45')
    expect(isoWeekOf('2026-11-09')).toBe('2026-W46')
    expect(weekDates('2026-W45')).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08'
    ])
  })

  it('handles a week that straddles the year (2026-W01 starts 2025-12-29)', () => {
    expect(weekDates('2026-W01')[0]).toBe('2025-12-29')
    expect(isoWeekOf('2025-12-29')).toBe('2026-W01')
  })

  it('rejects a malformed or impossible week', () => {
    expect(isValidWeek('2026-W45')).toBe(true)
    expect(isValidWeek('2026-45')).toBe(false)
    expect(isValidWeek('2026-W54')).toBe(false)
    expect(isValidWeek('2026-W53')).toBe(true) // 2026 starts on a Thursday: 53 weeks
    expect(isValidWeek('2025-W53')).toBe(false) // 2025 has 52
  })
})

describe('mapping digest paths to projects', () => {
  it('folds a worktree into its repo before mapping', () => {
    expect(foldWorktree('c:/dev/mavue-studio.worktrees/autopilot-task-3039')).toBe(
      'c:/dev/mavue-studio'
    )
    expect(projectForPath('c:/dev/mavue-studio.worktrees/autopilot-task-3039', workspaces)).toEqual(
      {
        projectId: 'mavue-studio',
        registered: true
      }
    )
  })

  it('takes the longest workspace prefix, case- and slash-insensitively', () => {
    expect(projectForPath('c:/dev/test/tms/fe/src', workspaces).projectId).toBe('tms')
    expect(projectForPath('C:\\DEV\\test\\NewJuvenisMaxime\\api', workspaces).projectId).toBe(
      'juvenis-maxime'
    )
  })

  it('a sibling copy with a longer name is not under the workspace', () => {
    expect(projectForPath('c:/dev/test/newjuvenismaxime-2498', workspaces)).toEqual({
      projectId: 'unregistered:c:/dev/test/newjuvenismaxime-2498',
      registered: false
    })
  })
})

describe('activeProjects', () => {
  it('sums a worktree row into its project, not as a separate entry', () => {
    const active = activeProjects(
      [
        digest([
          { workspace: 'c:/dev/mavue-studio', activeMinutes: 40 },
          { workspace: 'c:/dev/mavue-studio.worktrees/autopilot-task-3039', activeMinutes: 30 }
        ])
      ],
      workspaces,
      opts
    )
    expect(active).toEqual([{ projectId: 'mavue-studio', minutes: 70, registered: true }])
  })

  it('lists an unregistered repo as its own project', () => {
    const active = activeProjects(
      [digest([{ workspace: 'c:/dev/test/workshop-mobile', activeMinutes: 290 }])],
      workspaces,
      opts
    )
    expect(active).toEqual([
      { projectId: 'unregistered:c:/dev/test/workshop-mobile', minutes: 290, registered: false }
    ])
  })

  it('drops the dev root, scratch, the vault, home and ~/.claude', () => {
    const active = activeProjects(
      [
        digest([
          { workspace: 'c:/dev', activeMinutes: 130 },
          { workspace: 'c:/tmp/mavue-model-trial', activeMinutes: 375 },
          { workspace: 'c:/users/hngo1_mantu/vault', activeMinutes: 90 },
          { workspace: 'c:/users/hngo1_mantu', activeMinutes: 75 },
          { workspace: 'c:/users/hngo1_mantu/.claude/skills', activeMinutes: 80 },
          { workspace: 'c:/dev/test/tms', activeMinutes: 60 }
        ])
      ],
      workspaces,
      opts
    )
    expect(active.map((p) => p.projectId)).toEqual(['tms'])
  })

  it('keeps a project at 60 summed minutes and drops one at 59', () => {
    const active = activeProjects(
      [
        digest([
          { workspace: 'c:/dev/test/tms', activeMinutes: 30 },
          { workspace: 'c:/dev/mavue-studio', activeMinutes: 59 }
        ]),
        digest([{ workspace: 'c:/dev/test/tms/fe', activeMinutes: 30 }])
      ],
      workspaces,
      opts
    )
    expect(active).toEqual([{ projectId: 'tms', minutes: 60, registered: true }])
  })

  it('sorts by minutes descending', () => {
    const active = activeProjects(
      [
        digest([
          { workspace: 'c:/dev/test/tms', activeMinutes: 100 },
          { workspace: 'c:/dev/mavue-studio', activeMinutes: 300 },
          { workspace: 'c:/dev/test/newjuvenismaxime', activeMinutes: 200 }
        ])
      ],
      workspaces,
      opts
    )
    expect(active.map((p) => p.projectId)).toEqual(['mavue-studio', 'juvenis-maxime', 'tms'])
  })
})

describe('validatePick', () => {
  const known = ['juvenis-maxime', 'ba-nghiep', 'mavue-studio', 'tms', 'choda-deck']

  it('refuses five projects, naming rule 1', () => {
    expect(validatePick(known, known)).toMatch(/rule 1/)
  })

  it('refuses an id that is not a registered project, naming it', () => {
    expect(validatePick(['tms', 'nope'], known)).toContain('"nope"')
  })

  it('accepts four registered projects', () => {
    expect(validatePick(known.slice(0, 4), known)).toBeNull()
  })
})

describe('week pick file', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-week-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('picked is null when no pick file exists, and the stored ids after a pick', () => {
    expect(weekReport(dir, '2026-W45', workspaces, opts).picked).toBeNull()
    writeWeekPick(dir, {
      week: '2026-W45',
      picked: ['tms', 'mavue-studio'],
      pickedAt: '2026-11-06T00:00:00Z',
      swaps: []
    })
    expect(fs.existsSync(path.join(dir, 'activity', 'week-2026-W45.json'))).toBe(true)
    expect(weekReport(dir, '2026-W45', workspaces, opts).picked).toEqual(['tms', 'mavue-studio'])
    expect(readWeekPick(dir, '2026-W45')?.swaps).toEqual([])
  })

  it('reads the week digests from <artifacts>/activity/<date>.json', () => {
    fs.mkdirSync(path.join(dir, 'activity'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'activity', '2026-11-03.json'),
      JSON.stringify(digest([{ workspace: 'c:/dev/test/tms', activeMinutes: 120 }]))
    )
    fs.writeFileSync(
      path.join(dir, 'activity', '2026-11-10.json'),
      JSON.stringify(digest([{ workspace: 'c:/dev/mavue-studio', activeMinutes: 500 }]))
    )
    expect(weekReport(dir, '2026-W45', workspaces, opts).active).toEqual([
      { projectId: 'tms', minutes: 120, registered: true }
    ])
  })
})
