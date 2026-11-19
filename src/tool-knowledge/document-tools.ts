import { clampInt } from '../knowledge/bounds.js'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DirectorySyncItem, DirectorySyncResult } from '../knowledge/types.js'
import type { DocumentEvidence } from '../knowledge/processing-types.js'
import { modelText, renderKnowledgeDocumentPage, renderKnowledgeEvidence, renderKnowledgeReadResult } from './render.js'
import { requireBaseEnabled, requireDocumentEnabled } from './tool-access.js'
import { contextWindowSchema, parsedBlockSchema, processingInfoSchema, sourceSpansSchema, toolOutput } from './tool-schemas.js'

const directorySyncItemSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    relativePath: { type: 'string', required: true },
    kind: { type: 'string', enum: ['file', 'directory'], required: true },
    documentId: { type: 'string' },
    action: { type: 'string', enum: ['created', 'updated', 'unchanged', 'deleted', 'failed'], required: true },
    error: { type: 'object', additionalProperties: false, properties: {
      code: { type: 'string', required: true }, message: { type: 'string', required: true },
    } },
  },
} as const

const directorySyncSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    sourceId: { type: 'string', required: true },
    status: { type: 'string', enum: ['synced', 'unchanged', 'partial'], required: true },
    created: { type: 'number', required: true }, updated: { type: 'number', required: true },
    unchanged: { type: 'number', required: true }, deleted: { type: 'number', required: true }, failed: { type: 'number', required: true },
    items: { type: 'array', items: directorySyncItemSchema, required: true },
  },
} as const

/** Failed new files have no document id; omit absent fields for strict JSON tools. */
function directoryItemsOutput(items: readonly DirectorySyncItem[]) {
  return items.map(({ documentId, error, ...item }) => ({
    ...item,
    ...(documentId !== undefined ? { documentId } : {}),
    ...(error !== undefined ? { error: { ...error } } : {}),
  }))
}

function assertToolRange(name: string, value: number | undefined, min: number, max: number): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
}

