import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getLocalEmbeddingReadiness, setLocalModelCacheDir } from '../src/knowledge/embed.js'
import { assertLocalRerankerReady } from '../src/knowledge/localModels.js'
import { LOCAL_MODEL_RUNTIME } from '../src/knowledge/local-model-runtime.js'

describe('local model runtime upgrade readiness', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-runtime-ready-'))
    setLocalModelCacheDir(root)
  })
  afterEach(async () => {
    setLocalModelCacheDir(undefined)
    await rm(root, { recursive: true, force: true })
  })

  async function fixture(kind: 'embedding' | 'reranking', runtime: Record<string, string>) {
    const modelId = kind === 'embedding' ? 'Xenova/bge-small-en-v1.5' : 'Xenova/bge-reranker-base'
    const directory = join(root, modelId)
    await mkdir(join(directory, 'onnx'), { recursive: true })
    const paths = ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']
    const files = await Promise.all(paths.map(async path => {
      const file = join(directory, path)
      await writeFile(file, path.endsWith('.onnx') ? 'cached weights' : '{}')
      const metadata = await stat(file)
      return { path, size: metadata.size, mtimeMs: Math.trunc(metadata.mtimeMs) }
    }))
    files.sort((a, b) => a.path.localeCompare(b.path))
    const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    const marker = kind === 'embedding' ? '.dsh-embedding-ready.json' : '.dsh-rerank-ready.json'
    await writeFile(join(directory, marker), JSON.stringify({
      schemaVersion: 1, modelId, kind, support: 'official', fingerprint,
      dimensions: 384, validatedAt: Date.now(), latencyMs: 1,
      runtime: { node: process.versions.node, ...runtime },
    }))
    return { modelId, weights: join(directory, 'onnx/model_quantized.onnx') }
  }

  it.each(['embedding', 'reranking'] as const)('accepts %s evidence from the new runtime', async kind => {
    const { modelId } = await fixture(kind, LOCAL_MODEL_RUNTIME)
    if (kind === 'embedding') expect(await getLocalEmbeddingReadiness(modelId)).toBeDefined()
    else await expect(assertLocalRerankerReady(modelId)).resolves.toBeUndefined()
  })

  it.each([
    ['embedding', { transformers: '3.7.x', onnxruntime: '1.21.0' }],
    ['reranking', { transformers: '3.7.x', onnxruntime: '1.21.0' }],
    ['embedding', { transformers: '4.3.1', onnxruntime: '1.21.0' }],
    ['reranking', { transformers: '4.3.1', onnxruntime: '1.21.0' }],
  ] as const)('requires %s revalidation when runtime is %j while retaining weights', async (kind, runtime) => {
    const { modelId, weights } = await fixture(kind, runtime)
    if (kind === 'embedding') expect(await getLocalEmbeddingReadiness(modelId)).toBeUndefined()
    else await expect(assertLocalRerankerReady(modelId)).rejects.toMatchObject({ code: 'model_unhealthy' })
    expect(await readFile(weights, 'utf8')).toBe('cached weights')
  })
})
