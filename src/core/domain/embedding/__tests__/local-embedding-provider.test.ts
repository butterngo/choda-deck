import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  LocalEmbeddingProvider,
  LOCAL_MODEL_DTYPE,
  LOCAL_PROVIDER_ID
} from '../local-embedding-provider'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '../../../../..', rel), 'utf8')

// TASK-3203 — the variant that loads is named in the id, so stored vectors from
// another variant are detected and re-embedded instead of silently compared.
describe('LocalEmbeddingProvider variant', () => {
  it('names the q8 variant in its id', () => {
    expect(new LocalEmbeddingProvider().id).toBe('local-minilm-l6-v2-q8')
    expect(LOCAL_MODEL_DTYPE).toBe('q8')
  })

  it('builds the pipeline with dtype, not the transformers v2 option', () => {
    const src = read('src/core/domain/embedding/local-embedding-provider.ts')
    expect(src).toContain('{ dtype: LOCAL_MODEL_DTYPE }')
    expect(src).not.toMatch(/quanti[z]ed\s*:/)
  })

  // TASK-3261 — the backfill no longer restates the id or the dtype: the
  // script only delegates to the CLI, which embeds through this provider.
  it('the backfill script delegates instead of restating the provider', () => {
    const script = read('scripts/backfill-embeddings.mjs')
    expect(script).toContain("'knowledge', 'backfill'")
    expect(script).not.toContain(LOCAL_PROVIDER_ID)
    expect(script).not.toMatch(/quanti[z]ed\s*:|dtype/)
  })
})
