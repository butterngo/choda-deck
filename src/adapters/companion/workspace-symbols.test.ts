// TASK-1797 — symbol lookup. Like workspace-docs.test.ts this runs against a
// real temp tree rather than a mocked fs, because the two things most likely to
// break are the definition ANCHOR (a plain name search would pass a naive test
// and return every call site in practice) and the binary/vendored filtering,
// and both are properties of the real walk.
//
// Nearly every test here carries a control: an assertion that the OPPOSITE case
// behaves differently. An implementation returning "no matches" for everything,
// or matching every occurrence of the name, would satisfy half of these
// criteria on its own — the controls are what make them able to fail.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import {
  handleWorkspaceSymbolsRoute,
  scanWorkspaceSymbols,
  definitionPattern,
  isSearchableName
} from './workspace-symbols'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const TOKEN = 'bridge-token-for-tests'

interface Captured {
  status: number
  body: unknown
  raw?: string
}

function fakeRes(cap: Captured): ServerResponse {
  return {
    writeHead(status: number) {
      cap.status = status
      return this
    },
    end(payload?: string) {
      cap.raw = payload
      try {
        cap.body = payload ? JSON.parse(payload) : undefined
      } catch {
        cap.body = undefined
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-symbols-'))
  fs.mkdirSync(path.join(root, 'src', 'Auth'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'some-pkg'), { recursive: true })

  // The real shape from the requirement: a C# declaration behind two modifiers.
  fs.writeFileSync(
    path.join(root, 'src', 'Auth', 'ServiceTokenAuth.cs'),
    [
      'namespace Api.Auth;',
      '',
      '// ServiceTokenWorkspaceFilter guards the workspace-scoped endpoints.',
      'public sealed class ServiceTokenWorkspaceFilter : IEndpointFilter',
      '{',
      '}'
    ].join('\n')
  )

  // A call site and a comment mention, in a DIFFERENT file, so a scan that
  // matched every occurrence would return this one too.
  fs.writeFileSync(
    path.join(root, 'src', 'Endpoints.cs'),
    [
      'public static class Routes',
      '{',
      '    // uses ServiceTokenWorkspaceFilter',
      '    public static void Map() =>',
      '        app.MapPatch("/x").AddEndpointFilter<Auth.ServiceTokenWorkspaceFilter>();',
      '}'
    ].join('\n')
  )

  // Two declarations of one name, to exercise multi-match ordering.
  fs.writeFileSync(path.join(root, 'src', 'a-dup.ts'), 'export type Duplicated = 1')
  fs.writeFileSync(path.join(root, 'src', 'b-dup.ts'), 'export interface Duplicated { x: number }')

  // A vendored declaration that must stay filtered.
  fs.writeFileSync(
    path.join(root, 'node_modules', 'some-pkg', 'index.ts'),
    'export class ServiceTokenWorkspaceFilter {}'
  )

  // A binary file whose BYTES contain the searched name — the case that makes
  // "skip binaries" a correctness rule and not a performance one.
  fs.writeFileSync(
    path.join(root, 'src', 'logo.png'),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from('class ServiceTokenWorkspaceFilter', 'utf8')
    ])
  )
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('definitionPattern / isSearchableName', () => {
  it('anchors on the keyword, so a call site is not a declaration', () => {
    const p = definitionPattern('ServiceTokenWorkspaceFilter')
    expect(p.test('public sealed class ServiceTokenWorkspaceFilter : IEndpointFilter')).toBe(true)
    // Control — the exact line from the requirement, which must NOT match.
    expect(p.test('.AddEndpointFilter<Auth.ServiceTokenWorkspaceFilter>();')).toBe(false)
  })

  it('does not match a longer name that merely starts with the query', () => {
    expect(definitionPattern('Foo').test('class FooBar {}')).toBe(false)
    expect(definitionPattern('Foo').test('class Foo {}')).toBe(true)
  })

  it('refuses a name that is not an identifier', () => {
    // Without this the name reaches a RegExp and `.*` would match everything.
    expect(isSearchableName('.*')).toBe(false)
    expect(isSearchableName('Foo|Bar')).toBe(false)
    expect(isSearchableName('ServiceTokenWorkspaceFilter')).toBe(true)
  })
})

describe('scanWorkspaceSymbols', () => {
  // AC-1
  it('finds a C# declaration behind modifiers, at the right line', () => {
    const matches = scanWorkspaceSymbols(root, 'ServiceTokenWorkspaceFilter')
    const decl = matches.filter((m) => m.path === 'src/Auth/ServiceTokenAuth.cs')
    expect(decl).toHaveLength(1)
    expect(decl[0]?.line).toBe(4)
    expect(decl[0]?.kind).toBe('class')
    expect(decl[0]?.text).toBe('public sealed class ServiceTokenWorkspaceFilter : IEndpointFilter')
  })

  // AC-3 — the criterion the whole heuristic exists for.
  it('ignores the call site and the comment mention', () => {
    const paths = scanWorkspaceSymbols(root, 'ServiceTokenWorkspaceFilter').map((m) => m.path)
    expect(paths).not.toContain('src/Endpoints.cs')
    // Control: the declaration of the same name IS present, so an
    // implementation that found nothing at all would fail this too.
    expect(paths).toContain('src/Auth/ServiceTokenAuth.cs')
  })

  // AC-8
  it('never reads a binary file, even when its bytes contain the name', () => {
    const paths = scanWorkspaceSymbols(root, 'ServiceTokenWorkspaceFilter').map((m) => m.path)
    expect(paths).not.toContain('src/logo.png')
  })

  it('skips vendored declarations under node_modules', () => {
    const paths = scanWorkspaceSymbols(root, 'ServiceTokenWorkspaceFilter').map((m) => m.path)
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('returns every declaration of a duplicated name, ordered by path', () => {
    const matches = scanWorkspaceSymbols(root, 'Duplicated')
    expect(matches.map((m) => m.path)).toEqual(['src/a-dup.ts', 'src/b-dup.ts'])
    expect(matches.map((m) => m.kind)).toEqual(['type', 'interface'])
  })

  // AC-2
  it('returns an empty array for a name nothing declares', () => {
    expect(scanWorkspaceSymbols(root, 'NotDeclaredAnywhere')).toEqual([])
    // Control: a name that DOES resolve is non-empty, so an implementation
    // always returning [] would fail here.
    expect(scanWorkspaceSymbols(root, 'ServiceTokenWorkspaceFilter').length).toBeGreaterThan(0)
  })
})

describe('handleWorkspaceSymbolsRoute', () => {
  it('returns false for a path that is not ours', async () => {
    const cap = {} as Captured
    expect(
      await handleWorkspaceSymbolsRoute(req('/workspace-docs?workspaceId=main'), fakeRes(cap), {
        svc: svcFor(root),
        bridgeToken: TOKEN
      })
    ).toBe(false)
  })

  // AC-1 at the route level
  it('answers 200 with the declaration', async () => {
    const cap = {} as Captured
    await handleWorkspaceSymbolsRoute(
      req('/workspace-symbols?workspaceId=main&name=ServiceTokenWorkspaceFilter'),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(cap.status).toBe(200)
    const body = cap.body as { name: string; matches: { path: string; line: number }[] }
    expect(body.name).toBe('ServiceTokenWorkspaceFilter')
    expect(body.matches.find((m) => m.path === 'src/Auth/ServiceTokenAuth.cs')?.line).toBe(4)
  })

  // AC-2 at the route level — the status code is the point.
  it('answers 200 and an empty array for an unknown name, never 404', async () => {
    const cap = {} as Captured
    await handleWorkspaceSymbolsRoute(
      req('/workspace-symbols?workspaceId=main&name=NotDeclaredAnywhere'),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(cap.status).toBe(200)
    expect((cap.body as { matches: unknown[] }).matches).toEqual([])
  })

  // AC-4 — and it must cost nothing: the workspace is never even looked up.
  it('answers 400 for a missing or blank name, without touching the workspace', async () => {
    for (const url of [
      '/workspace-symbols?workspaceId=main',
      '/workspace-symbols?workspaceId=main&name=',
      '/workspace-symbols?workspaceId=main&name=%20%20'
    ]) {
      const cap = {} as Captured
      let lookups = 0
      const svc = {
        getWorkspace: async () => {
          lookups++
          return { id: 'main', label: 'Main', cwd: root, projectId: 'p1' } as never
        }
      } as unknown as WorkspaceOperations
      await handleWorkspaceSymbolsRoute(req(url), fakeRes(cap), { svc, bridgeToken: TOKEN })
      expect(cap.status).toBe(400)
      expect(lookups).toBe(0)
    }
  })

  it('answers 400 for a name that is not an identifier', async () => {
    const cap = {} as Captured
    await handleWorkspaceSymbolsRoute(
      req('/workspace-symbols?workspaceId=main&name=.*'),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(cap.status).toBe(400)
  })

  // AC-5 — the BODY is the contract, not just the code: the web client tells an
  // unknown workspace from an adapter too old to have this route by reading it.
  it('answers 404 naming the workspace, distinct from the router default body', async () => {
    const cap = {} as Captured
    await handleWorkspaceSymbolsRoute(
      req('/workspace-symbols?workspaceId=ghost&name=Foo'),
      fakeRes(cap),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(cap.status).toBe(404)
    expect((cap.body as { error: string }).error).toBe('unknown workspace: ghost')
    expect((cap.body as { error: string }).error).not.toBe('not found')
  })

  // AC-6
  it('answers 401 without a token and 405 for a non-GET', async () => {
    const unauthorised = {} as Captured
    await handleWorkspaceSymbolsRoute(
      req('/workspace-symbols?workspaceId=main&name=Foo', 'GET', null),
      fakeRes(unauthorised),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(unauthorised.status).toBe(401)
    expect(unauthorised.body).not.toHaveProperty('matches')

    const wrongMethod = {} as Captured
    await handleWorkspaceSymbolsRoute(
      req('/workspace-symbols?workspaceId=main&name=Foo', 'POST'),
      fakeRes(wrongMethod),
      { svc: svcFor(root), bridgeToken: TOKEN }
    )
    expect(wrongMethod.status).toBe(405)
  })

  // AC-7
  it('answers 409 when the workspace cwd is gone', async () => {
    const cap = {} as Captured
    const missing = path.join(root, 'does-not-exist')
    await handleWorkspaceSymbolsRoute(
      req('/workspace-symbols?workspaceId=main&name=Foo'),
      fakeRes(cap),
      { svc: svcFor(missing), bridgeToken: TOKEN }
    )
    expect(cap.status).toBe(409)
    expect(cap.body).toMatchObject({ workspaceId: 'main', label: 'Main', cwd: missing })
  })
})
