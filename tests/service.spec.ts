import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { KnowledgeService } from '../src/knowledge/index.js'
import type { Config } from '../src/knowledge/config.js'
import type { KnowledgeService as KnowledgeServiceType } from '../src/knowledge/index.js'

const DEFAULT_CONFIG: Config = {
  embeddingProvider: 'none',
  embeddingBaseUrl: '',
  embeddingModel: '',
  embeddingApiKey: '',
  rerankModel: '',
  rerankBaseUrl: '',
  rerankApiKey: '',
  smartChunk: true,
  chunkSeparator: '\n\n',
  chunkSize: 800,
  chunkOverlap: 100,
  topK: 6,
  searchMode: 'auto',
  similarityThreshold: 0,
  mmrDiversity: 0,
  rrfVectorWeight: 1,
  embeddingBatchSize: 32,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
}

function fakeWebServer() {
  const routes: unknown[] = []
  return {
    routes,
    register(route: unknown) {
      routes.push(route)
      return () => {}
    },
  }
}

async function mountService(): Promise<KnowledgeServiceType> {
  const ctx = new Context()
  ctx.provide('webServer', fakeWebServer())
  await ctx.plugin(KnowledgeService, DEFAULT_CONFIG)
  return ctx.get('knowledge') as unknown as KnowledgeServiceType
}

