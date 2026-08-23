// TASK-1749 — workspace docs browsing. The listing runs against a real temp
// tree rather than a mocked fs, because the two things most likely to break are
// the node_modules filter and the traversal guard, and both are properties of
// the real filesystem walk.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleWorkspaceDocsRoute, listWorkspaceDocs } from './workspace-docs'
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
    end(payload?: string) {
      cap.raw = payload
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

  it('refuses a path without a .md extension', async () => {
    const cap = {} as Captured
    await handleWorkspaceDocsRoute(req('/workspace-docs/main/docs/notes.txt'), fakeRes(cap), {
      svc: svcFor(root),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(400)
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
