// TASK-1749 — workspace docs browsing. The listing runs against a real temp
// tree rather than a mocked fs, because the two things most likely to break are
// the node_modules filter and the traversal guard, and both are properties of
// the real filesystem walk.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleWorkspaceDocsRoute, listWorkspaceDocs, isBinaryPath } from './workspace-docs'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const TOKEN = 'bridge-token-for-tests'

interface Captured {
  status: number
  body: unknown
  raw?: string
  headers?: Record<string, string>
}

function fakeRes(cap: Captured): ServerResponse {
  return {
    writeHead(status: number, headers?: Record<string, string>) {
      cap.status = status
      cap.headers = headers
      return this
    },
    // TASK-1935 — the file route now ends with BYTES rather than a decoded
    // string, deliberately: decoding on the server is the round trip that loses
    // a BOM and rewrites line endings. Decoding HERE keeps every assertion below
    // meaning what it meant, without asking the route to lie about the file.
    end(payload?: string | Buffer) {
      cap.raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload
      try {
        cap.body = payload ? JSON.parse(payload) : undefined
      } catch {
        cap.body = undefined // markdown responses are not JSON
      }
      return this
    }
  } as unknown as ServerResponse
}

// `null` means "send no token" — an explicit `undefined` would re-trigger the
// default and silently send one, so the 401 case would never be exercised.
function req(url: string, method = 'GET', token: string | null = TOKEN): IncomingMessage {
  return {
    url,
    method,
    headers: token ? { 'x-choda-bridge-token': token } : {}
  } as unknown as IncomingMessage
}

let root: string

function svcFor(cwd: string | null, id = 'main'): WorkspaceOperations {
  return {
    getWorkspace: async (asked: string) =>
      asked === id && cwd !== null ? ({ id, label: 'Main', cwd, projectId: 'p1' } as never) : null
  } as unknown as WorkspaceOperations
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-docs-'))
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'some-pkg'), { recursive: true })
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# readme')
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide\n\nbody')
  fs.writeFileSync(path.join(root, 'docs', 'notes.txt'), 'not markdown')
  fs.writeFileSync(path.join(root, 'node_modules', 'some-pkg', 'README.md'), '# vendored')
  fs.writeFileSync(path.join(root, '.git', 'COMMIT_EDITMSG.md'), '# vcs noise')
  // The measured worst case: 54,553 bytes was the largest .md in the real tree.
  fs.writeFileSync(path.join(root, 'docs', 'big.md'), '#'.repeat(54_553))
  // A file OUTSIDE the workspace, to prove traversal cannot reach it.
  fs.writeFileSync(path.join(path.dirname(root), 'secret-outside.md'), 'SECRET')
  // TASK-1787 — a source file, a binary file, and a vendored decoy that must
  // stay filtered even when the listing widens to every extension.
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1')
  fs.writeFileSync(path.join(root, 'src', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  fs.writeFileSync(path.join(root, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('listWorkspaceDocs', () => {
  it('lists .md files and skips node_modules and .git', () => {
    const docs = listWorkspaceDocs(root).map((d) => d.path)
    expect(docs).toEqual(['docs/big.md', 'docs/guide.md', 'README.md'])
  })

  it('no listed path contains node_modules/ or .git/', () => {
    // The measured stakes: choda-deck is 199 real .md files against 877 raw.
    // Dropping the filter would bury the workspace's docs, not merely add rows.
    for (const doc of listWorkspaceDocs(root)) {
      expect(doc.path).not.toMatch(/node_modules\//)
      expect(doc.path).not.toMatch(/\.git\//)
    }
  })

  it('omits non-.md files entirely', () => {
    expect(listWorkspaceDocs(root).map((d) => d.path)).not.toContain('docs/notes.txt')
  })
})

describe('handleWorkspaceDocsRoute', () => {
  it('returns false for a path that is not ours', async () => {
    const cap = {} as Captured
    expect(
      await handleWorkspaceDocsRoute(req('/vault/notes'), fakeRes(cap), {
        svc: svcFor(root),
        bridgeToken: TOKEN
      })
    ).toBe(false)
  })

  it('lists a workspace\'s docs', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs?workspaceId=main'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
    const body = cap.body as { cwd: string; docs: Array<{ path: string }> }
    expect(body.cwd).toBe(root)
    expect(body.docs.map((d) => d.path)).toEqual(['docs/big.md', 'docs/guide.md', 'README.md'])
  })

  it('401s without a bridge token, like /vault/notes', async () => {
    const cap = {} as Captured
    const handled = await handleWorkspaceDocsRoute(
      req('/workspace-docs?workspaceId=main', 'GET', null),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(handled).toBe(true)
    expect(cap.status).toBe(401)
    expect(cap.body).not.toHaveProperty('docs')
  })

  it('a workspace whose cwd is gone is a FAILURE, not an empty list', async () => {
    const cap = {} as Captured
    const missing = path.join(root, 'does-not-exist')
    await handleWorkspaceDocsRoute(req('/workspace-docs?workspaceId=main'), fakeRes(cap), {
      svc: svcFor(missing),
      bridgeToken: TOKEN
    })
    // 409, never 200-with-[]: the view must be able to name the workspace
    // instead of reporting "no docs", which reads as a fact about the repo.
    expect(cap.status).toBe(409)
    const body = cap.body as { label: string; cwd: string }
    expect(body.label).toBe('Main')
    expect(body.cwd).toBe(missing)
  })

  it('404s an unknown workspace', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs?workspaceId=nope'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(404)
  })

  it('serves a .md file as markdown', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs/main/docs/guide.md'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
    expect(cap.headers?.['content-type']).toMatch(/text\/markdown/)
    expect(cap.raw).toContain('# guide')
  })

  it('serves the largest measured .md (54,553 bytes) whole', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs/main/docs/big.md'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
    expect(cap.raw?.length).toBe(54_553)
  })

  it.each([
    ['/workspace-docs/main/../secret-outside.md', 'parent segment'],
    ['/workspace-docs/main/%2e%2e/secret-outside.md', 'percent-encoded parent'],
    ['/workspace-docs/main/docs/../../secret-outside.md', 'nested parent'],
    ['/workspace-docs/main/C:/windows/system.md', 'absolute windows path'],
    ['/workspace-docs/main//etc/passwd.md', 'absolute posix path']
  ])('refuses %s (%s) and never reads outside the workspace', async (url) => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req(url), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBeGreaterThanOrEqual(400)
    expect(cap.status).toBeLessThan(500)
    expect(cap.raw ?? '').not.toContain('SECRET')
  })

  // TASK-1787 rewrote this test rather than deleting it. It asserted a 400 for
  // any non-.md path, which was the rule at the time; the rule is now "any text
  // file, but never a binary one decoded into a string". The old assertion
  // encoded the restriction being lifted, so keeping it would have blocked the
  // change — and deleting it outright would have dropped the coverage that a
  // .txt actually resolves rather than 404ing for some other reason.
  it('serves a plain-text file that is not markdown', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs/main/docs/notes.txt'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
    expect(cap.raw).toBe('not markdown')
  })

  it('refuses a non-GET method', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs?workspaceId=main', 'POST'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(405)
  })
})

