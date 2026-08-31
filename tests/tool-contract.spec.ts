import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// Load the sibling workspace's real built service. Importing its TS source
// beside ToolRuntime's package declaration creates two nominal SystemPrompt
// identities in module augmentation even though they are the same runtime.
// @ts-expect-error the workspace build keeps declarations under lib/types/
import SystemPrompt from '../../dsh/packages/core/system-prompt/lib/index.js'
import { estimateContextTokens, KnowledgeService } from '../src/knowledge/index.js'
import type { Config } from '../src/knowledge/config.js'
import type { KnowledgeBase, KnowledgeDocument } from '../src/knowledge/types.js'
import * as ToolKnowledge from '../src/tool-knowledge/index.js'

const DEFAULT_CONFIG: Config = {
  embeddingProvider: 'none',
  embeddingBaseUrl: '',
  embeddingModel: '',
  embeddingApiKey: '',
  rerankModel: '',
  rerankBaseUrl: '',
  rerankApiKey: '',
  localRerankTimeoutMs: 60_000,
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
  resumeInterruptedOnStartup: true,
  autoRetrieve: true,
  autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60_000,
}

interface Harness {
  ctx: Context
  knowledge: KnowledgeService
  primaryBase: KnowledgeBase
  foreignBase: KnowledgeBase
  primaryDoc: KnowledgeDocument
  foreignDoc: KnowledgeDocument
  grepDoc: KnowledgeDocument
}

function fakeWebServer() {
  return { register: () => () => {} }
}

async function mountHarness(): Promise<Harness> {
  const ctx = new Context()
  ctx.provide('webServer', fakeWebServer())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(KnowledgeService, DEFAULT_CONFIG)
  await ctx.plugin(ToolKnowledge)
  const knowledge = ctx.get('knowledge') as unknown as KnowledgeService
  const primaryBase = await knowledge.createBase({
    name: 'primary',
    config: { smartChunk: false, chunkSeparator: '||', siblingChunks: 1 },
  })
  const foreignBase = await knowledge.createBase({
    name: 'foreign',
    config: { smartChunk: false, chunkSeparator: '||', siblingChunks: 1 },
  })
  const primaryDoc = await knowledge.addTextDocument({
    baseId: primaryBase.id,
    title: 'primary manual',
    content: 'alpha opening evidence||needle invoice policy||alpha continuation evidence||alpha final evidence',
  })
  const foreignDoc = await knowledge.addTextDocument({
    baseId: foreignBase.id,
    title: 'foreign manual',
    content: 'foreign opening||foreign needle evidence||foreign ending',
  })
  const grepDoc = await knowledge.addTextDocument({
    baseId: primaryBase.id,
    title: 'grep manual',
    content: 'first line\ninvoice CODE-42 amount is 120\nlast line',
  })
  await knowledge.waitForIdle()
  return { ctx, knowledge, primaryBase, foreignBase, primaryDoc, foreignDoc, grepDoc }
}

let callSequence = 0
const signal = new AbortController().signal

function execute(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  callSequence += 1
  return ctx.tools.execute({
    signal,
    callId: `knowledge-contract-${callSequence}` as never,
    name,
    arguments: args,
  })
}

