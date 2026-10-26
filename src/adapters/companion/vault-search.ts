// TASK-2754 — full-text search over the two vault folders the assistant may
// read, shared by `GET /vault/search` and the in-process `search_vault` tool so
// both return the same hits. Moved out of assistant-read-services.ts unchanged.
//
// 20-Areas (personal) is never walked: the roots are the two folders, not the
// vault, so the scoping is structural rather than a filter on the results.

import * as fs from 'fs'
import * as path from 'path'

/** The two vault folders the assistant may read. 20-Areas (personal) is never reachable. */
export const VAULT_READABLE_DIRS = ['10-Projects', '30-Knowledge'] as const
const VAULT_MAX_FILES = 3000
const SNIPPET = 160

export interface VaultSearchHit {
  /** Relative to the vault root, e.g. `30-Knowledge/acceptance-criteria.md`. */
  path: string
  snippet: string
}

export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

function* markdownFiles(root: string, rel = ''): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const child = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) yield* markdownFiles(root, child)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield child
  }
}

/** Notes whose path or text contains every word of `query`, at most `limit`. */
export function searchVaultFiles(vaultDir: string, query: string, limit: number): VaultSearchHit[] {
  const q = searchWords(query)
  const hits: VaultSearchHit[] = []
  let seen = 0
  for (const dir of VAULT_READABLE_DIRS) {
    const root = path.resolve(vaultDir, dir)
    for (const rel of markdownFiles(root)) {
      if (++seen > VAULT_MAX_FILES || hits.length >= limit) break
      const full = `${dir}/${rel}`
      let text: string
      try {
        text = fs.readFileSync(path.join(root, rel), 'utf8')
      } catch {
        continue
      }
      const hay = `${full}\n${text}`.toLowerCase()
      if (!q.every((w) => hay.includes(w))) continue
      const at = Math.max(0, text.toLowerCase().indexOf(q[0] ?? ''))
      hits.push({ path: full, snippet: text.slice(Math.max(0, at - 40), at + SNIPPET).replace(/\s+/g, ' ') })
    }
  }
  return hits
}
