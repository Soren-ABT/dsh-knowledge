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
import type { SearchHit, SearchResult } from '../knowledge/types.js'

/** Services required before the tools can register. */
export const inject = ['knowledge', 'tools', 'systemPrompt']

/** Register the knowledge tool surface. */
export function apply(ctx: Context): void {
  const knowledge = ctx.knowledge

  // Proactive-use guidance: the model decides whether to call a tool from its
  // system prompt, so a deployment that never says "use the knowledge base"
  // still gets knowledge_search called for facts that may live in imported
  // material. The section renders only while knowledge is enabled AND at
  // least one base exists (an empty/disabled deployment contributes nothing).
  ctx.systemPrompt.section({
    name: 'knowledge:usage',
    order: 110,
    text: () => {
      if (!knowledge.isEnabled()) return ''
      const bases = knowledge.listBases()
      if (bases.length === 0) return ''
      const names = bases.map(base => base.name).join(', ')
      return 'You have access to knowledge bases (' + names + '). '
        + 'When the user asks about facts, internal documents, specific numbers, or anything that may '
        + 'exist in their imported material (reports, manuals, notes, archived web pages) — even if they '
        + 'never mention a knowledge base — proactively call `knowledge_search` before answering, and '
        + 'quote the returned excerpts with their citations instead of answering from general knowledge alone. '
        + 'Explicit phrasings such as 「查看/查询/运用 我的资料/知识/文档」, "look up / search my materials", '
        + 'or "use the knowledge base" are direct requests to search. If a search returns nothing relevant, '
        + 'say so plainly instead of guessing. For a hard-to-query question, submit 2–3 phrasings or a '
        + 'translation through the `extraQueries` parameter to widen recall.'
    },
  })

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
      + 'that the caller should quote when answering. Omit baseId to search every base. '
      + 'USE THIS PROACTIVELY: whenever the user asks about facts, internal documents, specific numbers, '
      + 'or anything that may exist in their imported material — even if they never said "knowledge base" — '
      + 'search BEFORE answering so the reply cites the sources. Explicit requests to 查看/查询/运用 your '
      + '资料/知识/文档 (look up, review, or search "my materials") are direct commands to search. '
      + 'If nothing relevant comes back, say so instead of guessing; for a hard query try 2–3 phrasings '
      + 'via extraQueries.',
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
      extraQueries: { type: 'array', items: { type: 'string' }, description: 'Optional extra phrasings/translations of the query to search in parallel (multi-query retrieval widens recall); results are merged by chunk keeping the best score.' },
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
          citations: {
            type: 'array',
            items: { type: 'string' },
            description: 'Markdown citation blocks (quote + source) for the top hits, index-aligned with hits — quote these verbatim when answering so the answer stays traceable to the source.',
          },
        },
      },
      render: (_args, value: SearchResult & { citations?: string[] }) => {
        if (value.hits.length === 0) return [{ type: 'text', text: `no matches for "${value.query}"` }]
        const lines = value.hits.map((hit, i) => {
          const excerpt = hit.siblingContext !== undefined && hit.siblingContext.length > 0
            ? `${hit.siblingContext}\n>>> ${hit.text}`
            : hit.text
          return `[${i + 1}] (score ${hit.score.toFixed(3)}) ${hit.documentTitle}: ${excerpt}`
        })
        const citations = value.citations !== undefined && value.citations.length > 0
          ? `\n\nCitations to quote in your answer:\n${value.citations.map((citation, i) => `[${i + 1}] ${citation}`).join('\n')}`
          : ''
        return [{ type: 'text', text: `${value.hits.length} result(s) for "${value.query}" (${value.mode}):\n${lines.join('\n')}${citations}` }]
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
      const value = await knowledge.search({
        query: args.query,
        ...(args.extraQueries !== undefined && args.extraQueries.length > 0
          ? { queries: args.extraQueries.filter((variant: unknown): variant is string => typeof variant === 'string') }
          : {}),
        ...(args.baseId !== undefined ? { baseId: args.baseId } : {}),
        ...(args.baseId === undefined && scope !== undefined ? { baseIds: scope } : {}),
        ...(args.topK !== undefined ? { topK: args.topK } : {}),
        ...(args.mode !== undefined ? { mode: args.mode as SearchResult['mode'] } : {}),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      })
      // Traceable citations: quote blocks + source line, one per top hit —
      // the model can quote them verbatim so answers stay grounded.
      return { ...value, citations: value.hits.map(hit => citationOf(hit)) }
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
      const doc = knowledge.getDocument(args.documentId, { includeChunks: false })
      if (doc.baseId !== args.baseId) {
        throw new Error(`document "${doc.title}" does not belong to knowledge base ${args.baseId}`)
      }
      const scope = knowledge.enabledScope()
      if (scope !== undefined && !scope.includes(doc.baseId)) {
        throw new Error(`document "${doc.title}" belongs to a knowledge base that is not enabled`)
      }
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
      const doc = knowledge.getDocument(args.documentId, { includeChunks: false })
      if (doc.baseId !== args.baseId) {
        throw new Error(`document "${doc.title}" does not belong to knowledge base ${args.baseId}`)
      }
      const scope = knowledge.enabledScope()
      if (scope !== undefined && !scope.includes(doc.baseId)) {
        throw new Error(`document "${doc.title}" belongs to a knowledge base that is not enabled`)
      }
      const reindexed = await knowledge.reindexDocument(args.documentId)
      return { id: reindexed.id, title: reindexed.title, chunkCount: reindexed.chunkCount }
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

  // ── proactive auto-retrieval ────────────────────────────────────────────────
  // On every user message, cheaply (BM25, no embedding round-trip) check the
  // knowledge bases; when the top hit is clearly relevant, inject the top
  // chunks as model-visible background so facts that live in imported material
  // reach the model even when the user never mentions a knowledge base and the
  // model never calls knowledge_search. Best-effort: a disabled deployment,
  // no bases, or a below-gate score injects nothing; failures are swallowed.
  ctx.on('agent/created', (payload: { agent: AutoRetrieveAgent }) => {
    const agent = payload.agent
    agent.ctx.on('agent/inbox/claimed', (claimed: { message: AutoRetrieveMessage }) => {
      const text = claimed.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join(' ')
        .trim()
      if (text.length < AUTO_RETRIEVE_MIN_CHARS) return
      // Follow-up context: keep the last few user messages and query with
      // them joined, so a deictic follow-up ("那第二步呢？") still retrieves
      // the document the earlier turn established.
      const recent = recentUserTexts.get(agent.id) ?? []
      recent.push(text)
      if (recent.length > AUTO_RETRIEVE_CONTEXT_TURNS) recent.shift()
      recentUserTexts.set(agent.id, recent)
      void autoRetrieveBackground(knowledge, agent, recent.join(' '))
    })
    // Forget this agent's throttle + context when it goes away.
    agent.ctx.on('agent/disposed', () => {
      autoRetrieveInjectedAt.delete(agent.id)
      lastInjectedKeywords.delete(agent.id)
      recentUserTexts.delete(agent.id)
    })
  })
}