// TASK-1787 — the listing widens to the whole tree on request, and the file
// route stops pretending everything is markdown.
describe('isBinaryPath', () => {
  it('classifies by extension, case-insensitively', () => {
    expect(isBinaryPath('assets/logo.PNG')).toBe(true)
    expect(isBinaryPath('src/app.ts')).toBe(false)
  })

  it('treats an extensionless file as text rather than guessing', () => {
    // LICENSE, Dockerfile, .gitignore — refusing these would hide real content
    // to avoid a rare mistake, which is the wrong trade for a read-only viewer.
    expect(isBinaryPath('LICENSE')).toBe(false)
    expect(isBinaryPath('Dockerfile')).toBe(false)
  })
})

describe('listWorkspaceDocs include modes', () => {
  it('defaults to markdown only — unchanged from TASK-1749', () => {
    const docs = listWorkspaceDocs(root)
    expect(docs.every((d) => d.path.endsWith('.md'))).toBe(true)
    expect(docs.some((d) => d.path === 'src/app.ts')).toBe(false)
  })

  it('collects every file when asked, and strictly more of them', () => {
    const md = listWorkspaceDocs(root, 'md')
    const all = listWorkspaceDocs(root, 'all')
    expect(all.length).toBeGreaterThan(md.length)
    expect(all.some((d) => d.path === 'src/app.ts')).toBe(true)
    // The control: the md listing is not merely a prefix of a broken walk.
    expect(md.every((d) => all.some((a) => a.path === d.path))).toBe(true)
  })

  it('marks a binary file and leaves a source file unmarked', () => {
    const all = listWorkspaceDocs(root, 'all')
    expect(all.find((d) => d.path === 'src/logo.png')?.binary).toBe(true)
    // Paired control — a flag set on everything would pass the line above.
    expect(all.find((d) => d.path === 'src/app.ts')?.binary).toBeUndefined()
  })

  it('still skips node_modules and .git in ALL mode', () => {
    // The whole reason SKIP_DIRS exists, and the exact place widening the walk
    // would lose it: node_modules is 678 of choda-deck's 877 markdown files, and
    // far more once every extension counts.
    const all = listWorkspaceDocs(root, 'all')
    expect(all.some((d) => d.path.includes('node_modules'))).toBe(false)
    expect(all.some((d) => d.path.includes('.git/'))).toBe(false)
  })
})

describe('serving a non-markdown file', () => {
  it('returns a source file as text/plain, not text/markdown', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs/main/src/app.ts'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
    expect(cap.raw).toContain('export const x = 1')
    expect(cap.headers?.['content-type']).toContain('text/plain')
  })

  it('still labels markdown as markdown — the control for the line above', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs/main/README.md'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.headers?.['content-type']).toContain('text/markdown')
  })

  it('REFUSES a binary file with 415 rather than decoding it', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs/main/src/logo.png'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    // Decoding png bytes as utf8 yields a string. It is just not the file.
    expect(cap.status).toBe(415)
  })

  it('rejects a traversal attempt in ALL mode too', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(
      req('/workspace-docs/main/../secret-outside.md'),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(cap.status).toBe(400)
    expect(cap.raw).not.toContain('SECRET')
  })
})

describe('the include param itself', () => {
  it('rejects a value that is neither md nor all', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(
      req('/workspace-docs?workspaceId=main&include=everything'),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    // Silently treating an unknown value as a default is how a caller cannot
    // tell a working param from a discarded one — the TASK-1773 failure.
    expect(cap.status).toBe(400)
  })

  it('serves the wider tree when include=all reaches the route', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(
      req('/workspace-docs?workspaceId=main&include=all'),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    const body = cap.body as { docs: Array<{ path: string }> }
    expect(body.docs.some((d) => d.path === 'src/app.ts')).toBe(true)
  })
})
