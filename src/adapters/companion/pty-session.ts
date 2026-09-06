// TASK-1878 — a real shell behind the socket TASK-1877 proved.
//
// The transport is already known good, so anything that goes wrong here is the
// shell or this file, and that is the whole reason the two steps were split.
//
// node-pty is NATIVE, and the plan for this task said it would need the same
// treatment `better-sqlite3` gets: a prebuilt binary compiled against the
// system Node ABI throws ERR_DLOPEN_FAILED under Electron, which ships its own
// Node build, so the vendor script rebuilds it.
//
// Running the vendor script disproved that. node-pty builds on node-addon-api
// — N-API — whose entire purpose is an ABI stable across Node versions AND
// Electron; better-sqlite3 is a V8/NAN addon, which is why IT needs the
// rebuild. Rebuilding node-pty is impossible besides: the published tarball
// omits deps/winpty/src/shared/GetCommitHash.bat and gyp dies at configure.
//
// So it is vendored and NOT rebuilt, and the vendored copy was loaded under
// Electron's own runtime and spawned a real shell to prove it. See
// scripts/vendor-pty.test.mjs in the companion, which pins the shape.

import { platform, env } from 'process'

/** The frames a client may send. Anything else is refused by name. */
export type ClientFrame =
  | { t: 'start'; cwd: string; cols?: number; rows?: number }
  | { t: 'in'; d: string }
  | { t: 'size'; cols: number; rows: number }

export interface PtyLike {
  readonly pid: number
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  onData: (cb: (d: string) => void) => void
  onExit: (cb: (e: { exitCode: number }) => void) => void
}

/** The seam. Real in production, and real in the tests too — see below. */
export type PtySpawner = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> }
) => PtyLike | Promise<PtyLike>

export const DEFAULT_COLS = 80
export const DEFAULT_ROWS = 24

/**
 * The shell to start.
 *
 * Chosen, not measured against a preference: powershell on Windows, `$SHELL`
 * elsewhere, `/bin/sh` as the floor because a container image may have nothing
 * else.
 */
export function defaultShell(): string {
  if (platform === 'win32') return env.COMSPEC ?? 'powershell.exe'
  return env.SHELL ?? '/bin/sh'
}

export function realSpawner(): PtySpawner {
  return async (file, args, opts) => {
    // A dynamic import, and node-pty is `--external` in build:companion — the
    // same shape better-sqlite3 already uses, and for the same two reasons:
    // esbuild must not pull a native module into the bundle, and the packaged
    // app resolves it from the vendored `deps` tree via NODE_PATH.
    //
    // Lazy as well as external: importing this module — which the whole
    // adapter does — must not load a native binary on a machine or a test that
    // will never open a terminal. A load failure belongs at the moment a
    // terminal is opened, not at boot.
    const pty = (await import('node-pty')) as unknown as {
      spawn: (f: string, a: string[], o: unknown) => PtyLike
    }
    return pty.spawn(file, args, opts)
  }
}

export interface PtySessionOptions {
  /** Registered workspace cwds. A start frame may name one of these, nothing else. */
  allowedCwds: () => Promise<string[]> | string[]
  spawn?: PtySpawner
  shell?: string
}

export interface PtySessionSink {
  send: (frame: Record<string, unknown>) => void
}

/** Same normalisation the docker join uses: drive-letter case AND separators. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * One PTY per socket. Tabs are a UI concern and would be several sockets.
 *
 * Everything a frame can ask for is bounded: the cwd must already be a
 * registered workspace, the shell is chosen here rather than named by the
 * client, and there is no frame that passes a command through — a shell reads
 * its input from the tty, which is the point of a terminal and not a widening
 * of it.
 */
export class PtySession {
  private pty: PtyLike | null = null
  private exited = false

  constructor(
    private readonly sink: PtySessionSink,
    private readonly opts: PtySessionOptions
  ) {}

  /** The live process id, or null. Tests assert this is gone after a close. */
  get pid(): number | null {
    return this.pty?.pid ?? null
  }

  async handle(raw: string): Promise<void> {
    let frame: ClientFrame
    try {
      frame = JSON.parse(raw) as ClientFrame
    } catch {
      this.sink.send({ t: 'error', error: 'frame is not JSON' })
      return
    }

    if (frame.t === 'start') return this.start(frame)
    if (frame.t === 'in') {
      this.pty?.write(frame.d)
      return
    }
    if (frame.t === 'size') {
      this.pty?.resize(frame.cols, frame.rows)
      return
    }
    // Named, not ignored. A frame nobody handles is a client bug, and silence
    // is how it stays one.
    this.sink.send({ t: 'error', error: `unknown frame: ${String((frame as { t: string }).t)}` })
  }

  private async start(frame: { t: 'start'; cwd: string; cols?: number; rows?: number }): Promise<void> {
    if (this.pty) {
      this.sink.send({ t: 'error', error: 'a shell is already running on this socket' })
      return
    }
    const allowed = await this.opts.allowedCwds()
    // Resolved against what the app already knows, BEFORE anything is spawned.
    // A frame naming any directory on the disk would widen an already wide
    // feature for no reason at all.
    const match = allowed.find((c) => samePath(c, frame.cwd))
    if (!match) {
      this.sink.send({ t: 'error', error: 'cwd is not a registered workspace' })
      return
    }

    const cols = frame.cols ?? DEFAULT_COLS
    const rows = frame.rows ?? DEFAULT_ROWS
    const spawn = this.opts.spawn ?? realSpawner()
    try {
      this.pty = await spawn(this.opts.shell ?? defaultShell(), [], {
        cwd: match,
        cols,
        rows,
        env: { ...env } as Record<string, string>
      })
    } catch (err) {
      // A native load failure lands here, which is where a reader can be told
      // what actually happened rather than watching a socket close.
      this.sink.send({ t: 'error', error: `could not start a shell: ${String(err)}` })
      return
    }

    this.sink.send({ t: 'ready', cols, rows })
    this.pty.onData((d) => this.sink.send({ t: 'out', d }))
    this.pty.onExit((e) => {
      this.exited = true
      // Sent BEFORE the socket closes, so the UI can tell a clean exit from a
      // crash. A socket that simply drops carries neither fact.
      this.sink.send({ t: 'exit', code: e.exitCode })
      this.pty = null
    })
  }

  /**
   * Kill the shell. Called when the socket closes.
   *
   * A shell that survives its socket leaves one process per terminal opened,
   * and node-pty holds the event loop open on Windows besides — measured, not
   * assumed: a bare node script with an exited PTY did not return to the shell.
   */
  dispose(): void {
    if (this.pty && !this.exited) {
      try {
        this.pty.kill()
      } catch {
        // Already gone. Nothing to report.
      }
    }
    this.pty = null
  }
}
