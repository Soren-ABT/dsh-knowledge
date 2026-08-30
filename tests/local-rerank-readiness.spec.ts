import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLocalModelCacheDir } from '../src/knowledge/embed.js'
import { assertLocalRerankerReady } from '../src/knowledge/localModels.js'

describe('local rerank readiness gate', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-rerank-ready-'))
    setLocalModelCacheDir(root)
  })

  afterEach(async () => {
    setLocalModelCacheDir(undefined)
    await rm(root, { recursive: true, force: true })
  })

  it('fails fast without downloading when the official model is absent', async () => {
    await expect(assertLocalRerankerReady('Xenova/bge-reranker-base'))
      .rejects.toMatchObject({ code: 'model_not_downloaded' })
  })

  it('requires custom models to be explicitly registered', async () => {
    await expect(assertLocalRerankerReady('custom/unregistered-reranker'))
      .rejects.toMatchObject({ code: 'unsupported_model' })
  })

  it('treats complete legacy files without a readiness marker as unverified', async () => {
    const modelRoot = join(root, 'Xenova', 'bge-reranker-base')
    await mkdir(join(modelRoot, 'onnx'), { recursive: true })
    await writeFile(join(modelRoot, 'config.json'), '{}')
    await writeFile(join(modelRoot, 'tokenizer.json'), '{}')
    await writeFile(join(modelRoot, 'onnx', 'model.onnx'), 'weights')
    await expect(assertLocalRerankerReady('Xenova/bge-reranker-base'))
      .rejects.toMatchObject({ code: 'model_unhealthy' })
  })
})