/** Minimal structural view of an agent the auto-retriever injects into. */
interface AutoRetrieveAgent {
  readonly id: string
  readonly ctx: Context
  inject(message: unknown): void
}

/** Minimal structural view of a claimed user message. */
interface AutoRetrieveMessage {
  readonly content: ReadonlyArray<{ readonly type?: string; readonly text?: string }>
}

/** Shortest user message worth probing the bases for (greetings/single tokens skip). */
const AUTO_RETRIEVE_MIN_CHARS = 8
/** How many top chunks to inject as background. */
const AUTO_RETRIEVE_TOP_K = 3
/** BM25 relevance gate: below this the hit is treated as noise, nothing injects. */
const AUTO_RETRIEVE_MIN_SCORE = 0.2
/**
 * Minimum gap between injections for one agent: injected background rides a
 * user-role message that persists in the session log, so without a throttle a
 * long conversation accumulates one background dump per turn and inflates the
 * context for every later step. The gate is topic-aware: a NEW topic injects
 * even inside the window, while a same-topic follow-up inside the window is
 * skipped (its background was just injected).
 */
const AUTO_RETRIEVE_MIN_INTERVAL_MS = 5 * 60_000
/** How many recent user messages join the retrieval query (follow-up resolution). */
const AUTO_RETRIEVE_CONTEXT_TURNS = 2
/** Per-chunk character cap for injected background (long documents stay bounded). */
const AUTO_RETRIEVE_CHUNK_MAX_CHARS = 300

/** Last injection time per agent id (throttle). */
const autoRetrieveInjectedAt = new Map<string, number>()
/** Keywords of the last injected query per agent id (topic-aware throttle). */
const lastInjectedKeywords = new Map<string, string[]>()
/** Recent user-message texts per agent id (follow-up retrieval context). */
const recentUserTexts = new Map<string, string[]>()

