// TASK-1873 — images. Every test injects a reader and a spawner; none touches a
// daemon, and none removes anything.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import {
  handleDockerImageRoute,
  imageMatchesRef,
  parseImages,
  reclaimedFrom,
  removedCountFrom
} from './docker-images'
import type { DockerReader } from './docker-containers'
import type { DockerSpawner, SpawnResult } from './docker-actions'

const TOKEN = 'image-token'

const img = (id: string, repo: string, tag: string, size = '100MB'): string =>
  [id, repo, tag, size, '2026-09-04 10:18:20 +0700 +07'].join('\t')

const IMAGES = [
  img('aaa111', 'newjuvenismaxime-jm-api', 'latest', '421MB'),
  img('bbb222', 'postgres', '16', '420MB'),
  img('ccc333', 'ghcr.io/sooperset/mcp-atlassian', 'latest', '90MB'),
  // Untagged — the kind a reader most wants gone, so it must be listed.
  img('ddd444', '<none>', '<none>', '1.04GB'),
  img('eee555', 'unused-thing', '1.0', '12MB')
].join('\n')

// Container image refs as the daemon really reports them: a bare repository with
// :latest implied, a tagged one, and a registry-qualified one.
const PS = [
  'c1\tjm-api\trunning\tUp 3h\tnewjuvenismaxime-jm-api\tp\tC:\\x',
  'c2\tchatengine-db\trunning\tUp 3h\tpostgres:16\tp\tC:\\x',
  'c3\texciting_goodall\trunning\tUp 3h\tghcr.io/sooperset/mcp-atlassian:latest\t\t'
].join('\n')

let spawns: { args: string[]; deadlineMs: number }[] = []
let available = true
let imagesOut: string
let psOut: string
let spawnImpl: (args: string[], deadlineMs: number) => Promise<SpawnResult>

const reader: DockerReader = {
  available: () => available,
  ps: () => psOut,
  logs: () => '',
  images: () => imagesOut
}

const spawner: DockerSpawner = (args, deadlineMs) => {
  spawns.push({ args, deadlineMs })
  return spawnImpl(args, deadlineMs)
}

const exits = (code: number, stdout = ''): Promise<SpawnResult> =>
  Promise.resolve({ code, timedOut: false, tookMs: 20, stdout })

let server: Server
let base: string

