import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
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
  siblingChunks: 1,
  localModelCacheDir: '',
  hfEndpoint: '',
  chunkStorePath: '',
  documentProcessorProvider: 'builtin',
  mineruApiKey: '',
  mineruApiHost: '',
  semanticChunk: false,
  semanticChunkThreshold: 0.75,
  chunkTokenLimit: 0,
  conflictStrategy: 'rename',
  urlRefreshHours: 0,
  imageCaptionProvider: 'off',
  imageCaptionModel: '',
  imageCaptionBaseUrl: '',
  imageCaptionApiKey: '',
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

/** Build a minimal, structurally valid single-page PDF with one text line. */
function makeTestPdf(text: string): Buffer {
  const objects: string[] = []
  const add = (body: string): number => {
    objects.push(body)
    return objects.length
  }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`)
  add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`))
  })
  const xrefPos = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`))
  return Buffer.concat(chunks)
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

  it('attaches sibling chunks as context around a search hit', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'siblings' })
    // Three paragraph blocks → three chunks (smart chunking splits on blanks).
    await service.addTextDocument({
      baseId: base.id,
      title: 'report',
      content: 'first paragraph about costs\n\nsecond paragraph about revenue targets\n\nthird paragraph about profits',
    })
    const result = await service.search({ query: 'revenue', baseId: base.id })
    expect(result.hits.length).toBeGreaterThan(0)
    const hit = result.hits[0]
    expect(hit.text).toContain('revenue')
    // Sibling context carries the surrounding paragraphs (default radius 1),
    // in reading order, without the hit's own text.
    expect(hit.siblingContext).toBeDefined()
    expect(hit.siblingContext).toContain('first paragraph')
    expect(hit.siblingContext).toContain('third paragraph')
    expect(hit.siblingContext).not.toContain('revenue')

    // Radius 0 disables the context.
    await service.setConfig({ siblingChunks: 0 })
    const without = await service.search({ query: 'revenue', baseId: base.id })
    expect(without.hits[0].siblingContext).toBeUndefined()
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

  it('narrows search by document metadata filters', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'filters' })
    const a = await service.addTextDocument({ baseId: base.id, title: '排队论讲义', content: '排队论的队长和等待时间分析' })
    const b = await service.addTextDocument({ baseId: base.id, title: '蒙特卡洛笔记', content: '排队论的随机模拟方法' })
    const c = await service.addTextDocument({ baseId: base.id, title: '英语词汇', content: 'vocabulary for queuing theory' })

    // titleIncludes narrows to one document.
    const byTitle = await service.search({ query: '排队论', baseId: base.id, filter: { titleIncludes: '蒙特卡洛' } })
    expect(byTitle.hits.length).toBeGreaterThan(0)
    expect(byTitle.hits.every(hit => hit.docId === b.id)).toBe(true)

    // docIds restrict to the explicit set.
    const byIds = await service.search({ query: '排队论', baseId: base.id, filter: { docIds: [a.id, c.id] } })
    expect(byIds.hits.every(hit => hit.docId === a.id || hit.docId === c.id)).toBe(true)

    // sourceTypes: 'text' matches all three; a nonexistent type matches none.
    const byType = await service.search({ query: '排队论', baseId: base.id, filter: { sourceTypes: ['file'] } })
    expect(byType.hits).toHaveLength(0)

    // updatedAfter excludes everything when the documents are old.
    const byTime = await service.search({ query: '排队论', baseId: base.id, filter: { updatedAfter: Date.now() + 1000 } })
    expect(byTime.hits).toHaveLength(0)
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

  it('renames a same-name file entry by default (Cherry rename strategy)', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'rename-conflict' })
    const content = Buffer.from('first version').toString('base64')
    await service.addFileDocument({ baseId: base.id, fileName: 'notes.txt', contentBase64: content })
    const content2 = Buffer.from('second version').toString('base64')
    const renamed = await service.addFileDocument({ baseId: base.id, fileName: 'notes.txt', contentBase64: content2 })
    expect(renamed.fileName).toBe('notes_1.txt')
    expect(service.listDocuments(base.id)).toHaveLength(2)
  })

  it('detects a same-name conflict and raises ConflictError (409 on the HTTP layer)', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'detect-conflict' })
    const content = Buffer.from('first version').toString('base64')
    await service.addFileDocument({ baseId: base.id, fileName: 'notes.txt', contentBase64: content })
    const content2 = Buffer.from('second version').toString('base64')
    const { ConflictError } = await import('../src/knowledge/index.js')
    await expect(service.addFileDocument({
      baseId: base.id,
      fileName: 'notes.txt',
      contentBase64: content2,
      conflict: 'detect',
    })).rejects.toBeInstanceOf(ConflictError)
    expect(service.listDocuments(base.id)).toHaveLength(1)
  })

  it('uploads a PDF end to end: row lands, pool parses, chunks are indexed', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'pdf-upload' })
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'upload.pdf',
      mimeType: 'application/pdf',
      contentBase64: makeTestPdf('Knowledge base PDF upload works').toString('base64'),
    })
    // Row exists immediately (Cherry: created before processing)…
    expect(service.listDocuments(base.id)).toHaveLength(1)
    // …and the background pool settles it with indexed chunks.
    await service.waitForIdle()
    const settled = service.listDocuments(base.id)[0]
    expect(settled.chunkCount).toBeGreaterThan(0)
    const text = service.listChunks(doc.id).map(c => c.text).join(' ')
    expect(text).toContain('Knowledge base PDF upload works')
  })

  it('semantic chunking runs on the full import path (not bypassed by pre-chunking)', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'semantic-import' })
    await service.setConfig({ semanticChunk: true, semanticChunkThreshold: 0.9, chunkSize: 10000 })
    const text = '第一段内容关于排队论。\n\n第二段内容关于排队论。\n\n第三段内容关于排队论。'
    // Embedding returns the SAME vector for every segment → all merge into one
    // chunk (well under chunkSize). This proves the semantic path executed:
    // pre-chunking would have produced three separate chunks regardless.
    const scope = vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ embedding: [1, 0, 0] }, { embedding: [1, 0, 0] }, { embedding: [1, 0, 0] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    try {
      await service.setConfig({ embeddingProvider: 'openai', embeddingBaseUrl: 'http://127.0.0.1:1', embeddingModel: 'test-embed' })
      await service.addTextDocument({ baseId: base.id, title: 'semantic doc', content: text })
      await service.waitForIdle()
      const doc = service.listDocuments(base.id)[0]
      const chunks = service.listChunks(doc.id)
      expect(chunks.length).toBe(1)
      expect(chunks[0].text).toContain('第三段内容')
    } finally {
      vi.unstubAllGlobals()
      void scope
    }
  })

  it('rejects unsupported file types before creating a row', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'reject-ext' })
    // Cherry's `assertSupportedKnowledgeFilePath`: a binary/image/archive must
    // never be decoded into garbage text and imported as a real document.
    await expect(service.addFileDocument({
      baseId: base.id,
      fileName: 'screenshot.png',
      contentBase64: Buffer.from('not a document').toString('base64'),
    })).rejects.toThrow(/Unsupported knowledge file type/)
    expect(service.listDocuments(base.id)).toHaveLength(0)
  })

  it('queues a large batch of file uploads and settles every row', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'batch' })
    // Fire all uploads without awaiting (rows land immediately), then wait for
    // the background per-base pool to drain — every row must settle.
    const pending = []
    for (let i = 0; i < 30; i += 1) {
      pending.push(service.addFileDocument({
        baseId: base.id,
        fileName: `file-${i}.txt`,
        contentBase64: Buffer.from(`batch content number ${i} here`, 'utf8').toString('base64'),
      }))
    }
    const rows = await Promise.all(pending)
    expect(rows).toHaveLength(30)
    // All rows exist immediately (Cherry: created before processing)…
    expect(service.listDocuments(base.id)).toHaveLength(30)
    // …and the background pool settles them all (lexical-only docs finish as
    // 'pending' by design — the invariant is: no longer processing, indexed).
    await service.waitForIdle()
    const settled = service.listDocuments(base.id)
    expect(settled.every(doc => doc.status !== 'processing' && doc.chunkCount > 0)).toBe(true)
  })

  it('routes embedding-model changes like Cherry: empty saves, BM25-only backfills, configured must rebuild', async () => {
    const service = await mountService()
    // 1. Empty base: the model change saves directly.
    const empty = await service.createBase({ name: 'route-empty' })
    await service.renameBase(empty.id, {
      config: { embeddingProvider: 'openai', embeddingBaseUrl: 'http://x', embeddingModel: 'm1' },
    })
    expect(service.getConfigFor(empty.id).embeddingModel).toBe('m1')

    // 2. BM25-only base with documents: enabling a model commits and backfills
    //    in place (enable-in-place). The change is allowed and the model lands;
    //    the actual backfill vectors are covered in embedding-reuse.spec (the
    //    mock environment), since a real embed call would wait on the network.
    const lexical = await service.createBase({ name: 'route-lexical' })
    await service.addTextDocument({ baseId: lexical.id, title: 'd', content: 'backfill me please' })
    await service.waitForIdle()
    await service.renameBase(lexical.id, {
      config: { embeddingProvider: 'openai', embeddingBaseUrl: 'http://127.0.0.1:1', embeddingModel: 'm2', embeddingApiKey: 'k' },
    })
    expect(service.getConfigFor(lexical.id).embeddingModel).toBe('m2')

    // 3. Switching an already-configured model on a non-empty base is refused
    //    with rebuild guidance (Cherry's restore route). 127.0.0.1:1 fails
    //    fast so the embed attempt cannot hang the test on DNS.
    const configured = await service.createBase({
      name: 'route-switch',
      config: { embeddingProvider: 'openai', embeddingBaseUrl: 'http://127.0.0.1:1', embeddingModel: 'm3', embeddingApiKey: 'k' },
    })
    await service.addTextDocument({ baseId: configured.id, title: 'd', content: 'already embedded' })
    await service.waitForIdle()
    await expect(service.renameBase(configured.id, {
      config: { embeddingModel: 'm4' },
    })).rejects.toThrow(/重建知识库|rebuild/i)
    // Nothing changed.
    expect(service.getConfigFor(configured.id).embeddingModel).toBe('m3')
  })

  it('falls back to the local pipeline when the MinerU remote processor fails', async () => {
    const service = await mountService()
    const base = await service.createBase({
      name: 'mineru-fallback',
      config: {
        documentProcessorProvider: 'mineru',
        mineruApiKey: 'invalid-key',
        mineruApiHost: 'http://127.0.0.1:1', // connection refused → fast failure
      },
    })
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'notes.txt',
      contentBase64: Buffer.from('plain text survives mineru failure', 'utf8').toString('base64'),
    })
    await service.waitForIdle()
    const settled = service.listDocuments(base.id).find(d => d.id === doc.id)
    expect(settled?.chunkCount).toBeGreaterThan(0)
    const text = service.listChunks(doc.id).map(c => c.text).join(' ')
    expect(text).toContain('plain text survives mineru failure')
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

  it('deletes a directory subtree and folds nested selections to the outermost root', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'fold-delete' })
    const root = await service.createDirectory(base.id, 'root')
    const child = await service.createDirectory(base.id, 'child', root.id)
    const leaf = await service.addFileDocument({
      baseId: base.id, title: 'leaf', fileName: 'leaf.txt',
      contentBase64: Buffer.from('leaf content here', 'utf8').toString('base64'),
      parentDirectoryId: child.id,
    })
    const top = await service.addTextDocument({ baseId: base.id, title: 'top', content: 'top content here' })
    expect(service.listDocuments(base.id)).toHaveLength(4)

    // Selecting the directory AND one of its descendants folds to the root:
    // the subtree is deleted once, everything below it goes with it.
    const deleted = await service.deleteDocuments([root.id, leaf.id, top.id])
    expect(deleted.deleted).toBe(2) // root (with subtree) + top
    expect(service.listDocuments(base.id)).toHaveLength(0)
  })

  it('reindexes a directory subtree recursively and folds duplicate selections', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'fold-reindex' })
    const root = await service.createDirectory(base.id, 'root')
    const child = await service.createDirectory(base.id, 'child', root.id)
    const a = await service.addFileDocument({
      baseId: base.id, title: 'a', fileName: 'a.txt',
      contentBase64: Buffer.from('alpha content here', 'utf8').toString('base64'),
      parentDirectoryId: child.id,
    })
    // addFileDocument returns as soon as the row is created; the parse+ingest
    // runs on the background pool, so wait for it before reindexing.
    await service.waitForIdle()
    const b = await service.addTextDocument({ baseId: base.id, title: 'b', content: 'beta content here' })

    // Selecting the root directory (recurses into both leaves) plus the
    // already-covered leaf 'a' must not reindex 'a' twice.
    const result = await service.reindexDocuments([root.id, a.id, b.id])
    expect(result.reindexed).toBe(2) // root (subtree) + b
    const after = service.listDocuments(base.id)
    expect(after.find(d => d.id === a.id)?.chunkCount).toBeGreaterThan(0)
    expect(after.find(d => d.id === b.id)?.chunkCount).toBeGreaterThan(0)
  })

  it('reindexes a whole base with directories without double work', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'fold-base' })
    const root = await service.createDirectory(base.id, 'root')
    await service.addFileDocument({
      baseId: base.id, title: 'a', fileName: 'a.txt',
      contentBase64: Buffer.from('alpha content here', 'utf8').toString('base64'),
      parentDirectoryId: root.id,
    })
    await service.waitForIdle()
    await service.addTextDocument({ baseId: base.id, title: 'b', content: 'beta content here' })

    const result = await service.reindexBase(base.id)
    expect(result.reindexed).toBe(2) // root (subtree) + b — no double work
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

  it('reindexes a file document from its persisted raw source bytes', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'raw-reindex' })
    const doc = await service.addFileDocument({
      baseId: base.id,
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('version one content here', 'utf8').toString('base64'),
    })
    // The row is created immediately; wait for the background parse+ingest.
    await service.waitForIdle()
    // In-memory stores have no raw file backend; the persisted-text path still works.
    expect(doc.rawFilePath).toBeUndefined()
    const result = await service.search({ query: 'version one', baseId: base.id })
    expect(result.hits.length).toBeGreaterThan(0)
    // Reindex from the stored text (the raw file backend is absent here).
    const reindexed = await service.reindexDocument(doc.id)
    expect(reindexed.chunkCount).toBeGreaterThan(0)
  })

  it('rejects SSRF targets and non-HTTP protocols when importing URLs', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'ssrf' })
    // Loopback / private hosts are refused before any request is made.
    await expect(service.addUrlDocument({ baseId: base.id, url: 'http://127.0.0.1:8080/secret' }))
      .rejects.toThrow(/host not allowed/)
    await expect(service.addUrlDocument({ baseId: base.id, url: 'http://localhost/admin' }))
      .rejects.toThrow(/host not allowed/)
    await expect(service.addUrlDocument({ baseId: base.id, url: 'http://169.254.169.254/latest/meta-data' }))
      .rejects.toThrow(/host not allowed/)
    await expect(service.addUrlDocument({ baseId: base.id, url: 'http://192.168.1.1/status' }))
      .rejects.toThrow(/host not allowed/)
    await expect(service.addUrlDocument({ baseId: base.id, url: 'file:///etc/passwd' }))
      .rejects.toThrow(/protocol not allowed/)
    await expect(service.addUrlDocument({ baseId: base.id, url: 'ftp://example.com/file' }))
      .rejects.toThrow(/protocol not allowed/)
    // A malformed URL is rejected cleanly too.
    await expect(service.addUrlDocument({ baseId: base.id, url: 'not a url' }))
      .rejects.toThrow(/invalid URL/)
  })

  it('snapshots a URL and refreshes it when the page changes (public host via mocked fetch)', async () => {
    let page = '<html><head><title>Live Page</title></head><body><p>first version text</p></body></html>'
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => page,
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const service = await mountService()
      const base = await service.createBase({ name: 'urls' })
      const url = 'https://example.com/page'
      const doc = await service.addUrlDocument({ baseId: base.id, url })
      expect(doc.title).toBe('Live Page')
      expect(doc.rawText).toContain('first version text')

      // Refresh with an unchanged page: no-op.
      const unchanged = await service.refreshUrlDocument(doc.id)
      expect(unchanged.changed).toBe(false)

      // Refresh with changed content: snapshot + index update.
      page = '<html><head><title>Live Page</title></head><body><p>second version text</p></body></html>'
      const changed = await service.refreshUrlDocument(doc.id)
      expect(changed.changed).toBe(true)
      expect(changed.chunkCount).toBeGreaterThan(0)
      const after = service.listDocuments(base.id)[0]
      // The mock resolves instantly, so timestamps can land in the same ms.
      expect(after.updatedAt).toBeGreaterThanOrEqual(doc.updatedAt ?? 0)
      // The index now holds the new content only.
      const chunksAfter = service.listChunks(doc.id).map(c => c.text)
      expect(chunksAfter.some(text => text.includes('second version'))).toBe(true)
      expect(chunksAfter.some(text => text.includes('first version'))).toBe(false)
      const result = await service.search({ query: 'second version', baseId: base.id })
      expect(result.hits.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('merges multi-query variants by chunk id keeping the best score', async () => {
    const service = await mountService()
    const base = await service.createBase({ name: 'multi-query' })
    await service.addTextDocument({ baseId: base.id, title: '排队论讲义', content: '排队论研究顾客到达与服务台服务的随机过程，Little 定律描述平均队长与等待时间的关系。' })
    await service.addTextDocument({ baseId: base.id, title: '库存模型', content: '经济订货批量模型 EOQ 平衡订货成本与持有成本，确定最优订货量。' })
    await service.waitForIdle()
    // One variant hits 排队论, another hits 库存模型 — the merge keeps both.
    const result = await service.search({
      query: '排队论',
      baseId: base.id,
      queries: ['经济订货批量'],
      topK: 5,
    })
    const texts = result.hits.map(hit => hit.text).join(' ')
    expect(texts).toContain('排队论')
    expect(texts).toContain('EOQ')
  })

  it('migrates local models to a new cache directory and switches the config', async () => {
    const service = await mountService()
    const tmp = await mkdtemp(join(tmpdir(), 'kb-migrate-'))
    const from = join(tmp, 'from')
    const to = join(tmp, 'to')
    mkdirSync(join(from, 'fake-model'), { recursive: true })
    writeFileSync(join(from, 'fake-model', 'model.onnx'), 'fake weights')
    mkdirSync(join(from, 'ocr'), { recursive: true })
    writeFileSync(join(from, 'ocr', 'ppocrv5_dict.txt'), 'a')
    const { setLocalModelCacheDir } = await import('../src/knowledge/embed.js')
    setLocalModelCacheDir(from)
    try {
      const result = await service.migrateLocalModels(to)
      expect(result.moved).toBe(2)
      expect(existsSync(join(to, 'fake-model', 'model.onnx'))).toBe(true)
      expect(existsSync(join(to, 'ocr', 'ppocrv5_dict.txt'))).toBe(true)
      expect(existsSync(join(from, 'fake-model'))).toBe(false)
      expect(service.getConfig().localModelCacheDir).toBe(resolve(to))
    } finally {
      await rm(tmp, { recursive: true, force: true })
      setLocalModelCacheDir(undefined)
    }
  })

  it('migrate to the same directory is a no-op', async () => {
    const service = await mountService()
    const tmp = await mkdtemp(join(tmpdir(), 'kb-migrate-same-'))
    const { setLocalModelCacheDir } = await import('../src/knowledge/embed.js')
    setLocalModelCacheDir(tmp)
    try {
      const result = await service.migrateLocalModels(tmp)
      expect(result.moved).toBe(0)
    } finally {
      await rm(tmp, { recursive: true, force: true })
      setLocalModelCacheDir(undefined)
    }
  })
})