/** Search the bases for `text` and inject relevant chunks as agent background. */
export async function autoRetrieveBackground(
  knowledge: KnowledgeService,
  agent: AutoRetrieveAgent,
  text: string,
): Promise<void> {
  try {
    if (!knowledge.isEnabled()) return
    if (knowledge.listBases().length === 0) return
    if (!knowledge.getConfig().autoRetrieve) return
    const now = Date.now()
    const query = cleanRetrieveQuery(text)
    if (query.length < 2) return
    const keywords = retrieveKeywords(query)
    const throttled = now - (autoRetrieveInjectedAt.get(agent.id) ?? 0) < AUTO_RETRIEVE_MIN_INTERVAL_MS
    const prevKeywords = lastInjectedKeywords.get(agent.id) ?? []
    const sameTopic = prevKeywords.length > 0 && keywords.some(keyword => prevKeywords.includes(keyword))
    // Same-topic follow-up inside the window: its background was just injected,
    // skip (prevents context accumulation). A NEW topic always gets a chance.
    if (throttled && sameTopic) return
    const result = await knowledge.search({ query, topK: AUTO_RETRIEVE_TOP_K, mode: 'lexical' })
    // A hit only counts when its text actually shares keywords with the query
    // — a high BM25 score without any overlapping term is a degenerate match.
    const relevant = result.hits.filter(hit => hit.score >= AUTO_RETRIEVE_MIN_SCORE && sharesKeywords(query, hit.text))
    if (relevant.length === 0) return
    const clip = (chunk: string): string =>
      chunk.length > AUTO_RETRIEVE_CHUNK_MAX_CHARS ? `${chunk.slice(0, AUTO_RETRIEVE_CHUNK_MAX_CHARS)}…` : chunk
    const background = 'Relevant background retrieved automatically from the user\'s imported knowledge (use and cite it when it answers the question):\n'
      + relevant.map(hit => `[${hit.documentTitle}${hit.heading !== undefined && hit.heading.length > 0 ? ` / ${hit.heading}` : ''}] ${clip(hit.text)}`).join('\n\n')
    agent.inject({
      role: 'user',
      content: [{ type: 'text', text: background }],
      source: { kind: 'plugin', plugin: 'dsh-knowledge' },
      id: crypto.randomUUID(),
    })
    autoRetrieveInjectedAt.set(agent.id, now)
    lastInjectedKeywords.set(agent.id, keywords)
  } catch (error) {
    // Best-effort: auto-retrieval must never break a turn.
    console.warn(`[dsh-knowledge] auto-retrieve failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Common conversational filler that carries no retrieval signal (English words,
 *  Chinese interjections/fronters — whole-token matches only, no segmentation). */
const RETRIEVE_STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'this', 'that', 'with', 'from', 'by', 'as', 'about', 'what', 'how', 'why',
  'when', 'where', 'which', 'who', 'can', 'could', 'should', 'would', 'please', 'help', 'tell',
  'know', 'want', 'look', 'find', 'search', 'explain', 'describe', 'me', 'you', 'my', 'your',
  'our', 'their', 'i', 'we', 'they', 'he', 'she', 'do', 'does', 'did', 'have', 'has', 'had', 'if',
  'then', 'also', 'just', 'like', 'say', 'said', 'see', 'get', 'make',
  '请问', '帮我', '一下', '知道', '我想', '我问', '看看', '查查', '这个', '那个', '我们', '你们', '他们',
])

/** Tokenize into latin words (≥2 chars, stopword-filtered) plus CJK bigrams —
 *  Chinese has no word boundaries, so bigrams keep the query's signal without
 *  a segmenter. */
function retrieveKeywords(text: string): string[] {
  const out: string[] = []
  for (const segment of text.split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (segment.length === 0) continue
    if (/^[a-z0-9]+$/i.test(segment)) {
      const lower = segment.toLowerCase()
      if (lower.length >= 2 && !RETRIEVE_STOPWORDS.has(lower)) out.push(lower)
      continue
    }
    const runs = segment.match(/[\u4e00-\u9fff]+/g) ?? []
    for (const run of runs) {
      if (run.length === 1) continue
      if (run.length === 2) out.push(run)
      else for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2))
    }
  }
  return [...new Set(out)]
}

/** Build the BM25 query: drop English stopwords but keep CJK runs WHOLE — the
 *  FTS lane matches CJK via trigram windows (OR'd), so splitting Chinese into
 *  space-separated bigrams would turn them into AND'd LIKE filters and make
 *  the query implausibly strict. */
function cleanRetrieveQuery(text: string): string {
  const parts: string[] = []
  for (const segment of text.split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (segment.length === 0) continue
    if (/^[a-z0-9]+$/i.test(segment)) {
      const lower = segment.toLowerCase()
      if (lower.length >= 2 && !RETRIEVE_STOPWORDS.has(lower)) parts.push(lower)
    } else {
      parts.push(segment)
    }
  }
  return parts.join(' ').slice(0, 200)
}

/** True when at least one query keyword appears in the hit text. */
function sharesKeywords(query: string, hitText: string): boolean {
  const keywords = retrieveKeywords(query)
  if (keywords.length === 0) return true
  const lowerHit = hitText.toLowerCase()
  return keywords.some(keyword => lowerHit.includes(keyword))
}

/** A Markdown citation block for one search hit: quote + source line. */
function citationOf(hit: SearchHit): string {
  const quote = hit.text.split('\n').map(line => `> ${line}`).join('\n')
  const source = hit.heading !== undefined && hit.heading.length > 0
    ? `${hit.documentTitle} / ${hit.heading}`
    : hit.documentTitle
  return `${quote}\n>\n> — ${source}（知识库 ${hit.baseId}）`
}
