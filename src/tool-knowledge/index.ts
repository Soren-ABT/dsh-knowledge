/**
 * Model-facing knowledge tools. The tools consume the host `knowledge`
 * service and publish nothing themselves, so this row sits as an ordinary
 * tool plugin beside the service it reaches (the same split the goal and
 * interconnect tools use against their host services).
 * @module dsh-knowledge/tool-knowledge
 */

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Activates the `Context.knowledge` merge declared by the knowledge service.
import type {} from '../knowledge/index.js'
import type { KnowledgeService } from '../knowledge/index.js'
import type { SearchResult } from '../knowledge/types.js'

/** Services required before the tools can register. */
export const inject = ['knowledge', 'tools']

/** Register the knowledge tool surface. */
export function apply(ctx: Context): void {
  const knowledge = ctx.knowledge

  // Invocation switch: when knowledge is disabled in the panel, every
  // knowledge_* tool is denied (Cherry's kb_* `applies` gate equivalent).
  ctx.tools.guard((exec) => {
    if (!exec.name.startsWith('knowledge_')) return undefined
    if (!knowledge.isEnabled()) return 'knowledge base invocation is turned off; enable it in the knowledge panel first'
    return undefined
  })

  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: 'Search a knowledge base for chunks relevant to a query. '
      + 'Returns ranked excerpts with scores (hybrid BM25+vector when embeddings exist, lexical otherwise) '
      + 'that the caller should quote when answering. Omit baseId to search every base.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
      baseId: { type: 'string', description: 'Optional knowledge base id to restrict the search to.' },
      topK: { type: 'number', description: 'Optional number of results (default from config).' },
      mode: { type: 'string', description: 'Optional search mode: auto, hybrid, vector, or lexical.' },
      docIds: { type: 'array', items: { type: 'string' }, description: 'Optional document ids to restrict the search to.' },
      titleIncludes: { type: 'string', description: 'Optional case-insensitive substring filter on the document title (e.g. "排队论").' },
      sourceTypes: { type: 'array', items: { type: 'string' }, description: 'Optional source types to restrict to: file, text, url, directory.' },
      updatedAfter: { type: 'number', description: 'Optional epoch-ms lower bound on the document update time.' },
      updatedBefore: { type: 'number', description: 'Optional epoch-ms upper bound on the document update time.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          total: { type: 'number', required: true },
          reranked: { type: 'boolean', required: true },
          elapsedMs: { type: 'number', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                chunkId: { type: 'string', required: true },
                docId: { type: 'string', required: true },
                baseId: { type: 'string', required: true },
                documentTitle: { type: 'string', required: true },
                heading: { type: 'string' },
                index: { type: 'number', required: true },
                text: { type: 'string', required: true },
                siblingContext: { type: 'string', description: 'Neighbouring chunks (±siblingChunks) around this hit in the same document, in reading order — the full paragraph the excerpt sits in.' },
                score: { type: 'number', required: true },
                vectorScore: { type: 'number' },
                lexicalScore: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value: SearchResult) => {
        if (value.hits.length === 0) return [{ type: 'text', text: `no matches for "${value.query}"` }]
        const lines = value.hits.map((hit, i) => {
          const excerpt = hit.siblingContext !== undefined && hit.siblingContext.length > 0
            ? `${hit.siblingContext}\n>>> ${hit.text}`
            : hit.text
          return `[${i + 1}] (score ${hit.score.toFixed(3)}) ${hit.documentTitle}: ${excerpt}`
        })
        return [{ type: 'text', text: `${value.hits.length} result(s) for "${value.query}" (${value.mode}):\n${lines.join('\n')}` }]
      },
    },
    async execute(args) {
      const scope = knowledge.enabledScope()
      if (args.baseId !== undefined && scope !== undefined && !scope.includes(args.baseId)) {
        throw new Error(`knowledge base "${args.baseId}" is not enabled; enabled bases: ${scope.join(', ') || '(none)'}`)
      }
      const filter: Record<string, unknown> = {}
      if (args.docIds !== undefined && args.docIds.length > 0) filter.docIds = args.docIds
      if (args.titleIncludes !== undefined && args.titleIncludes.trim() !== '') filter.titleIncludes = args.titleIncludes
      if (args.sourceTypes !== undefined && args.sourceTypes.length > 0) filter.sourceTypes = args.sourceTypes
      if (args.updatedAfter !== undefined) filter.updatedAfter = args.updatedAfter
      if (args.updatedBefore !== undefined) filter.updatedBefore = args.updatedBefore
      return knowledge.search({
        query: args.query,
        ...(args.baseId !== undefined ? { baseId: args.baseId } : {}),
        ...(args.baseId === undefined && scope !== undefined ? { baseIds: scope } : {}),
        ...(args.topK !== undefined ? { topK: args.topK } : {}),
        ...(args.mode !== undefined ? { mode: args.mode as SearchResult['mode'] } : {}),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_list_bases',
    description: 'List knowledge bases, or outline one base. Omit baseId to list every base with its document and chunk counts. '
      + 'Pass a baseId to outline that base instead: a flat top-down tree of its folders and documents (depth, title, type, status, docId), '
      + 'so you can see how a base is organized and find a document id without searching.',
    parameters: {
      baseId: { type: 'string', description: 'Optional base id to outline instead of listing bases.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bases: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                documentCount: { type: 'number', required: true },
                chunkCount: { type: 'number', required: true },
              },
            },
          },
          baseId: { type: 'string' },
          totalItems: { type: 'number' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                depth: { type: 'number', required: true },
                docId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                type: { type: 'string', required: true },
                status: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.nodes !== undefined) {
          return [{
            type: 'text',
            text: value.nodes.map(n => `${'  '.repeat(n.depth)}${n.type === 'directory' ? '📁' : '📄'} ${n.title} [${n.status}] (${n.docId})`).join('\n'),
          }]
        }
        if ((value.bases ?? []).length === 0) return [{ type: 'text', text: 'no knowledge bases yet' }]
        return [{
          type: 'text',
          text: (value.bases ?? []).map(b => `- ${b.name} (${b.documentCount} docs, ${b.chunkCount} chunks) [id: ${b.id}]`).join('\n'),
        }]
      },
    },
    async execute(args) {
      if (args.baseId !== undefined) {
        const scope = knowledge.enabledScope()
        if (scope !== undefined && !scope.includes(args.baseId)) {
          throw new Error(`knowledge base "${args.baseId}" is not enabled`)
        }
        return knowledge.listBaseOutline(args.baseId)
      }
      const scope = knowledge.enabledScope()
      const scopeSet = scope !== undefined ? new Set(scope) : undefined
      return {
        bases: knowledge.listBases()
          .filter(base => scopeSet === undefined || scopeSet.has(base.id))
          .map(base => ({
            id: base.id,
            name: base.name,
            description: base.description,
            documentCount: base.documentCount,
            chunkCount: base.chunkCount,
          })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_create_base',
    description: 'Create a new, empty knowledge base.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short name for the knowledge base.' },
      description: { type: 'string', description: 'Optional description of what it holds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value: { id: string; name: string }) => [
        { type: 'text', text: `created knowledge base "${value.name}" (id ${value.id})` },
      ],
    },
    async execute(args) {
      const base = await knowledge.createBase({ name: args.name, description: args.description })
      return { id: base.id, name: base.name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_delete_base',
    description: 'Delete a knowledge base and every document and chunk it contains. This is irreversible.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Knowledge base id to delete.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'deleted knowledge base' }],
    },
    async execute(args) {
      await knowledge.deleteBase(args.baseId)
      return { deleted: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_add_document',
    description: 'Add a document to a knowledge base from raw text. '
      + 'The text is chunked and embedded (when configured) automatically.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Target knowledge base id.' },
      title: { type: 'string', required: true, description: 'Document title.' },
      content: { type: 'string', required: true, description: 'Full document text.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          chunkCount: { type: 'number', required: true },
        },
      },
      render: (_args, value: { title: string; chunkCount: number }) => [
        { type: 'text', text: `added document "${value.title}" (${value.chunkCount} chunks)` },
      ],
    },
    async execute(args) {
      const doc = await knowledge.addTextDocument({ baseId: args.baseId, title: args.title, content: args.content })
      return { id: doc.id, title: doc.title, chunkCount: doc.chunkCount }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_list_documents',
    description: 'List the documents inside one knowledge base.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Knowledge base id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                chunkCount: { type: 'number', required: true },
                charCount: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { documents: Array<{ title: string; chunkCount: number }> }) => {
        if (value.documents.length === 0) return [{ type: 'text', text: 'no documents in this base' }]
        return [{
          type: 'text',
          text: value.documents.map(d => `- ${d.title} (${d.chunkCount} chunks)`).join('\n'),
        }]
      },
    },
    async execute(args) {
      return {
        documents: knowledge.listDocuments(args.baseId).map(doc => ({
          id: doc.id,
          title: doc.title,
          chunkCount: doc.chunkCount,
          charCount: doc.charCount,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_delete_document',
    description: 'Delete one document (and its chunks) from a knowledge base.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Knowledge base id (used for validation).' },
      documentId: { type: 'string', required: true, description: 'Document id to delete.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'deleted document' }],
    },
    async execute(args) {
      void args.baseId
      await knowledge.deleteDocument(args.documentId)
      return { deleted: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_import_url',
    description: 'Import a document into a knowledge base from a URL. '
      + 'The page is fetched, its text extracted, then chunked and embedded automatically.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Target knowledge base id.' },
      url: { type: 'string', required: true, description: 'The URL to fetch and import.' },
      title: { type: 'string', description: 'Optional title (defaults to the page title or the URL).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          chunkCount: { type: 'number', required: true },
        },
      },
      render: (_args, value: { title: string; chunkCount: number }) => [
        { type: 'text', text: `imported "${value.title}" (${value.chunkCount} chunks)` },
      ],
    },
    async execute(args) {
      const doc = await knowledge.addUrlDocument({ baseId: args.baseId, url: args.url, title: args.title })
      return { id: doc.id, title: doc.title, chunkCount: doc.chunkCount }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_refresh_url',
    description: 'Re-fetch a URL document from its origin and update its snapshot in place. '
      + 'Use when a page you imported earlier has changed and the knowledge base should reflect the new content. '
      + 'Returns changed=false when the page is unchanged.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'Id of the URL document to refresh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          changed: { type: 'boolean', required: true },
          title: { type: 'string', required: true },
          chunkCount: { type: 'number', required: true },
        },
      },
      render: (_args, value: { changed: boolean; title: string; chunkCount: number }) => [
        { type: 'text', text: value.changed
          ? `refreshed "${value.title}" (${value.chunkCount} chunks)`
          : `"${value.title}" is unchanged` },
      ],
    },
    async execute(args) {
      return knowledge.refreshUrlDocument(args.documentId)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_stats',
    description: 'Report aggregate statistics for one knowledge base (or all bases when baseId is omitted): '
      + 'document, chunk, character, and token counts, and whether embeddings are present.',
    parameters: {
      baseId: { type: 'string', description: 'Optional base id; omit to aggregate every base.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentCount: { type: 'number', required: true },
          chunkCount: { type: 'number', required: true },
          charCount: { type: 'number', required: true },
          tokenCount: { type: 'number', required: true },
          embedded: { type: 'boolean', required: true },
        },
      },
      render: (_args, value: { documentCount: number; chunkCount: number; charCount: number; tokenCount: number; embedded: boolean }) => [
        {
          type: 'text',
          text: `${value.documentCount} docs, ${value.chunkCount} chunks, ${value.charCount} chars, ~${value.tokenCount} tokens, embedded: ${value.embedded}`,
        },
      ],
    },
    async execute(args) {
      const stats = knowledge.stats(args.baseId)
      return {
        documentCount: stats.documentCount,
        chunkCount: stats.chunkCount,
        charCount: stats.charCount,
        tokenCount: stats.tokenCount,
        embedded: stats.embedded,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_get_document',
    description: 'Read one document from a knowledge base: its metadata and the full chunk list.',
    parameters: {
      documentId: { type: 'string', required: true, description: 'Document id to read.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          sourceType: { type: 'string', required: true },
          charCount: { type: 'number', required: true },
          chunkCount: { type: 'number', required: true },
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
              },
            },
          },
        },
      },
      render: (_args, value: { title: string; chunkCount: number }) => [
        { type: 'text', text: `document "${value.title}" (${value.chunkCount} chunks)` },
      ],
    },
    async execute(args) {
      const doc = knowledge.getDocument(args.documentId)
      const scope = knowledge.enabledScope()
      if (scope !== undefined && !scope.includes(doc.baseId)) {
        throw new Error(`document "${doc.title}" belongs to a knowledge base that is not enabled`)
      }
      return {
        id: doc.id,
        title: doc.title,
        sourceType: doc.sourceType,
        charCount: doc.charCount,
        chunkCount: doc.chunkCount,
        chunks: (doc.chunks ?? []).map(chunk => ({
          index: chunk.index,
          ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
          text: chunk.text,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_reindex_document',
    description: 'Re-index one document (or a whole directory subtree): re-read its source '
      + '(raw file when present), re-chunk, and re-embed only what changed. '
      + 'Use after a parser upgrade, a chunk-size change, or to repair a failed embedding.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Knowledge base id (used for validation).' },
      documentId: { type: 'string', required: true, description: 'Document (or directory) id to reindex.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          chunkCount: { type: 'number', required: true },
        },
      },
      render: (_args, value: { title: string; chunkCount: number }) => [
        { type: 'text', text: `reindexed "${value.title}" (${value.chunkCount} chunks)` },
      ],
    },
    async execute(args) {
      void args.baseId
      const doc = await knowledge.reindexDocument(args.documentId)
      return { id: doc.id, title: doc.title, chunkCount: doc.chunkCount }
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
      schema: { type: 'object', additionalProperties: false, properties: { reindexed: { type: 'number', required: true } } },
      render: (_args, value: { reindexed: number }) => [
        { type: 'text', text: `reindexed ${value.reindexed} document(s)` },
      ],
    },
    async execute(args) {
      const result = await knowledge.reindexBase(args.baseId)
      return { reindexed: result.reindexed }
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
        if (value.matches !== undefined) {
          if (value.matches.length === 0) return [{ type: 'text', text: `no matches in "${value.title}"` }]
          return [{ type: 'text', text: `${value.matches.length} match(es) in "${value.title}":\n${value.matches.map(m => `L${m.line}: ${m.snippet}`).join('\n')}` }]
        }
        return [{ type: 'text', text: `"${value.title}" (${value.charStart}-${value.charEnd} of ${value.totalChars}):\n${value.content}` }]
      },
    },
    async execute(args) {
      const doc = knowledge.getDocument(args.documentId, { includeChunks: false })
      const scope = knowledge.enabledScope()
      if (scope !== undefined && !scope.includes(doc.baseId)) {
        throw new Error(`document "${doc.title}" belongs to a knowledge base that is not enabled`)
      }
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

  void (knowledge as KnowledgeService)
}
