// TASK-1875 — looking inside a container. Every test injects the exec seam;
// none touches a daemon.
//
// TASK-1894 — that seam is now the ENGINE rather than the CLI. What a test
// records is the container id the command was bound to plus the argv that
// reached it: there is no `exec` verb in the array any more, because the engine
// binds the command to the container itself.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleDockerExecRoute, parseLsLine } from './docker-exec'
import type { DockerReader } from './docker-containers'
import { EngineUnreachable } from './docker-engine'
import type { ContainerExec, ExecResult } from './docker-engine'

const TOKEN = 'exec-token'

const PS = [
  'run1\tjm-api\trunning\tUp 3h\tjm:latest\t\t',
  'stop1\tes-poc\texited\tExited (0) 2d ago\tes:latest\t\t'
].join('\n')

// A GNU line and a busybox line. They disagree about column widths, which is
// why the raw text is kept alongside the parse.
const GNU = '-rw-r--r--  1 node  staff   1234 Sep  4 10:18 package.json'
const BUSYBOX = 'drwxr-xr-x    2 1000     1000          4096 Sep  4 10:18 app'

let spawns: { args: string[]; deadlineMs: number }[] = []
let available = true
let execImpl: () => Promise<ExecResult>

const reader: DockerReader = {
  available: () => available,
  ps: () => PS,
  logs: () => '',
  images: () => ''
}

const exec: ContainerExec = (containerId, argv, opts) => {
  spawns.push({ args: [containerId, ...argv], deadlineMs: opts.deadlineMs })
  return execImpl()
}

const exits = (code: number, stdout = '', stderr = ''): Promise<ExecResult> =>
  Promise.resolve({ exitCode: code, stdout, stderr })

let server: Server
let base: string

async function get(
  path: string,
  token: string | null = TOKEN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    headers: token === null ? {} : { 'x-choda-bridge-token': token }
  })
  const raw = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    body = { raw }
  }
  return { status: res.status, body }
}

const ls = (id: string, p: string): Promise<{ status: number; body: Record<string, unknown> }> =>
  get(`/docker/exec/ls?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`)

