import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KnowledgeService } from '../knowledge/index.js'
import { modelText } from './render.js'
import { requireBaseEnabled, requireDocumentEnabled } from './tool-access.js'

function aggregateStats(rows: ReadonlyArray<ReturnType<KnowledgeService['stats']>>): ReturnType<KnowledgeService['stats']> {
  return rows.reduce<ReturnType<KnowledgeService['stats']>>((total, row) => ({
    documentCount: total.documentCount + row.documentCount,
    storedDocCount: total.storedDocCount + row.storedDocCount,
    chunkCount: total.chunkCount + row.chunkCount,
    charCount: total.charCount + row.charCount,
    tokenCount: total.tokenCount + row.tokenCount,
    embedded: total.embedded || row.embedded,
  }), { documentCount: 0, storedDocCount: 0, chunkCount: 0, charCount: 0, tokenCount: 0, embedded: false })
}

export function registerLibraryTools(ctx: Context): void {
  const knowledge = ctx.knowledge
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
          return modelText(value.nodes.map(n => `${'  '.repeat(n.depth)}${n.type === 'directory' ? '📁' : '📄'} ${n.title} [${n.status}] (${n.docId})`).join('\n'))
        }
        if ((value.bases ?? []).length === 0) return [{ type: 'text', text: 'no knowledge bases yet' }]
        return modelText((value.bases ?? []).map(b => `- ${b.name} (${b.documentCount} docs, ${b.chunkCount} chunks) [id: ${b.id}]`).join('\n'))
      },
    },
    async execute(args) {
      if (args.baseId !== undefined) {
        requireBaseEnabled(knowledge, args.baseId)
        return knowledge.listBaseOutline(args.baseId)
      }
      return {
        bases: knowledge.enabledBases()
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
      render: (_args, value: { id: string; name: string }) => modelText(`created knowledge base "${value.name}" (id ${value.id})`),
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
      requireBaseEnabled(knowledge, args.baseId)
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
      render: (_args, value: { title: string; chunkCount: number }) => modelText(`added document "${value.title}" (${value.chunkCount} chunks)`),
    },
    async execute(args) {
      requireBaseEnabled(knowledge, args.baseId)
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
                sourceType: { type: 'string', enum: ['text', 'file', 'url', 'directory'], required: true },
                sourcePath: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { documents: Array<{ id: string; title: string; chunkCount: number; sourceType: string; sourcePath?: string }> }) => {
        if (value.documents.length === 0) return [{ type: 'text', text: 'no documents in this base' }]
        // Expose the docId (knowledge_read_document needs it; without it the
        // model loops between search and list trying to find an id).
        return modelText(value.documents.map(d => `- ${d.title} (${d.sourceType}, ${d.chunkCount} chunks) [id=${d.id}]${d.sourceType === 'directory' && d.sourcePath !== undefined ? ` [source=${d.sourcePath}]` : ''}`).join('\n'))
      },
    },
    async execute(args) {
      requireBaseEnabled(knowledge, args.baseId)
      return {
        documents: knowledge.listDocuments(args.baseId).map(doc => ({
          id: doc.id,
          title: doc.title,
          chunkCount: doc.chunkCount,
          charCount: doc.charCount,
          sourceType: doc.sourceType,
          ...(doc.sourcePath !== undefined ? { sourcePath: doc.sourcePath } : {}),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_delete_document',
    description: 'Delete one document (and its chunks) from a knowledge base. Deleting a non-empty directory requires recursive=true.',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Knowledge base id (used for validation).' },
      documentId: { type: 'string', required: true, description: 'Document id to delete.' },
      recursive: { type: 'boolean', description: 'Required only when deleting a non-empty directory and all of its descendants.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { deleted: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'deleted document' }],
    },
    async execute(args) {
      const doc = requireDocumentEnabled(knowledge, args.documentId)
      if (doc.baseId !== args.baseId) {
        throw new Error(`document "${doc.title}" does not belong to knowledge base ${args.baseId}`)
      }
      await knowledge.deleteDocument(args.documentId, { recursive: args.recursive === true })
      return { deleted: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'knowledge_import_url',
    description: 'Import an HTML page or a raw Markdown URL into a knowledge base for search.',
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
      render: (_args, value: { title: string; chunkCount: number }) => modelText(`imported "${value.title}" (${value.chunkCount} chunks)`),
    },
    async execute(args, exec) {
      requireBaseEnabled(knowledge, args.baseId)
      const doc = await knowledge.addUrlDocument({ baseId: args.baseId, url: args.url, title: args.title }, exec.signal)
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
      render: (_args, value: { changed: boolean; title: string; chunkCount: number }) => modelText(value.changed
          ? `refreshed "${value.title}" (${value.chunkCount} chunks)`
          : `"${value.title}" is unchanged`),
    },
    async execute(args) {
      requireDocumentEnabled(knowledge, args.documentId)
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
      if (args.baseId !== undefined) requireBaseEnabled(knowledge, args.baseId)
      const stats = args.baseId !== undefined
        ? knowledge.stats(args.baseId)
        : aggregateStats(knowledge.resolveInvocationScope().enabled.map(base => knowledge.stats(base.id)))
      return {
        documentCount: stats.documentCount,
        chunkCount: stats.chunkCount,
        charCount: stats.charCount,
        tokenCount: stats.tokenCount,
        embedded: stats.embedded,
      }
    },
  }))
}
