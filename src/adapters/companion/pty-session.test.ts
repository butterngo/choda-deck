// TASK-1878 — driven against a REAL node-pty, not a stub.
//
// A stubbed PTY would prove the framing and nothing at all about the module
// that is actually at risk here: node-pty is native, and the failure this task
// exists to avoid is a binary that loads in `pnpm test` and throws
// ERR_DLOPEN_FAILED in the installed app. A stub agrees with whatever the code
// believes, which is the one thing that cannot help here.
//
// AC-2 is the exception and uses a recording spawner, because the criterion is
// that NOTHING is spawned — and a real spawn that "should not happen" proves
// nothing when it does not happen for some other reason.

import { describe, it, expect, afterEach } from 'vitest'
import process, { platform, cwd as processCwd } from 'process'
import { PtySession, samePath, defaultShell, type PtyLike, type PtySpawner } from './pty-session'

const REAL_CWD = processCwd()
const isWindows = platform === 'win32'
// A shell that exists on the runner, chosen per platform rather than assumed.
// cmd.exe on Windows, not powershell.exe (TASK-2010): it is what the app spawns
// by default (`defaultShell` → COMSPEC), and Windows PowerShell's cold start on
// windows-latest took 4.9-9.6 s to its prompt, and sometimes never printed one
// within 12 s — it stopped after its banner. cmd.exe prompts in ~0.1 s.
const SHELL = isWindows ? 'cmd.exe' : '/bin/sh'
// `mode con` prints "Columns:        132". Matched with its label: cmd's banner
// carries the Windows build number, which can contain "132" on its own.
const WIDTH_CMD = isWindows ? 'mode con\r' : 'tput cols\r'
const WIDTH_132 = isWindows ? /Columns:\s+132\b/ : /\b132\b/
const EXIT_CMD = isWindows ? 'exit 0\r' : 'exit 0\r'

interface Recorded {
  frames: Record<string, unknown>[]
  /** Arrival time (Date.now()) of each frame, index for index. */
  at: number[]
  text: () => string
}

function sink(): Recorded {
  const frames: Record<string, unknown>[] = []
  return {
    frames,
    at: [],
    text: () =>
      frames
        .filter((f) => f.t === 'out')
        .map((f) => String(f.d))
        .join('')
  }
}

const live: PtySession[] = []

// node-pty ships prebuilds for win32 and darwin only. On Linux it needs a source
// build, and CI does not run install scripts — so a real PTY cannot start there.
//
// The tests that need one are SKIPPED with the reason named, never quietly
// passed: a green tick on a machine that could not run the shell would be worse
// than a red one. The criteria they cover are proven on Windows, which is the
// platform this feature actually ships to, and the AC evidence says so.
let ptyWorks = false
try {
  const mod = (await import('node-pty')) as unknown as {
    spawn: (f: string, a: string[], o: unknown) => { kill: () => void; pid: number }
  }
  const probe = mod.spawn(SHELL, [], { cwd: REAL_CWD, cols: 80, rows: 24, env: { ...process.env } })
  ptyWorks = typeof probe.pid === 'number' && probe.pid > 0
  probe.kill()
} catch (err) {
  console.warn(`[pty-session.test] real-PTY tests SKIPPED on ${platform}: ${String(err)}`)
}
if (!ptyWorks) {
  console.warn(`[pty-session.test] real-PTY tests SKIPPED on ${platform}: no usable node-pty prebuild`)
}
/** describe for the tests that need a live shell. */
const describePty = ptyWorks ? describe : describe.skip


function session(rec: Recorded, opts: Partial<{ allowed: string[]; spawn: PtySpawner }> = {}): PtySession {
  const s = new PtySession(
    {
      send: (f) => {
        rec.frames.push(f)
        rec.at.push(Date.now())
      }
    },
    {
      allowedCwds: () => opts.allowed ?? [REAL_CWD],
      spawn: opts.spawn,
      shell: SHELL
    }
  )
  live.push(s)
  return s
}

/** Poll rather than sleep a fixed span: a slow runner should not be a red test. */
async function until(pred: () => boolean, ms = 12_000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 60))
  }
  return pred()
}