beforeEach(async () => {
  spawns = []
  available = true
  execImpl = () => exits(0, `total 8\n${GNU}\n${BUSYBOX}\n`)

  server = createServer((req, res) => {
    void handleDockerExecRoute(req, res, { bridgeToken: TOKEN, reader, exec }).then((h) => {
      if (!h) {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

// ---------------------------------------------------------------------------

describe('AC-1 — the listing is parsed AND the raw line survives', () => {
  it('parses mode, owner, group and name from both ls dialects', async () => {
    const { status, body } = await ls('run1', '/app')
    expect(status).toBe(200)
    const entries = body.entries as { raw: string; mode: string; owner: string; group: string; name: string }[]
    // "total 8" is not an entry.
    expect(entries).toHaveLength(2)

    const file = entries[0]
    expect(file.mode).toBe('-rw-r--r--')
    expect(file.owner).toBe('node')
    expect(file.group).toBe('staff')

    // busybox prints numeric uid/gid — which is exactly what Butter asked to
    // see — and pads differently. Both must parse.
    const dir = entries[1]
    expect(dir.mode).toBe('drwxr-xr-x')
    expect(dir.owner).toBe('1000')
    expect(dir.group).toBe('1000')
  })

  it('keeps the raw line, so a dialect this parser does not know still shows', async () => {
    const { body } = await ls('run1', '/app')
    const entries = body.entries as { raw: string }[]
    // The fallback that makes the parse safe to be wrong about.
    expect(entries[0].raw).toBe(GNU)
  })

  it('a line the parser cannot read is returned raw with blank fields', () => {
    const odd = parseLsLine('some totally unexpected format')
    expect(odd?.raw).toBe('some totally unexpected format')
    expect(odd?.mode).toBe('')
    // Not dropped. A parse failure must not make a file disappear.
    expect(odd?.name).toBe('some totally unexpected format')
  })
})

describe('AC-2 — a dash is refused, a semicolon is not', () => {
  it('refuses a path beginning with a dash, spawning nothing', async () => {
    const { status } = await ls('run1', '-rf')
    expect(status).toBe(400)
    // The one thing a path must not do: become a flag.
    expect(spawns).toEqual([])
  })

  it('ACCEPTS shell metacharacters and passes them through unaltered', async () => {
    // Deliberate, and the opposite of the instinct. There is no shell here —
    // execFile takes an array — so these are just characters in a filename.
    // Rejecting them would be theatre that breaks real files and prevents
    // nothing.
    const weird = '/app/a b;c&&d$(e).json'
    const { status } = await ls('run1', weird)
    expect(status).toBe(200)
    expect(spawns[0].args[spawns[0].args.length - 1]).toBe(weird)
  })
})

describe('AC-3 — the container is resolved, and must be running', () => {
  it('404s an unknown id and spawns nothing', async () => {
    expect((await ls('nope', '/app')).status).toBe(404)
    expect(spawns).toEqual([])
  })

  it('409s a stopped container, naming its state, without spawning', async () => {
    const { status, body } = await ls('stop1', '/app')
    expect(status).toBe(409)
    expect(body.state).toBe('exited')
    // exec needs a running container; our sentence beats docker's error for a
    // reader who can already see the row says exited.
    expect(spawns).toEqual([])
  })
})

describe('AC-4 — cat refuses what it cannot honestly render', () => {
  it('413s a file over the cap rather than truncating it', async () => {
    execImpl = () => exits(0, 'x'.repeat(600 * 1024))
    const { status, body } = await get('/docker/exec/cat?id=run1&path=/big')
    expect(status).toBe(413)
    // A body that claims to be the file and is not is worse than a refusal.
    expect(body.text).toBeUndefined()
  })

  it('415s a file containing a NUL byte', async () => {
    execImpl = () => exits(0, `PK${String.fromCharCode(0)}binary`)
    const { status } = await get('/docker/exec/cat?id=run1&path=/a.zip')
    expect(status).toBe(415)
  })

  it('CONTROL — ordinary text comes back whole', async () => {
    execImpl = () => exits(0, '{"a":1}\n')
    const { status, body } = await get('/docker/exec/cat?id=run1&path=/a.json')
    expect(status).toBe(200)
    expect(body.text).toBe('{"a":1}\n')
  })
})

describe('AC-5 — a failure is ours, and says which path', () => {
  it('422s a non-zero exit naming the path, with no docker text forwarded', async () => {
    execImpl = () => exits(1, '', 'ls: /nope: No such file or directory')
    const { status, body } = await ls('run1', '/nope')
    expect(status).toBe(422)
    expect(String(body.error)).toContain('/nope')
    // stderr is not forwarded, so docker's message — which can carry image and
    // mount detail — cannot reach the response even by accident.
    expect(JSON.stringify(body)).not.toMatch(/docker|OCI|runtime/i)
  })
})

describe('AC-6 — the argv is exactly the two fixed programs', () => {
  it('ls builds exec <id> ls -la <path>', async () => {
    await ls('run1', '/app')
    // Asserted WHOLE: the array is the boundary, and toContain would pass with
    // an extra flag appended.
    expect(spawns[0].args).toEqual(['run1', 'ls', '-la', '/app'])
  })

  it('cat builds exec <id> cat <path>, with no -i and no -t', async () => {
    execImpl = () => exits(0, 'hi')
    await get('/docker/exec/cat?id=run1&path=/a.txt')
    expect(spawns[0].args).toEqual(['run1', 'cat', '/a.txt'])
  })
})

describe('the gates this route shares with its siblings', () => {
  it('401s without the token, 405s a POST, 501s with no daemon', async () => {
    expect((await ls('run1', '/app', )).status).toBe(200)
    expect((await get('/docker/exec/ls?id=run1&path=/app', null)).status).toBe(401)
    const res = await fetch(`${base}/docker/exec/ls?id=run1&path=/app`, {
      method: 'POST',
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(res.status).toBe(405)
    available = false
    expect((await ls('run1', '/app')).status).toBe(501)
  })

  it('400s a missing path before anything else', async () => {
    const { status } = await get('/docker/exec/ls?id=run1')
    expect(status).toBe(400)
    expect(spawns).toEqual([])
  })
})

// TASK-1894 — the two defects the CLI path shipped with.
describe('AC-4 — silence is never reported as an empty directory', () => {
  it('502s a listing with no total line, instead of 200 with no entries', async () => {
    // Exactly what Butter's machine produced: exit 0, nothing on stdout. The
    // old route answered 200 {"entries":[]} and the pane said "This directory
    // is empty" for every path in every container.
    execImpl = () => exits(0, '')
    const { status, body } = await ls('run1', '/app')
    expect(status).toBe(502)
    expect(body.entries).toBeUndefined()
    expect(String(body.error)).toContain('returned nothing')
    expect(body.why).toBe('no output')
  })

  it('502s output that came only from stderr', async () => {
    execImpl = () => exits(0, '', 'ls: /app: Permission denied')
    const { status, body } = await ls('run1', '/app')
    expect(status).toBe(502)
    expect(body.why).toBe('stderr only')
    // Still not forwarded — the reason is named, the container's text is not.
    expect(JSON.stringify(body)).not.toContain('Permission denied')
  })

  it('CONTROL — a genuinely empty directory prints total 0, and IS empty', async () => {
    // The reason the total line is the discriminator rather than the entry
    // count: an empty directory is a real state and must still render as one.
    execImpl = () => exits(0, 'total 0\n')
    const { status, body } = await ls('run1', '/empty')
    expect(status).toBe(200)
    expect(body.entries).toEqual([])
  })

  it('CONTROL — the total line alone does not make an entry', async () => {
    execImpl = () => exits(0, `total 8\n${GNU}\n`)
    const { body } = await ls('run1', '/app')
    expect((body.entries as unknown[]).length).toBe(1)
  })
})

describe('AC-2 — an unreachable daemon is a stated failure', () => {
  it('502s when the engine cannot be reached, naming why', async () => {
    execImpl = () => Promise.reject(new EngineUnreachable('ECONNREFUSED'))
    const { status, body } = await ls('run1', '/app')
    expect(status).toBe(502)
    expect(body.why).toBe('ECONNREFUSED')
    // The distinction the whole task turns on: this is not an empty listing.
    expect(body.entries).toBeUndefined()
  })

  it('502s an unknown throw too, rather than letting the request hang', async () => {
    execImpl = () => Promise.reject(new Error('something else'))
    const { status, body } = await ls('run1', '/app')
    expect(status).toBe(502)
    expect(body.why).toBe('unknown')
  })
})

describe('AC-3 — the exit code decides, not the output', () => {
  it('422s a non-zero exit even when the command DID print something', async () => {
    // A partial listing that failed is still a failure. Rendering the half it
    // managed would show a directory as smaller than it is.
    execImpl = () => exits(1, 'total 4\nsome-line\n')
    const { status } = await ls('run1', '/half')
    expect(status).toBe(422)
  })
})
