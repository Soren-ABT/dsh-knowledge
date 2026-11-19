import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SearchResult } from '../knowledge/types.js'
import { citationOf, renderKnowledgeSearchResult } from './render.js'
import { contextWindowSchema, sourceSpansSchema, toolOutput } from './tool-schemas.js'

export function registerSearchTool(ctx: Context): void {
  const knowledge = ctx.knowledge
  ctx.tools.register(defineTool({
    name: 'knowledge_search',
    description: 'Search a knowledge base for chunks relevant to a query. '
      + 'Returns ranked excerpts with scores (hybrid BM25+vector when embeddings exist, lexical otherwise) '
      + 'that the caller should quote when answering. By default, searches all enabled bases. '
      + 'USE THIS PROACTIVELY: whenever the user asks about facts, internal documents, specific numbers, '
      + 'or anything that may exist in their imported material — even if they never said "knowledge base" — '
      + 'search BEFORE answering so the reply cites the sources. Explicit requests to 查看/查询/运用 your '
      + '资料/知识/文档 (look up, review, or search "my materials") are direct commands to search. '
      + 'If nothing relevant comes back, say so instead of guessing; for a hard query try 2–3 phrasings '
      + 'via extraQueries.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
      baseId: { type: 'string', description: 'Optional knowledge base id to restrict the search to.' },
      baseIds: { type: 'array', items: { type: 'string' }, description: 'Search a subset of enabled bases. Use either baseId or baseIds. An empty list matches nothing.' },
      topK: { type: 'number', description: 'Optional number of results (default from config).' },
      mode: { type: 'string', enum: ['auto', 'hybrid', 'vector', 'lexical'], description: 'Optional search mode.' },
      docIds: { type: 'array', items: { type: 'string' }, description: 'Optional document ids to restrict the search to.' },
      excludeDocIds: { type: 'array', items: { type: 'string' }, description: 'Optional exact document ids to exclude before candidate limits and TopK. Exclusion takes precedence over docIds; an empty array has no effect.' },
      titleIncludes: { type: 'string', description: 'Optional case-insensitive substring filter on the document title (e.g. "排队论").' },
      titleExcludes: { type: 'array', items: { type: 'string' }, description: 'Optional literal title substrings to exclude before candidate limits and TopK. Any case-insensitive match excludes the document; terms are trimmed and blank terms are ignored.' },
      sourceTypes: { type: 'array', items: { type: 'string', enum: ['file', 'text', 'url', 'directory'] }, description: 'Optional source types to restrict to.' },
      updatedAfter: { type: 'number', description: 'Optional epoch-ms lower bound on the document update time.' },
      updatedBefore: { type: 'number', description: 'Optional epoch-ms upper bound on the document update time.' },
      extraQueries: { type: 'array', items: { type: 'string' }, description: 'Up to three extra phrasings/translations; variants are normalized, deduplicated, rank-fused, then reranked at most once.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          mode: { type: 'string', enum: ['auto', 'hybrid', 'vector', 'lexical'], required: true },
          scoreKind: { type: 'string', enum: ['lexical_relevance', 'vector_similarity', 'rrf', 'rerank'] },
          retrieval: {
            type: 'object',
            additionalProperties: false,
            properties: {
              requestedMode: { type: 'string', enum: ['auto', 'hybrid', 'vector', 'lexical'], required: true },
              effectiveMode: { type: 'string', enum: ['auto', 'hybrid', 'vector', 'lexical'], required: true },
              lexical: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  attempted: { type: 'boolean', required: true }, succeeded: { type: 'boolean', required: true },
                  returnedCount: { type: 'number', required: true }, errorCode: { type: 'string' },
                },
              },
              vector: {
                type: 'object', additionalProperties: false, required: true,
                properties: {
                  attempted: { type: 'boolean', required: true }, succeeded: { type: 'boolean', required: true },
                  returnedCount: { type: 'number', required: true }, errorCode: { type: 'string' },
                },
              },
            },
          },
          total: { type: 'number', required: true },
          reranked: { type: 'boolean', required: true },
          rerank: {
            type: 'object',
            additionalProperties: false,
            properties: {
              configured: { type: 'boolean', const: true, required: true },
              provider: { type: 'string', enum: ['local', 'remote'], required: true },
              model: { type: 'string', required: true },
              status: { type: 'string', enum: ['applied', 'not_needed', 'skipped', 'degraded'], required: true },
              attempted: { type: 'boolean', required: true },
              applied: { type: 'boolean', required: true },
              candidateCount: { type: 'number', required: true },
              elapsedMs: { type: 'number' },
              error: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  code: { type: 'string', enum: ['model_not_downloaded', 'model_checking', 'model_unhealthy', 'unsupported_model', 'timeout', 'invalid_response', 'runtime_error', 'process_crash', 'circuit_open', 'busy', 'provider_error'], required: true },
                  message: { type: 'string', required: true },
                  retryable: { type: 'boolean', required: true },
                  action: { type: 'string', enum: ['download_model', 'run_self_test', 'check_config', 'retry_later'] },
                },
              },
            },
          },
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
                sourceSpans: sourceSpansSchema,
                processingRevision: { type: 'string' },
                contextWindow: contextWindowSchema,
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
        const baseNames = new Map(knowledge.resolveInvocationScope().enabled.map(base => [base.id, base.name]))
        return [{ type: 'text', text: renderKnowledgeSearchResult(value, baseId => baseNames.get(baseId)) }]
      },
    },
    async execute(args) {
      if (args.query.trim().length === 0) throw new Error('search query is required')
      if (args.query.length > 2000) throw new Error('search query must not exceed 2000 characters')
      if (args.updatedAfter !== undefined && args.updatedBefore !== undefined && args.updatedAfter > args.updatedBefore) {
        throw new Error('updatedAfter must be less than or equal to updatedBefore')
      }
      if (args.baseId !== undefined && args.baseIds !== undefined) throw new Error('use either baseId or baseIds')
      const scope = knowledge.resolveInvocationScope(args.baseIds).baseIds
      if (args.baseId !== undefined && scope !== undefined && !scope.includes(args.baseId)) {
        throw new Error(`knowledge base "${args.baseId}" is not enabled`)
      }
      const filter: Record<string, unknown> = {}
      if (args.docIds !== undefined) filter.docIds = args.docIds
      if (args.excludeDocIds !== undefined) filter.excludeDocIds = args.excludeDocIds
      if (args.titleIncludes !== undefined && args.titleIncludes.trim() !== '') filter.titleIncludes = args.titleIncludes
      if (args.titleExcludes !== undefined) filter.titleExcludes = args.titleExcludes
      if (args.sourceTypes !== undefined) filter.sourceTypes = args.sourceTypes
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
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
      })
      // Traceable citations: quote blocks + source line, one per top hit —
      // the model can quote them verbatim so answers stay grounded.
      return toolOutput({ ...value, citations: value.hits.map(hit => citationOf(hit)) })
    },
  }))
}
