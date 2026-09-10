// TASK-1935 — the three primitives a route needs to write a user's own file
// without changing anything the user did not.
//
// These were written for TASK-1841 and lived privately inside claude-config.ts.
// A second route now writes files (`PUT /workspace-docs/...`), and copying them
// across would leave two implementations of one promise: *the bytes go to disk
// exactly as they arrived*. The two copies would agree today and drift the first
// time one of them is "improved" — which is how the BOM and the line endings get
// lost in the first place.
//
// Behaviour is unchanged from the originals; this is a move, not a rewrite.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { createHash } from 'crypto'
import type { IncomingMessage } from 'http'

/** The cap both write routes enforce. */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * The request body as RAW BYTES, or null once the cap is exceeded.
 *
 * Deliberately not a decode-and-parse read. A file's bytes are the payload here:
 * decoding and re-encoding is exactly the round trip that loses a BOM and
 * rewrites line endings, and these routes' whole promise is that they do not
 * transform what they are given.
 *
 * The cap is enforced WHILE reading, not after — a 500 MB body must not be
 * buffered first and rejected second.
 */
export function readRawBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      total += c.length
      if (total > MAX_WRITE_BYTES) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Write via a temp file in the SAME directory, then rename.
 *
 * The stakes are what justify it: truncating a file halfway leaves it unusable,
 * and these routes keep no backup — the 409 is the only thing between two
 * writers and a lost edit, and it cannot help if the file is already
 * half-written. Rename within a directory is atomic on both platforms; across
 * directories it is not, which is why the temp file is a sibling rather than in
 * os.tmpdir().
 */
export function writeAtomic(target: string, bytes: Buffer): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`)
  try {
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, target)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // The temp file may never have been created; failing to remove it must
      // not mask the write error being thrown.
    }
    throw err
  }
}
