// TASK-1974 — a build script the Dockerfile never copies fails at module
// resolution, inside a docker layer, minutes into CI.
//
// That is how `node scripts/record-bundle-size.mjs` broke the image: d20e6d0
// (TASK-1941) added it to `build:companion` and did not extend the Dockerfile's
// narrow `COPY scripts/prepare.mjs`. Nothing in the repo could notice, so the
// docker job simply stayed red and everyone read past it.
//
// This test is the loud failure that should have existed. It reads what
// `pnpm run build` actually shells out to and checks the image can reach it,
// which costs milliseconds and does not need docker.

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '..')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')

/** Every `scripts/<file>` path invoked by a script `pnpm run build` reaches. */
function scriptsReachedByBuild(): string[] {
  const seen = new Set<string>()
  const found = new Set<string>()

  const walk = (name: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    const body = pkg.scripts[name]
    if (!body) return

    for (const m of body.matchAll(/(?:^|[\s&|;'"(])(scripts\/[A-Za-z0-9._/-]+)/g)) {
      found.add(m[1])
    }
    // `pnpm run build` is a chain of other scripts; follow them.
    for (const m of body.matchAll(/pnpm run ([A-Za-z0-9:_-]+)/g)) walk(m[1])
  }

  walk('build')
  return [...found]
}

/**
 * The builder stage's COPY lines that land before the build runs. A COPY placed
 * after `RUN pnpm run build` is too late to help it, so the slice matters.
 */
function copiesBeforeBuild(): string[] {
  const upToBuild = dockerfile.split(/^RUN pnpm run build$/m)[0]
  return [...upToBuild.matchAll(/^COPY\s+(?:--[^\s]+\s+)*(.+)$/gm)].map((m) => m[1].trim())
}

function isCopiedBeforeBuild(scriptPath: string): boolean {
  return copiesBeforeBuild().some((line) => {
    const sources = line.split(/\s+/).slice(0, -1) // last token is the destination
    return sources.some((src) => src === scriptPath || src === 'scripts' || src === 'scripts/')
  })
}

describe('TASK-1974 — the Docker builder can reach every script the build runs', () => {
  it('finds the build scripts at all (guards the parser, not the Dockerfile)', () => {
    // If this list is ever empty the assertions below pass vacuously, which is
    // the one way this test could go green while proving nothing.
    const reached = scriptsReachedByBuild()
    expect(reached.length).toBeGreaterThan(0)
    expect(reached).toContain('scripts/record-bundle-size.mjs')
  })

  it.each(scriptsReachedByBuild())('copies %s into the builder before the build', (scriptPath) => {
    expect(fs.existsSync(path.join(ROOT, scriptPath))).toBe(true)
    expect(isCopiedBeforeBuild(scriptPath)).toBe(true)
  })

  it('copies prepare.mjs early too — the install hook needs it before that point', () => {
    const beforeInstall = dockerfile.split(/^RUN --mount=type=cache/m)[0]
    expect(beforeInstall).toContain('scripts/prepare.mjs')
  })
})