// TASK-2010 — on Windows the first bytes are ConPTY's own mode switches
// (`\x1b[?9001h\x1b[?1004h`), not the shell. AC-1, AC-4 and AC-5 used to write
// on them, and failed on windows-latest after exactly one `until` budget
// (12.1-12.6 s) whenever the shell had not started reading yet. So a test
// writes only once the shell has said it reads input — its prompt — and a
// failure carries a timeline of which step it stopped at.
const PROMPT = isWindows ? /[A-Za-z]:\\[^\r\n]*>/ : /[$#] ?$/m
const visible = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')

interface Timeline {
  mark: (what: string) => void
  /** Marks so far, for an assertion message: which step a failure stopped at. */
  toString: () => string
}

function timeline(): Timeline {
  const t0 = Date.now()
  const marks: string[] = []
  return {
    mark: (what) => marks.push(`${what} @${Date.now() - t0}ms`),
    toString: () => marks.join(', ')
  }
}

/** Start the shell and wait for its prompt, marking the first byte and the prompt. */
async function startAtPrompt(rec: Recorded, s: PtySession, start: Record<string, unknown>): Promise<Timeline> {
  const tl = timeline()
  await s.handle(JSON.stringify({ t: 'start', ...start }))
  tl.mark((await until(() => rec.text().length > 0)) ? 'first output' : 'NO output')
  tl.mark((await until(() => PROMPT.test(visible(rec.text())))) ? 'prompt' : `NO prompt, received ${JSON.stringify(rec.text().slice(0, 400))}`)
  // Printed on a pass too: the spread of prompt times on a runner is what says
  // whether a budget is wide enough.
  console.log(`[pty-session.test] ${String(tl)}`)
  return tl
}

/** Write a line, then mark when the shell's first output after it arrived. */
async function writeAndAwait(rec: Recorded, s: PtySession, tl: Timeline, d: string, pred: () => boolean): Promise<boolean> {
  const before = rec.frames.length
  const sent = Date.now()
  tl.mark('wrote')
  await s.handle(JSON.stringify({ t: 'in', d }))
  const ok = await until(pred)
  const next = rec.at.slice(before).find((t, i) => t >= sent && rec.frames[before + i]?.t === 'out')
  tl.mark(next === undefined ? 'NO output after write' : `output +${next - sent}ms after write`)
  tl.mark(ok ? 'answered' : `NOT answered, received ${JSON.stringify(rec.text().slice(-400))}`)
  return ok
}

afterEach(() => {
  // node-pty holds the event loop open on Windows — measured: a bare node
  // script with an exited PTY did not return to the shell. A leaked one here
  // would hang the whole suite, not just its own test.
  for (const s of live.splice(0)) s.dispose()
})

// ---------------------------------------------------------------------------

describePty('AC-1 — a shell starts, speaks, and answers', () => {
  it('spawns on start and relays output both ways', async () => {
    const rec = sink()
    const s = session(rec)
    const tl = await startAtPrompt(rec, s, { cwd: REAL_CWD, cols: 80, rows: 24 })

    expect(rec.frames.some((f) => f.t === 'ready')).toBe(true)
    expect(s.pid).toBeGreaterThan(0)

    // The marker comes back only if input reached the shell AND its output
    // came back out. A shell running into a void passes neither half.
    const saw = await writeAndAwait(rec, s, tl, 'echo MARKER_9182\r', () => rec.text().includes('MARKER_9182'))
    expect(saw, String(tl)).toBe(true)
  }, 45_000)
})

describe('AC-2 — the cwd must already be a registered workspace', () => {
  it('refuses an unregistered cwd and spawns NOTHING', async () => {
    const spawns: string[] = []
    const spawn: PtySpawner = (file, _args, o) => {
      spawns.push(`${file} @ ${o.cwd}`)
      throw new Error('should not be reached')
    }
    const rec = sink()
    const s = session(rec, { allowed: [REAL_CWD], spawn })
    await s.handle(JSON.stringify({ t: 'start', cwd: 'C:\\Windows\\System32', cols: 80, rows: 24 }))

    expect(String(rec.frames[0]?.error)).toContain('not a registered workspace')
    // The discriminator: refusing after spawning would look identical in the
    // frames, and the shell would already be running somewhere it must not be.
    expect(spawns).toEqual([])
    expect(s.pid).toBeNull()
  })

  it('CONTROL — a registered cwd IS accepted, so the refusal is not blanket', async () => {
    let spawned = 0
    const fake: PtyLike = {
      pid: 4242,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {}
    }
    const rec = sink()
    const s = session(rec, {
      allowed: [REAL_CWD],
      spawn: () => {
        spawned++
        return fake
      }
    })
    await s.handle(JSON.stringify({ t: 'start', cwd: REAL_CWD }))
    expect(spawned).toBe(1)
    expect(rec.frames.some((f) => f.t === 'ready')).toBe(true)
  })

  it('matches a cwd whose drive letter and separators differ', () => {
    // The same normalisation the docker join needed: case AND direction, or a
    // registered workspace fails to match itself.
    expect(samePath('C:\\dev\\choda-deck', 'c:/dev/choda-deck')).toBe(true)
    expect(samePath('C:\\dev\\choda-deck\\', 'C:\\dev\\choda-deck')).toBe(true)
    expect(samePath('C:\\dev\\choda-deck', 'C:\\dev\\choda-deck-companion')).toBe(false)
  })
})

describePty('AC-3 — the shell dies with its socket', () => {
  it('dispose kills the process, and the pid is gone', async () => {
    const rec = sink()
    const s = session(rec)
    await s.handle(JSON.stringify({ t: 'start', cwd: REAL_CWD }))
    const pid = s.pid
    expect(pid).toBeGreaterThan(0)
    await until(() => rec.text().length > 0)

    s.dispose()
    expect(s.pid).toBeNull()
    // Asserted against the OS, not against a handler having run: a shell that
    // survives its socket leaves one process per terminal opened all day.
    const gone = await until(() => {
      try {
        process.kill(pid as number, 0)
        return false
      } catch {
        return true
      }
    })
    expect(gone).toBe(true)
  }, 30_000)
})

describePty('AC-4 — a resize is seen INSIDE the shell', () => {
  it('a program reading terminal width reports the new value', async () => {
    const rec = sink()
    const s = session(rec)
    const tl = await startAtPrompt(rec, s, { cwd: REAL_CWD, cols: 80, rows: 24 })

    await s.handle(JSON.stringify({ t: 'size', cols: 132, rows: 40 }))
    await new Promise((r) => setTimeout(r, 400))

    // Asked of the shell rather than of our own call log. "Accepted and
    // ignored" is the failure mode, and a spy on resize() cannot see it.
    const saw = await writeAndAwait(rec, s, tl, WIDTH_CMD, () => WIDTH_132.test(visible(rec.text())))
    expect(saw, String(tl)).toBe(true)
  }, 45_000)
})

describePty('AC-5 — an exit is announced, with its code', () => {
  it('sends an exit frame carrying the code', async () => {
    const rec = sink()
    const s = session(rec)
    const tl = await startAtPrompt(rec, s, { cwd: REAL_CWD })

    const got = await writeAndAwait(rec, s, tl, EXIT_CMD, () => rec.frames.some((f) => f.t === 'exit'))
    expect(got, String(tl)).toBe(true)
    const exit = rec.frames.find((f) => f.t === 'exit')
    // The code, not merely the fact: a socket that simply drops cannot tell a
    // clean exit from a crash, which is the whole reason this frame exists.
    expect(exit?.code).toBe(0)
  }, 45_000)
})

describe('frames that are not the contract', () => {
  it('names a non-JSON frame and an unknown type instead of ignoring them', async () => {
    const rec = sink()
    const s = session(rec, { allowed: [] })
    await s.handle('not json at all')
    await s.handle(JSON.stringify({ t: 'teleport' }))
    expect(String(rec.frames[0]?.error)).toContain('not JSON')
    // Silence is how a client bug stays one.
    expect(String(rec.frames[1]?.error)).toContain('unknown frame')
  })

  it('refuses a second start on the same socket', async () => {
    const rec = sink()
    const fake: PtyLike = {
      pid: 1,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => {},
      onExit: () => {}
    }
    const s = session(rec, { allowed: [REAL_CWD], spawn: () => fake })
    await s.handle(JSON.stringify({ t: 'start', cwd: REAL_CWD }))
    await s.handle(JSON.stringify({ t: 'start', cwd: REAL_CWD }))
    expect(String(rec.frames.at(-1)?.error)).toContain('already running')
  })
})

describe('the shell chosen', () => {
  it('picks a platform-appropriate default', () => {
    const sh = defaultShell()
    expect(sh.length).toBeGreaterThan(0)
    if (isWindows) expect(sh.toLowerCase()).toMatch(/cmd|powershell/)
  })
})
