import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  loadEmbeddingProvider,
  resolveProviderKey
} from '../embedding-provider-factory'
import { NoopEmbeddingProvider } from '../noop-embedding-provider'
import { EmbeddingProviderUnavailableError } from '../embedding-provider.interface'

const ENV = 'CHODA_EMBEDDING_PROVIDER'
let original: string | undefined

beforeEach(() => {
  original = process.env[ENV]
})

afterEach(() => {
  if (original === undefined) delete process.env[ENV]
  else process.env[ENV] = original
})

describe('resolveProviderKey', () => {
  it('defaults to local when env is unset', () => {
    delete process.env[ENV]
    expect(resolveProviderKey()).toBe('local')
  })

  it('treats noop / off / false / 0 as noop', () => {
    for (const v of ['noop', 'off', 'false', '0']) {
      process.env[ENV] = v
      expect(resolveProviderKey()).toBe('noop')
    }
  })

  it('throws on unknown values', () => {
    process.env[ENV] = 'voyage'
    expect(() => resolveProviderKey()).toThrow(/Unsupported/)
  })
})

describe('loadEmbeddingProvider', () => {
  it('returns NoopEmbeddingProvider for noop key', async () => {
    const p = await loadEmbeddingProvider('noop')
    expect(p.id).toBe('noop')
    expect(p.dims).toBe(0)
  })
})

describe('NoopEmbeddingProvider', () => {
  it('embed throws EmbeddingProviderUnavailableError', async () => {
    const p = new NoopEmbeddingProvider('test reason')
    await expect(p.embed()).rejects.toBeInstanceOf(EmbeddingProviderUnavailableError)
  })

  it('embedBatch throws EmbeddingProviderUnavailableError', async () => {
    const p = new NoopEmbeddingProvider('test reason')
    await expect(p.embedBatch()).rejects.toBeInstanceOf(EmbeddingProviderUnavailableError)
  })
})
