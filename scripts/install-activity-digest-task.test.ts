import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  ALLOWED_TOOLS,
  buildLauncher,
  buildVbs,
  isEphemeralPath,
  resolveClaude
} from './install-activity-digest-task.mjs'

// TASK-2155 — the pure half of the installer. The Task Scheduler registration
// itself is verified live on the dev machine (see the AC report), not here.

describe('install-activity-digest-task', () => {
  it('flags fnm multishell paths as ephemeral', () => {
    expect(
      isEphemeralPath('C:\\Users\\u\\AppData\\Local\\fnm_multishells\\123_456\\claude.cmd')
    ).toBe(true)
    expect(
      isEphemeralPath(
        'C:\\Users\\u\\AppData\\Roaming\\fnm\\node-versions\\v24\\installation\\claude.cmd'
      )
    ).toBe(false)
  })

  it('refuses a claude.cmd that still resolves under fnm_multishells', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnm_multishells-'))
    const f = path.join(dir, 'claude.cmd')
    fs.writeFileSync(f, '')
    try {
      expect(() => resolveClaude(f, () => undefined)).toThrow(/fnm_multishells/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when claude.cmd cannot be found at all', () => {
    expect(() => resolveClaude(undefined, () => undefined)).toThrow(/not found/)
  })

  it('the launcher sets the data dir, calls claude by absolute path, pre-approves the tools, and logs', () => {
    const cmd = buildLauncher({
      claudeCmd: 'C:\\n\\installation\\claude.cmd',
      dataDir: 'C:\\dev\\choda-deck\\data',
      repoRoot: 'C:\\dev\\choda-deck',
      logFile: 'C:\\dev\\choda-deck\\data\\logs\\activity-digest.log'
    })
    expect(cmd).toContain('set "CHODA_DATA_DIR=C:\\dev\\choda-deck\\data"')
    expect(cmd).toContain('call "C:\\n\\installation\\claude.cmd" -p "/daily-digest"')
    expect(cmd).toContain(`--allowedTools "${ALLOWED_TOOLS.join(' ')}"`)
    expect(cmd).toContain('>> "C:\\dev\\choda-deck\\data\\logs\\activity-digest.log" 2>&1')
    expect(cmd.split('\r\n').length).toBeGreaterThan(5)
  })

  it('the VBS wrapper runs hidden and waits', () => {
    expect(buildVbs('C:\\x\\l.cmd')).toBe(
      'WScript.Quit CreateObject("Wscript.Shell").Run("""C:\\x\\l.cmd""", 0, True)\r\n'
    )
  })
})
