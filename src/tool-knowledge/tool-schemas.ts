const blockTypes = ['text', 'heading', 'table', 'equation', 'image', 'caption', 'code', 'list', 'unknown'] as const

type MutableOutput<T> = T extends readonly (infer U)[] ? MutableOutput<U>[]
  : T extends object ? { -readonly [K in keyof T]: MutableOutput<T[K]> } : T

/** Tool schemas use mutable JSON arrays; keep immutable service snapshots isolated. */
export function toolOutput<T>(value: T): MutableOutput<T> {
  return structuredClone(value) as MutableOutput<T>
}

const sourceBoxSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    coordinateSpace: { type: 'string', enum: ['normalized'], required: true },
    x0: { type: 'number', required: true }, y0: { type: 'number', required: true },
    x1: { type: 'number', required: true }, y1: { type: 'number', required: true },
  },
} as const

export const sourceSpansSchema = {
  type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      revision: { type: 'string', required: true }, blockId: { type: 'string', required: true },
      blockType: { type: 'string', enum: blockTypes, required: true },
      chunkStart: { type: 'number', required: true }, chunkEnd: { type: 'number', required: true },
      blockStart: { type: 'number', required: true }, blockEnd: { type: 'number', required: true },
      pageIndex: { type: 'number' }, bbox: sourceBoxSchema,
      assetIds: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

export const processingInfoSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    revision: { type: 'string', required: true }, artifactId: { type: 'string', required: true },
    sourceHash: { type: 'string', required: true }, provider: { type: 'string', enum: ['builtin', 'mineru', 'mineru-local'], required: true },
    processorVersion: { type: 'string' }, optionsFingerprint: { type: 'string', required: true },
    parsedAt: { type: 'number', required: true }, completeness: { type: 'string', enum: ['complete', 'partial', 'unknown'], required: true },
    pageCount: { type: 'number' }, processedPages: { type: 'array', items: { type: 'number' } },
    warnings: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      code: { type: 'string', required: true }, message: { type: 'string', required: true },
    } } },
    reused: { type: 'boolean' },
  },
} as const

export const parsedBlockSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, index: { type: 'number', required: true },
    type: { type: 'string', enum: blockTypes, required: true }, text: { type: 'string', required: true },
    textStart: { type: 'number', required: true }, textEnd: { type: 'number', required: true },
    pageIndex: { type: 'number' }, heading: { type: 'string' }, bbox: sourceBoxSchema,
    parentId: { type: 'string' }, assetIds: { type: 'array', items: { type: 'string' } },
  },
} as const

const contextChunkSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chunkId: { type: 'string', required: true },
    index: { type: 'number', required: true },
    heading: { type: 'string' },
    text: { type: 'string', required: true },
    textStart: { type: 'number', required: true },
    textEnd: { type: 'number', required: true },
    truncatedStart: { type: 'boolean', required: true },
    truncatedEnd: { type: 'boolean', required: true },
    sourceSpans: sourceSpansSchema,
  },
} as const

export const contextWindowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    anchorChunkId: { type: 'string', required: true },
    anchorIndex: { type: 'number', required: true },
    before: { type: 'array', required: true, items: contextChunkSchema },
    anchor: { ...contextChunkSchema, required: true },
    after: { type: 'array', required: true, items: contextChunkSchema },
    estimatedTokens: { type: 'number', required: true },
    hasMoreBefore: { type: 'boolean', required: true },
    hasMoreAfter: { type: 'boolean', required: true },
  },
} as const