async function call(
  path: string,
  method = 'GET',
  token: string | null = TOKEN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
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

beforeEach(async () => {
  spawns = []
  available = true
  imagesOut = IMAGES
  psOut = PS
  spawnImpl = () => exits(0)

  server = createServer((req, res) => {
    void handleDockerImageRoute(req, res, { bridgeToken: TOKEN, reader, spawner }).then((h) => {
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

const list = async (): Promise<{ id: string; repository: string; inUseBy: string[]; size: string }[]> =>
  (await call('/docker/images')).body.images as never

// ---------------------------------------------------------------------------

describe('AC-1 — every image, including the untagged ones', () => {
  it('lists all five with a size, and keeps the <none> one', async () => {
    const images = await list()
    expect(images).toHaveLength(5)
    const dangling = images.find((i) => i.id === 'ddd444')
    // Omitting untagged images would hide exactly the ones a reader is looking
    // for when they open this list.
    expect(dangling?.repository).toBe('<none>')
    expect(dangling?.size).toBe('1.04GB')
  })
})

describe('AC-2 — in-use is computed, and it names the holder', () => {
  it('reports the container NAME for a used image and an empty array for an unused one', async () => {
    const images = await list()
    // Both in one test, asserted different: a route that returned [] for
    // everything would pass a used-only check.
    expect(images.find((i) => i.id === 'aaa111')?.inUseBy).toEqual(['jm-api'])
    expect(images.find((i) => i.id === 'eee555')?.inUseBy).toEqual([])
  })

  it('matches the three reference shapes the daemon actually emits', () => {
    // Measured on the real machine: ps reports a REFERENCE, not an id.
    const api = { id: 'aaa111', repository: 'newjuvenismaxime-jm-api', tag: 'latest' }
    // A bare repository means :latest, and only then.
    expect(imageMatchesRef(api, 'newjuvenismaxime-jm-api')).toBe(true)

    const pg = { id: 'bbb222', repository: 'postgres', tag: '16' }
    expect(imageMatchesRef(pg, 'postgres:16')).toBe(true)
    // postgres:16 is NOT postgres:latest — the implicit-latest rule must not
    // leak into tagged images.
    expect(imageMatchesRef(pg, 'postgres')).toBe(false)

    const ghcr = { id: 'ccc333', repository: 'ghcr.io/sooperset/mcp-atlassian', tag: 'latest' }
    expect(imageMatchesRef(ghcr, 'ghcr.io/sooperset/mcp-atlassian:latest')).toBe(true)
    // A registry-qualified image must not match the bare trailing name.
    expect(imageMatchesRef(ghcr, 'mcp-atlassian')).toBe(false)
  })

  it('matches a raw id, for a container whose image was untagged after it started', () => {
    expect(imageMatchesRef({ id: 'ddd444', repository: '<none>', tag: '<none>' }, 'ddd444')).toBe(true)
  })
})

describe('AC-3 — the in-use refusal is ours, and nothing is spawned', () => {
  it('409s naming the holders without calling rmi at all', async () => {
    const { status, body } = await call('/docker/images/aaa111', 'DELETE')
    expect(status).toBe(409)
    expect(body.by).toEqual(['jm-api'])
    // Letting the daemon refuse would work today, and would mean that adding
    // --force later silently removes the guard as well as the error.
    expect(spawns).toEqual([])
  })

  it('CONTROL — an unused image IS removed, so the refusal is not universal', async () => {
    const { status } = await call('/docker/images/eee555', 'DELETE')
    expect(status).toBe(200)
    expect(spawns).toHaveLength(1)
  })
})

describe('AC-4 — no force, ever', () => {
  it('the removal argv is exactly rmi and the id', async () => {
    await call('/docker/images/eee555', 'DELETE')
    // Asserted WHOLE rather than by substring: the argv is the boundary here,
    // and toContain would pass with -f appended.
    expect(spawns[0].args).toEqual(['rmi', 'eee555'])
  })

  it('the REMOVAL argv carries no force flag, while prune keeps its own -f', async () => {
    await call('/docker/images/eee555', 'DELETE')
    await call('/docker/images/prune', 'POST')

    // The two -f flags are different words. `docker rmi -f` force-removes an
    // image a container depends on, which is the thing this task refuses.
    // `docker image prune -f` only means "do not ask me to confirm", and a
    // prune that asks would hang forever with no terminal to answer it.
    // Banning the character across both argv confused the two, which is what
    // this test originally did.
    expect(spawns[0].args).toEqual(['rmi', 'eee555'])
    expect(spawns[0].args).not.toContain('-f')
    expect(spawns[0].args).not.toContain('--force')

    expect(spawns[1].args).toEqual(['image', 'prune', '-f'])
    expect(spawns[1].args).not.toContain('--force')
  })
})

describe('AC-5 — the id never reaches argv unchecked', () => {
  it('404s an unknown id and an id shaped like a flag, spawning nothing', async () => {
    expect((await call('/docker/images/nope', 'DELETE')).status).toBe(404)
    expect((await call(`/docker/images/${encodeURIComponent('--force')}`, 'DELETE')).status).toBe(404)
    expect(spawns).toEqual([])
  })
})

describe('AC-8 — prune says what it did, including nothing', () => {
  it('reports the count and the reclaimed space', async () => {
    spawnImpl = () =>
      exits(
        0,
        'Deleted: sha256:aaa\nUntagged: foo:latest\nDeleted: sha256:bbb\n\nTotal reclaimed space: 1.2GB\n'
      )
    const { status, body } = await call('/docker/images/prune', 'POST')
    expect(status).toBe(200)
    expect(body.removed).toBe(3)
    expect(body.freed).toBe('1.2GB')
  })

  it('reports zero explicitly when there was nothing to prune', async () => {
    spawnImpl = () => exits(0, 'Total reclaimed space: 0B\n')
    const { body } = await call('/docker/images/prune', 'POST')
    // A silent success is indistinguishable from a prune that did nothing.
    expect(body.removed).toBe(0)
    expect(body.freed).toBe('0B')
  })

  it('parses the reclaimed line and the deleted count independently', () => {
    expect(reclaimedFrom('Total reclaimed space: 512.3MB')).toBe('512.3MB')
    expect(reclaimedFrom('nothing here')).toBe('0B')
    expect(removedCountFrom('Deleted: a\nuntagged: b\nnoise\n')).toBe(2)
  })
})

describe('the gates this route shares with its siblings', () => {
  it('501s with no daemon and never lists', async () => {
    available = false
    expect((await call('/docker/images')).status).toBe(501)
  })

  it('401s without the token', async () => {
    expect((await call('/docker/images', 'GET', null)).status).toBe(401)
  })

  it('405s the wrong verb on each shape', async () => {
    expect((await call('/docker/images', 'DELETE')).status).toBe(405)
    expect((await call('/docker/images/prune', 'GET')).status).toBe(405)
    expect((await call('/docker/images/eee555', 'GET')).status).toBe(405)
  })

  it('a listing that throws is 502 with our own message', async () => {
    imagesOut = ''
    const boom: DockerReader = {
      ...reader,
      images: () => {
        throw new Error('Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine')
      }
    }
    const local = createServer((req, res) => {
      void handleDockerImageRoute(req, res, { bridgeToken: TOKEN, reader: boom, spawner })
    })
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
    const res = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/docker/images`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    const raw = await res.text()
    await new Promise<void>((r) => local.close(() => r()))
    expect(res.status).toBe(502)
    expect(raw).not.toContain('npipe')
  })
})

describe('parseImages — the pure half', () => {
  it('survives a short row rather than throwing', () => {
    const out = parseImages('zzz1\tlonely', '')
    expect(out).toHaveLength(1)
    expect(out[0].tag).toBe('<none>')
    expect(out[0].inUseBy).toEqual([])
  })
})