export function registerDocumentTools(ctx: Context): void {
  const knowledge = ctx.knowledge
  ctx.tools.register(defineTool({
    name: 'knowledge_get_document',
    description: 'Read one knowledge-base document in either page mode or anchored context mode. '
      + 'Omit anchorChunkId/anchorIndex to use bounded chunkOffset/chunkLimit pagination. '
      + 'Pass exactly one anchor to continue around a knowledge_search hit; context mode returns ordered, '
      + 'token-bounded before/anchor/after evidence and cannot be mixed with pagination parameters.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'Document id to read.' },
      chunkOffset: { type: 'number', description: 'Zero-based chunk offset (default 0).' },
      chunkLimit: { type: 'number', description: 'Chunks to return (default 20, maximum 50).' },
      anchorChunkId: { type: 'string', description: 'Stable chunk id from knowledge_search; mutually exclusive with anchorIndex and pagination.' },
      anchorIndex: { type: 'number', description: 'Zero-based chunk index; mutually exclusive with anchorChunkId and pagination.' },
      before: { type: 'number', description: 'Context chunks before the anchor (default 2, range 0-10).' },
      after: { type: 'number', description: 'Context chunks after the anchor (default 2, range 0-10).' },
      maxTokens: { type: 'number', description: 'Hard context budget (default 1600, range 128-4096).' },
      focus: { type: 'string', description: 'Optional query or identifier used to centre an oversized anchor (maximum 500 characters).' },
      crossHeading: { type: 'boolean', description: 'Allow context to cross heading paths (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          readMode: { type: 'string', enum: ['page', 'context'], required: true },
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          sourceType: { type: 'string', required: true },
          charCount: { type: 'number', required: true },
          chunkCount: { type: 'number', required: true },
          nextChunkOffset: { type: 'number' },
          truncated: { type: 'boolean', required: true },
          contextWindow: contextWindowSchema,
          processing: processingInfoSchema,
          chunks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number', required: true },
                heading: { type: 'string' },
                text: { type: 'string', required: true },
                sourceSpans: sourceSpansSchema,
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderKnowledgeDocumentPage(value) }],
    },
    async execute(args) {
      const doc = requireDocumentEnabled(knowledge, args.documentId)
      const hasChunkAnchor = args.anchorChunkId !== undefined
      const hasIndexAnchor = args.anchorIndex !== undefined
      if (hasChunkAnchor && hasIndexAnchor) throw new Error('provide exactly one of anchorChunkId or anchorIndex')
      const anchored = hasChunkAnchor || hasIndexAnchor
      const hasPagination = args.chunkOffset !== undefined || args.chunkLimit !== undefined
      const hasContextControls = args.before !== undefined || args.after !== undefined || args.maxTokens !== undefined
        || args.focus !== undefined || args.crossHeading !== undefined
      if (anchored && hasPagination) throw new Error('anchor parameters cannot be mixed with chunkOffset or chunkLimit')
      if (!anchored && hasContextControls) throw new Error('before, after, maxTokens, focus, and crossHeading require an anchor')

      if (anchored) {
        if (args.anchorChunkId !== undefined && args.anchorChunkId.trim().length === 0) {
          throw new Error('anchorChunkId must not be empty')
        }
        if (args.anchorIndex !== undefined && (!Number.isInteger(args.anchorIndex) || args.anchorIndex < 0)) {
          throw new Error('anchorIndex must be a non-negative integer')
        }
        assertToolRange('before', args.before, 0, 10)
        assertToolRange('after', args.after, 0, 10)
        assertToolRange('maxTokens', args.maxTokens, 128, 4096)
        if (args.focus !== undefined && args.focus.length > 500) throw new Error('focus must not exceed 500 characters')
        const result = knowledge.getDocumentContext(args.documentId, {
          ...(args.anchorChunkId !== undefined ? { anchorChunkId: args.anchorChunkId } : {}),
          ...(args.anchorIndex !== undefined ? { anchorIndex: args.anchorIndex } : {}),
          ...(args.before !== undefined ? { before: args.before } : {}),
          ...(args.after !== undefined ? { after: args.after } : {}),
          ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
          ...(args.focus !== undefined ? { focus: args.focus } : {}),
          ...(args.crossHeading !== undefined ? { crossHeading: args.crossHeading } : {}),
        })
        const ordered = [
          ...result.contextWindow.before,
          result.contextWindow.anchor,
          ...result.contextWindow.after,
        ]
        return toolOutput({
          readMode: 'context' as const,
          id: result.id,
          title: result.title,
          sourceType: result.sourceType,
          charCount: result.charCount,
          chunkCount: result.chunkCount,
          ...(doc.processing !== undefined ? { processing: doc.processing } : {}),
          truncated: result.contextWindow.hasMoreBefore || result.contextWindow.hasMoreAfter,
          chunks: ordered.map(chunk => ({
            index: chunk.index,
            ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
            text: chunk.text,
            ...(chunk.sourceSpans !== undefined ? { sourceSpans: chunk.sourceSpans } : {}),
          })),
          contextWindow: result.contextWindow,
        })
      }

      const offset = clampInt(args.chunkOffset, 0, doc.chunkCount, 0)
      const limit = clampInt(args.chunkLimit, 1, 50, 20)
      // Real LIMIT/OFFSET on SQLite: page mode no longer materialises the
      // document's entire chunk collection before slicing it in JavaScript.
      const chunks = knowledge.listChunks(args.documentId, limit, offset)
      const nextChunkOffset = offset + chunks.length
      return toolOutput({
        readMode: 'page' as const,
        id: doc.id,
        title: doc.title,
        sourceType: doc.sourceType,
        charCount: doc.charCount,
        chunkCount: doc.chunkCount,
        ...(doc.processing !== undefined ? { processing: doc.processing } : {}),
        ...(nextChunkOffset < doc.chunkCount ? { nextChunkOffset } : {}),
        truncated: nextChunkOffset < doc.chunkCount,
        chunks: chunks.map(chunk => ({
          index: chunk.index,
          ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
          text: chunk.text,
          ...(chunk.sourceSpans !== undefined ? { sourceSpans: chunk.sourceSpans } : {}),
        })),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_read_evidence',
    description: 'Read bounded structured document evidence: blocks, zero-based page indices, normalized block regions, and safe asset metadata. '
      + 'Use after search when table, formula, image, or page provenance matters. maxTokens bounds text; follow next.blockId and next.blockOffset to continue long blocks. '
      + 'textStart/textEnd locate the returned excerpt in canonical text. Pass the processing revision when following a citation or continuation. Never interpret extracted HTML as executable content.',
    parameters: {
      documentId: { type: 'string', required: true },
      pageIndex: { type: 'number', description: 'Optional zero-based page filter.' },
      revision: { type: 'string', description: 'Expected processing revision from a source span or previous evidence response. Rejects stale citations.' },
      blockId: { type: 'string', description: 'Start at this block (also used with next.blockOffset for continuation).' },
      blockOffset: { type: 'number', description: 'UTF-16 offset into the starting block (default 0); requires blockId.' },
      maxTokens: { type: 'number', description: 'Text budget (default 1600, range 128-4096).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          documentId: { type: 'string', required: true }, title: { type: 'string', required: true },
          processing: processingInfoSchema,
          blocks: { type: 'array', required: true, items: parsedBlockSchema },
          assets: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
            id: { type: 'string', required: true }, path: { type: 'string', required: true },
            mimeType: { type: 'string', required: true }, byteLength: { type: 'number', required: true }, sha256: { type: 'string', required: true },
          } } },
          estimatedTokens: { type: 'number', required: true }, truncated: { type: 'boolean', required: true },
          next: { type: 'object', additionalProperties: false, properties: { blockId: { type: 'string', required: true }, blockOffset: { type: 'number', required: true } } },
        },
      },
      render: (_args, value: DocumentEvidence) => [{ type: 'text', text: renderKnowledgeEvidence(value) }],
    },
    async execute(args) {
      requireDocumentEnabled(knowledge, args.documentId)
      assertToolRange('pageIndex', args.pageIndex, 0, Number.MAX_SAFE_INTEGER)
      assertToolRange('blockOffset', args.blockOffset, 0, Number.MAX_SAFE_INTEGER)
      assertToolRange('maxTokens', args.maxTokens, 128, 4096)
      if (args.blockId !== undefined && args.blockId.trim().length === 0) throw new Error('blockId must not be empty')
      if (args.blockOffset !== undefined && args.blockId === undefined) throw new Error('blockOffset requires blockId')
      return toolOutput(await knowledge.readDocumentEvidence(args.documentId, {
        ...(args.revision !== undefined ? { revision: args.revision } : {}),
        ...(args.pageIndex !== undefined ? { pageIndex: args.pageIndex } : {}),
        ...(args.blockId !== undefined ? { blockId: args.blockId } : {}),
        ...(args.blockOffset !== undefined ? { blockOffset: args.blockOffset } : {}),
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_reindex_document',
    description: 'Re-index one document (or a whole directory subtree): re-read its source '
      + '(raw file when present), re-chunk, and re-embed only what changed. '
      + 'After publishing or editing a local Wiki, call this on its directory id with mode omitted: '
      + 'a path-bound directory scans disk for added, changed and deleted files. Check sync.failed and sync.items. '
      + 'Uploaded folders without sourcePath only rebuild their stored files; bind a server path in the management panel first. '
      + 'Use after a parser upgrade, a chunk-size change, or to repair a failed embedding.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Knowledge base id (used for validation).' },
      documentId: { type: 'string', required: true, description: 'Document (or directory) id to reindex.' },
      mode: { type: 'string', enum: ['reparse', 'rechunk'], description: 'reparse reruns the configured parser; rechunk reuses a compatible stored structured result. Omit for automatic reuse.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          chunkCount: { type: 'number', required: true },
          sync: directorySyncSchema,
        },
      },
      render: (_args, value: { title: string; chunkCount: number; sync?: DirectorySyncResult }) => modelText(value.sync === undefined
        ? `reindexed "${value.title}" (${value.chunkCount} chunks)`
        : `directory "${value.title}": ${value.sync.status}; created=${value.sync.created}, updated=${value.sync.updated}, deleted=${value.sync.deleted}, unchanged=${value.sync.unchanged}, failed=${value.sync.failed}`
          + value.sync.items.filter(item => item.action === 'failed').map(item => `\n${item.relativePath}: ${item.error?.message ?? 'sync failed'}`).join('')),
    },
    async execute(args) {
      const doc = requireDocumentEnabled(knowledge, args.documentId)
      if (doc.baseId !== args.baseId) {
        throw new Error(`document "${doc.title}" does not belong to knowledge base ${args.baseId}`)
      }
      const reindexed = await knowledge.reindexDocument(args.documentId, { mode: args.mode })
      return { id: reindexed.id, title: reindexed.title, chunkCount: reindexed.chunkCount,
        ...(reindexed.sync !== undefined ? { sync: { ...reindexed.sync, items: directoryItemsOutput(reindexed.sync.items) } } : {}) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_reindex_base',
    description: 'Re-chunk and re-embed every document in a knowledge base using the current configuration. '
      + 'Use after changing the chunk size or the embedding provider.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Knowledge base id to reindex.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        reindexed: { type: 'number', required: true }, skipped: { type: 'number', required: true }, failed: { type: 'number', required: true },
        items: { type: 'array', items: directorySyncItemSchema, required: true },
      } },
      render: (_args, value: { reindexed: number; skipped: number; failed: number }) => modelText(
        `reindexed ${value.reindexed} document(s); skipped=${value.skipped}, failed=${value.failed}`),
    },
    async execute(args) {
      requireBaseEnabled(knowledge, args.baseId)
      const result = await knowledge.reindexBase(args.baseId)
      return { ...result, items: directoryItemsOutput(result.items) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_read_document',
    description: 'Read a knowledge-base document by its id (from a knowledge_search hit or knowledge_list_documents). '
      + 'Two modes: omit pattern to read the source text — long documents come back in capped slices, so when '
      + 'truncated is true, call again with charStart set to the returned charEnd; pass a regular-expression pattern '
      + 'to grep instead for exact text (numbers, code, quotes) — returns each match with line/offset/snippet.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'Document id to read.' },
      charStart: { type: 'number', description: 'Start character offset for the read slice (default 0).' },
      charEnd: { type: 'number', description: 'End character offset (default charStart + 20000, capped by totalChars).' },
      pattern: { type: 'string', description: 'Regular expression to grep instead of reading a slice.' },
      maxMatches: { type: 'number', description: 'Max grep matches (default 50, max 200).' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive grep (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          totalChars: { type: 'number' },
          charStart: { type: 'number' },
          charEnd: { type: 'number' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
          totalMatches: { type: 'number' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'number', required: true },
                charStart: { type: 'number', required: true },
                charEnd: { type: 'number', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        return [{ type: 'text', text: renderKnowledgeReadResult(value) }]
      },
    },
    async execute(args) {
      requireDocumentEnabled(knowledge, args.documentId)
      if (args.pattern !== undefined) {
        const result = knowledge.grepDocument(args.documentId, args.pattern, args.maxMatches, args.ignoreCase !== false)
        return { documentId: result.id, title: result.title, totalMatches: result.totalMatches, matches: result.matches }
      }
      const result = knowledge.readDocumentText(args.documentId, args.charStart, args.charEnd)
      return {
        documentId: result.id,
        title: result.title,
        totalChars: result.totalChars,
        charStart: result.charStart,
        charEnd: result.charEnd,
        content: result.content,
        truncated: result.truncated,
      }
    },
  }))
}