describe('KnowledgeService', () => {
  it('creates a base, adds a text document, and searches lexically', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'docs' })
    await service.addTextDocument({
      baseId: base.id,
      title: 'foxes',
      content: 'The quick brown fox jumps over the lazy dog. Foxes are quick and brown.',
    })
    const result = await service.search({ query: 'quick brown fox', baseId: base.id })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].documentTitle).toBe('foxes')
  })

  it('injects heading context into chunks', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'docs' })
    const doc = await service.addTextDocument({
      baseId: base.id,
      title: 'guide',
      content: '# Intro\n\nhello\n\n## Methods\n\nbody text here',
    })
    const chunks = service.listChunks(doc.id)
    const methods = chunks.find(c => c.text === 'body text here')
    expect(methods?.heading).toBe('Intro > Methods')
    expect(methods?.context).toBe('guide > Intro > Methods')
  })

  it('rejects duplicate content within a base', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'docs' })
    await service.addTextDocument({ baseId: base.id, title: 'one', content: 'same content' })
    await expect(service.addTextDocument({ baseId: base.id, title: 'two', content: 'same content' }))
      .rejects.toThrow(/duplicate/)
  })

  it('reindexes a document after a chunk-size change', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'docs' })
    const doc = await service.addTextDocument({ baseId: base.id, title: 'long', content: 'word '.repeat(2000) })
    const before = service.listChunks(doc.id).length

    await service.setConfig({ chunkSize: 300 })
    const reindexed = await service.reindexDocument(doc.id)
    const after = service.listChunks(reindexed.id).length
    expect(after).toBeGreaterThan(before)
  })

  it('rebuilds a whole base as a background job', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'docs' })
    await service.addTextDocument({ baseId: base.id, title: 'one', content: 'alpha '.repeat(60) })
    await service.addTextDocument({ baseId: base.id, title: 'two', content: 'beta '.repeat(60) })
    await service.createDirectory(base.id, 'folder')

    const started = await service.startReindexBase(base.id)
    expect(started.total).toBe(3)

    // Poll the job until it settles (fast with the lexical-only provider).
    let status = service.reindexJobStatus(started.jobId)
    for (let i = 0; i < 50 && (status === undefined || !status.done); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = service.reindexJobStatus(started.jobId)
    }
    expect(status?.done).toBe(true)
    expect(status?.imported).toBe(2) // two files re-embedded
    expect(status?.skipped).toBe(1) // directory container skipped
    expect(status?.errors).toHaveLength(0)
  })

  it('reports aggregate stats', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'stats' })
    await service.addTextDocument({ baseId: base.id, title: 'a', content: 'hello world '.repeat(10) })
    await service.addTextDocument({ baseId: base.id, title: 'b', content: 'another document' })

    const stats = service.stats(base.id)
    expect(stats.documentCount).toBe(2)
    expect(stats.chunkCount).toBe(2)
    expect(stats.charCount).toBeGreaterThan(0)
    expect(stats.tokenCount).toBeGreaterThan(0)
  })

  it('applies per-base config overrides without touching the global config', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'custom', config: { chunkSize: 200, topK: 8 } })
    expect(service.getConfigFor(base.id).chunkSize).toBe(200)
    expect(service.getConfigFor(base.id).topK).toBe(8)
    expect(service.getConfig().chunkSize).toBe(800)

    await service.renameBase(base.id, { config: { embeddingModel: 'per-base-model' } })
    expect(service.getConfigFor(base.id).embeddingModel).toBe('per-base-model')
    expect(service.getConfigFor(base.id).chunkSize).toBe(200)
  })

  it('applies per-base threshold / mmr / mode / batch overrides without touching the global config', async () => {
    const service = await mountService()
    const base = await service.createBase({
      name: 'thr',
      config: { similarityThreshold: 0.4, mmrDiversity: 0.2, searchMode: 'vector', embeddingBatchSize: 8 },
    })
    const cfg = service.getConfigFor(base.id)
    expect(cfg.similarityThreshold).toBe(0.4)
    expect(cfg.mmrDiversity).toBe(0.2)
    expect(cfg.searchMode).toBe('vector')
    expect(cfg.embeddingBatchSize).toBe(8)
    expect(service.getConfig().similarityThreshold).toBe(0)
    expect(service.getConfig().searchMode).toBe('auto')

    await service.renameBase(base.id, { config: { similarityThreshold: 0, mmrDiversity: 0 } })
    expect(service.getConfigFor(base.id).similarityThreshold).toBe(0)
    expect(service.getConfigFor(base.id).mmrDiversity).toBe(0)
  })

  it('deletes a base and hides its documents and chunks', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'tmp' })
    const doc = await service.addTextDocument({ baseId: base.id, title: 'd', content: 'some content here' })
    expect(service.listChunks(doc.id).length).toBeGreaterThan(0)

    await service.deleteBase(base.id)
    expect(service.listBases()).toHaveLength(0)
    // Base deletion is a single write on whole-unit-rewrite backends; child
    // records are orphaned but unreachable through every base-scoped read.
    expect(service.stats().documentCount).toBe(0)
    const stale = await service.search({ query: 'content', baseId: base.id })
    expect(stale.hits).toHaveLength(0)
  })

  it('stores and returns runtime config overrides', async () => {
    const service = await mountService()
    expect(service.getConfig().topK).toBe(6)
    await service.setConfig({ topK: 7, searchMode: 'hybrid' })
    expect(service.getConfig().topK).toBe(7)
    expect(service.getConfig().searchMode).toBe('hybrid')
  })

  it('keeps boolean config overrides and splits on the separator when smart chunking is off', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'sep', config: { smartChunk: false, chunkSeparator: '##END##' } })
    expect(service.getConfigFor(base.id).smartChunk).toBe(false)
    const doc = await service.addTextDocument({ baseId: base.id, title: 'sep', content: 'aaa##END##bbb##END##ccc' })
    expect(service.listChunks(doc.id)).toHaveLength(3)
  })

  it('reports search latency and rerank status', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'latency' })
    await service.addTextDocument({ baseId: base.id, title: 'd', content: 'hello world content here' })
    const result = await service.search({ query: 'hello', baseId: base.id })
    expect(result.reranked).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('replaces a same-name file entry when conflict is replace', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'conflict' })
    const content = Buffer.from('first version of the document').toString('base64')
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'notes.txt',
      contentBase64: content,
    })
    const content2 = Buffer.from('second version of the document').toString('base64')
    const doc2 = await service.addFileDocument({
      baseId: base.id,
      fileName: 'notes.txt',
      contentBase64: content2,
      conflict: 'replace',
    })
    expect(doc2.id).not.toBe(doc.id)
    expect(service.listDocuments(base.id)).toHaveLength(1)
  })

  it('creates, renames and deletes groups, moving member bases with them', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'a', group: '工作' })
    expect(service.listGroups()).toEqual(['工作'])

    await service.createGroup('研究')
    expect(service.listGroups()).toEqual(['工作', '研究'])

    await service.renameGroup('工作', '工作笔记')
    expect(service.listBases().find(b => b.id === base.id)?.group).toBe('工作笔记')

    await service.deleteGroup('工作笔记')
    expect(service.listBases().find(b => b.id === base.id)?.group).toBeUndefined()
  })

  it('bumps base updatedAt when documents are added or removed', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'touch' })
    const before = service.listBases()[0].updatedAt
    await new Promise(resolve => setTimeout(resolve, 5))
    const doc = await service.addTextDocument({ baseId: base.id, title: 'd', content: 'fresh content' })
    const afterAdd = service.listBases()[0].updatedAt
    expect(afterAdd).toBeGreaterThan(before)
    await new Promise(resolve => setTimeout(resolve, 5))
    await service.deleteDocument(doc.id)
    const afterDelete = service.listBases()[0].updatedAt
    expect(afterDelete).toBeGreaterThan(afterAdd)
  })

  it('bulk reindexes and deletes multiple documents', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'bulk' })
    const a = await service.addTextDocument({ baseId: base.id, title: 'a', content: 'alpha content here' })
    const b = await service.addTextDocument({ baseId: base.id, title: 'b', content: 'beta content here' })
    const c = await service.addTextDocument({ baseId: base.id, title: 'c', content: 'gamma content here' })
    expect(service.listDocuments(base.id)).toHaveLength(3)

    const reindexed = await service.reindexDocuments([a.id, b.id])
    expect(reindexed.reindexed).toBe(2)

    const deleted = await service.deleteDocuments([a.id, b.id])
    expect(deleted.deleted).toBe(2)
    expect(service.listDocuments(base.id).map(doc => doc.id)).toEqual([c.id])
  })

  it('records the embedding error instead of failing silently', async () => {
    const service = await mountService()
    // Point at a closed port so the OpenAI-compatible call fails fast and deterministically.
    const base = await service.createBase({
      name: 'embed-fail',
      config: { embeddingProvider: 'openai', embeddingBaseUrl: 'http://127.0.0.1:1', embeddingModel: 'x' },
    })
    const doc = await service.addTextDocument({ baseId: base.id, title: 'd', content: 'hello world' })
    const summary = service.listDocuments(base.id)[0]
    expect(summary.embedded).toBe(false)
    expect(summary.embeddingError).toBeTruthy()
  })

  it('clears a per-base config override back to the global value', async () => {
    const service = await mountService()
    const base = await service.createBase({
      name: 'clear',
      config: { embeddingProvider: 'openai', embeddingBaseUrl: 'http://x', embeddingModel: 'm' },
    })
    expect(service.getConfigFor(base.id).embeddingProvider).toBe('openai')

    await service.renameBase(base.id, { config: { embeddingProvider: 'none', embeddingBaseUrl: '', embeddingModel: '' } })
    expect(service.getConfigFor(base.id).embeddingProvider).toBe('none')
    expect(service.getConfigFor(base.id).embeddingBaseUrl).toBe('')
    expect(service.getConfigFor(base.id).embeddingModel).toBe('')
  })

  it('imports a directory as a nested tree and deletes it recursively', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'tree' })
    const root = await mkdtemp(join(tmpdir(), 'dsh-kb-tree-'))
    await writeFile(join(root, 'a.txt'), 'alpha content here')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'b.txt'), 'beta content here')

    const result = await service.importDirectoryTree(base.id, root)
    expect(result.imported).toBe(2)
    expect(result.directories).toBe(2)

    const docs = service.listDocuments(base.id)
    const rootDir = docs.find(doc => doc.sourceType === 'directory' && doc.title === basename(root))
    expect(rootDir).toBeDefined()
    const subDir = docs.find(doc => doc.sourceType === 'directory' && doc.title === 'sub')
    expect(subDir?.parentDirectoryId).toBe(rootDir!.id)
    expect(rootDir!.childCount).toBe(2)
    const fileB = docs.find(doc => doc.title === 'b.txt')
    expect(fileB?.parentDirectoryId).toBe(subDir!.id)

    await service.deleteDocument(rootDir!.id)
    expect(service.listDocuments(base.id)).toHaveLength(0)

    await rm(root, { recursive: true, force: true })
  })

  it('derives a pending status for lexical-only documents', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'status' })
    await service.addTextDocument({ baseId: base.id, title: 's', content: 'hello world' })
    const summary = service.listDocuments(base.id)[0]
    expect(summary.status).toBe('pending')
    expect(summary.embedded).toBe(false)
  })

  it('toggles knowledge invocation and the base scope', async () => {
    const service = await mountService()
    expect(service.isEnabled()).toBe(true)
    expect(service.enabledScope()).toBeUndefined() // empty = all bases

    await service.setEnabled(false)
    expect(service.isEnabled()).toBe(false)

    const a = await service.createBase({ name: 'a' })
    const b = await service.createBase({ name: 'b' })
    await service.setEnabledBaseIds([a.id, b.id])
    expect([...(service.enabledScope() ?? [])].sort()).toEqual([a.id, b.id].sort())

    // A deleted base id is dropped from the scope instead of silently narrowing search.
    await service.setEnabledBaseIds([a.id, 'ghost-id'])
    expect(service.enabledScope()).toEqual([a.id])
    await service.deleteBase(a.id)
    expect(service.enabledScope()).toBeUndefined()
  })

  it('restores a base into a fresh copy with the same documents', async () => {
    const service = await mountService()
    const source = await service.createBase({ name: 'src' })
    await service.addTextDocument({ baseId: source.id, title: 'a', content: 'alpha text' })
    await service.addTextDocument({ baseId: source.id, title: 'b', content: 'beta text' })

    const restored = await service.restoreBase(source.id, 'restored')
    expect(restored.id).not.toBe(source.id)
    expect(restored.name).toBe('restored')

    const sourceDocs = service.listDocuments(source.id)
    const restoredDocs = service.listDocuments(restored.id)
    expect(restoredDocs).toHaveLength(2)
    expect(restoredDocs.map(doc => doc.title).sort()).toEqual(['a', 'b'])
    expect(sourceDocs).toHaveLength(2) // source is left untouched
  })

  it('reads a document slice and greps with offsets', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'read' })
    const doc = await service.addTextDocument({ baseId: base.id, title: 'r', content: 'the quick brown fox\njumps over the lazy dog' })

    const slice = service.readDocumentText(doc.id, 4, 9)
    expect(slice.content).toBe('quick')
    expect(slice.truncated).toBe(true)
    expect(slice.totalChars).toBeGreaterThan(9)

    const grep = service.grepDocument(doc.id, 'the')
    expect(grep.totalMatches).toBe(2) // "the quick" + "the lazy"
    expect(grep.matches[0].line).toBe(1)
    expect(grep.matches[1].line).toBe(2)
  })

  it('outlines a base tree with depths', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'tree' })
    await service.addTextDocument({ baseId: base.id, title: 'root.md', content: 'x' })
    const dir = await service.createDirectory(base.id, 'folder')
    await service.createDirectory(base.id, 'sub', dir.id)

    const outline = service.listBaseOutline(base.id)
    expect(outline.totalItems).toBe(3)
    const folderNode = outline.nodes.find(n => n.docId === dir.id)
    expect(folderNode?.depth).toBe(0)
    expect(folderNode?.type).toBe('directory')
    const subNode = outline.nodes.find(n => n.title === 'sub')
    expect(subNode?.depth).toBe(1)
  })

  it('places an uploaded file inside a directory container', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'nest' })
    const dir = await service.createDirectory(base.id, 'folder')
    const contentBase64 = Buffer.from('nested file content', 'utf8').toString('base64')
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'nested.txt',
      mimeType: 'text/plain',
      contentBase64,
      parentDirectoryId: dir.id,
    })
    const summary = service.listDocuments(base.id).find(d => d.id === doc.id)
    expect(summary?.parentDirectoryId).toBe(dir.id)
    const outline = service.listBaseOutline(base.id)
    expect(outline.nodes.find(n => n.docId === doc.id)?.depth).toBe(1)
  })
})