function resultText(result: ToolExecutionResult): string {
  return result.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function valueOf<T>(result: ToolExecutionResult): T {
  expect(result.isError, resultText(result)).toBe(false)
  if (result.isError) throw new Error(resultText(result))
  return result.value as unknown as T
}

function expectToolError(result: ToolExecutionResult, pattern: RegExp): void {
  expect(result.isError).toBe(true)
  expect(resultText(result)).toMatch(pattern)
}

describe('model-facing knowledge tool contracts', () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await mountHarness()
  })

  beforeEach(async () => {
    await harness.knowledge.setEnabled(true)
    await harness.knowledge.setEnabledBaseIds([])
  })

  it('keeps legacy chunk pagination bounded and reports page continuation', async () => {
    const result = await execute(harness.ctx, 'knowledge_get_document', {
      documentId: harness.primaryDoc.id,
      chunkOffset: 1,
      chunkLimit: 2,
    })
    const value = valueOf<{
      readMode: 'page'
      chunks: Array<{ index: number; text: string }>
      nextChunkOffset?: number
      truncated: boolean
    }>(result)

    expect(value.readMode).toBe('page')
    expect(value.chunks.map(chunk => chunk.index)).toEqual([1, 2])
    expect(value.nextChunkOffset).toBe(3)
    expect(value.truncated).toBe(true)
    expect(resultText(result)).toContain('continue with chunkOffset=3')
  })

  it('reads an ordered context window through a stable chunk anchor', async () => {
    const chunks = harness.knowledge.listChunks(harness.primaryDoc.id)
    const result = await execute(harness.ctx, 'knowledge_get_document', {
      documentId: harness.primaryDoc.id,
      anchorChunkId: chunks[1].id,
      before: 1,
      after: 1,
      maxTokens: 128,
      focus: 'needle',
    })
    const value = valueOf<{
      readMode: 'context'
      contextWindow: {
        anchorChunkId: string
        anchorIndex: number
        before: Array<{ index: number }>
        anchor: { index: number; text: string }
        after: Array<{ index: number }>
      }
    }>(result)

    expect(value.readMode).toBe('context')
    expect(value.contextWindow.anchorChunkId).toBe(chunks[1].id)
    expect(value.contextWindow.anchorIndex).toBe(1)
    expect([
      ...value.contextWindow.before,
      value.contextWindow.anchor,
      ...value.contextWindow.after,
    ].map(chunk => chunk.index)).toEqual([0, 1, 2])
    expect(value.contextWindow.anchor.text).toContain('needle')
    expect(resultText(result)).toContain('>>>')
  })

  it('rejects pagination/anchor mixing and multiple anchor forms', async () => {
    const chunks = harness.knowledge.listChunks(harness.primaryDoc.id)
    expectToolError(await execute(harness.ctx, 'knowledge_get_document', {
      documentId: harness.primaryDoc.id,
      chunkOffset: 0,
      anchorChunkId: chunks[1].id,
    }), /pagination|chunkOffset|anchor/i)
    expectToolError(await execute(harness.ctx, 'knowledge_get_document', {
      documentId: harness.primaryDoc.id,
      anchorChunkId: chunks[1].id,
      anchorIndex: 1,
    }), /exactly one|anchorChunkId|anchorIndex/i)
  })

  it('rejects stale and mismatched anchors', async () => {
    expectToolError(await execute(harness.ctx, 'knowledge_get_document', {
      documentId: harness.primaryDoc.id,
      anchorChunkId: 'stale-chunk-id',
    }), /stale|no longer exists/i)

    const foreignAnchor = harness.knowledge.listChunks(harness.foreignDoc.id)[1]
    expectToolError(await execute(harness.ctx, 'knowledge_get_document', {
      documentId: harness.primaryDoc.id,
      anchorChunkId: foreignAnchor.id,
    }), /does not belong/i)
  })

  it('enforces enabled-base scope for document reads and unscoped search', async () => {
    await harness.knowledge.setEnabledBaseIds([harness.primaryBase.id])
    expectToolError(await execute(harness.ctx, 'knowledge_get_document', {
      documentId: harness.foreignDoc.id,
      chunkOffset: 0,
      chunkLimit: 1,
    }), /not enabled/i)

    const search = await execute(harness.ctx, 'knowledge_search', { query: 'needle', topK: 10 })
    const value = valueOf<{ hits: Array<{ baseId: string }> }>(search)
    expect(value.hits.length).toBeGreaterThan(0)
    expect(value.hits.every(hit => hit.baseId === harness.primaryBase.id)).toBe(true)
  })

  it('treats empty document and source-type filters as match-nothing', async () => {
    const emptyDocuments = valueOf<{ hits: unknown[] }>(await execute(harness.ctx, 'knowledge_search', {
      query: 'needle',
      docIds: [],
    }))
    expect(emptyDocuments.hits).toEqual([])

    const emptySourceTypes = valueOf<{ hits: unknown[] }>(await execute(harness.ctx, 'knowledge_search', {
      query: 'needle',
      sourceTypes: [],
    }))
    expect(emptySourceTypes.hits).toEqual([])
  })

  it('renders chunkIndex in every source label and one continuation hint', async () => {
    const result = await execute(harness.ctx, 'knowledge_search', {
      query: 'alpha evidence',
      baseId: harness.primaryBase.id,
      topK: 3,
    })
    const value = valueOf<{ hits: Array<{ index: number }> }>(result)
    expect(value.hits.length).toBeGreaterThan(1)
    const rendered = resultText(result)
    for (const hit of value.hits) expect(rendered).toContain(`chunkIndex=${hit.index}`)
    expect(rendered.match(/Need more context\?/g)).toHaveLength(1)
    expect(rendered).toContain('anchorChunkId=')
  })

  it('keeps the exact explicit-search rendering inside its global token budget', () => {
    const longHits = Array.from({ length: 50 }, (_, index) => ({
      chunkId: `chunk-${index}`,
      docId: `doc-${index}`,
      baseId: harness.primaryBase.id,
      documentTitle: `manual ${index}`,
      index,
      text: `${'long visible evidence '.repeat(600)} TARGET-${index}`,
      score: 1 - index / 100,
    }))
    const rendered = ToolKnowledge.renderKnowledgeSearchResult({
      query: 'visible evidence',
      mode: 'lexical',
      total: longHits.length,
      reranked: false,
      elapsedMs: 1,
      hits: longHits,
    })

    expect(estimateContextTokens(rendered)).toBeLessThanOrEqual(ToolKnowledge.SEARCH_RENDER_MAX_TOKENS)
    expect(rendered.match(/Need more context\?/g)).toHaveLength(1)
  })

  it('renders grep character offsets and a direct continuation location', async () => {
    const result = await execute(harness.ctx, 'knowledge_read_document', {
      documentId: harness.grepDoc.id,
      pattern: 'CODE-42',
      maxMatches: 5,
    })
    const value = valueOf<{
      matches: Array<{ line: number; charStart: number; charEnd: number; snippet: string }>
    }>(result)
    expect(value.matches).toHaveLength(1)
    const match = value.matches[0]
    expect(match.charStart).toBeGreaterThanOrEqual(0)
    expect(match.charEnd).toBeGreaterThan(match.charStart)
    const rendered = resultText(result)
    expect(rendered).toContain(`[chars ${match.charStart}-${match.charEnd}]`)
    expect(rendered).toContain('knowledge_read_document')
    expect(rendered).toContain('charStart=')
    expect(rendered).toContain('charEnd=')
  })
})
