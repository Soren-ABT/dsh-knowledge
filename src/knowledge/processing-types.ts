/** Versioned, provider-independent document evidence. No runtime/Node imports. */
export type DocumentProcessor = 'builtin' | 'mineru' | 'mineru-local'
export type MineruTier = 'flash' | 'basic' | 'standard' | 'advanced'
export type ParsedBlockType = 'text' | 'heading' | 'table' | 'equation' | 'image' | 'caption' | 'code' | 'list' | 'unknown'

export interface ProcessingWarning {
  readonly code: string
  readonly message: string
}

/** Normalized block-level geometry, not a glyph selection. */
export interface SourceBox {
  readonly coordinateSpace: 'normalized'
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export interface ParsedBlock {
  readonly id: string
  readonly index: number
  readonly type: ParsedBlockType
  readonly text: string
  /** Range in ParsedDocument.text (UTF-16, exclusive end). */
  readonly textStart: number
  readonly textEnd: number
  readonly pageIndex?: number
  readonly heading?: string
  readonly bbox?: SourceBox
  readonly parentId?: string
  readonly assetIds?: readonly string[]
}

export interface ParsedAsset {
  readonly id: string
  /** Archive-relative, validated path. Never an external URL. */
  readonly path: string
  readonly mimeType: string
  readonly byteLength: number
  readonly sha256: string
}

export interface ParsedDocument {
  readonly schemaVersion: 1
  readonly text: string
  readonly sourceHash: string
  readonly provider: DocumentProcessor
  readonly processorVersion?: string
  readonly optionsFingerprint: string
  readonly completeness: 'complete' | 'partial' | 'unknown'
  readonly pageCount?: number
  readonly processedPages?: readonly number[]
  readonly blocks: readonly ParsedBlock[]
  readonly assets: readonly ParsedAsset[]
  readonly warnings: readonly ProcessingWarning[]
}

/** Bytes only exist in the processing/storage layer, never tool responses. */
export interface ProcessingOutput {
  readonly document: ParsedDocument
  readonly assets: readonly { readonly id: string; readonly bytes: Uint8Array }[]
  readonly originalResult?: Uint8Array
}

export interface DocumentProcessingInfo {
  readonly revision: string
  readonly artifactId: string
  readonly sourceHash: string
  readonly provider: DocumentProcessor
  readonly processorVersion?: string
  readonly optionsFingerprint: string
  readonly parsedAt: number
  readonly completeness: ParsedDocument['completeness']
  readonly pageCount?: number
  readonly processedPages?: readonly number[]
  readonly warnings: readonly ProcessingWarning[]
  readonly reused?: boolean
}

/** Exact chunk text range to a block in ONE immutable artifact revision. */
export interface DocumentSourceSpan {
  readonly revision: string
  readonly blockId: string
  readonly blockType: ParsedBlockType
  readonly chunkStart: number
  readonly chunkEnd: number
  readonly blockStart: number
  readonly blockEnd: number
  readonly pageIndex?: number
  readonly bbox?: SourceBox
  readonly assetIds?: readonly string[]
}

export interface ProcessingProgress {
  readonly stage: 'queued' | 'checking' | 'uploading' | 'parsing' | 'downloading' | 'normalizing' | 'indexing' | 'completed' | 'failed' | 'canceled'
  readonly jobId?: string
}

export interface ProcessorCapabilities {
  readonly provider: 'mineru-local'
  readonly version: string
  readonly tiers: readonly string[]
  readonly outputFormats: readonly string[]
  readonly sources: readonly string[]
}

export interface DocumentEvidence {
  readonly documentId: string
  readonly title: string
  readonly processing?: DocumentProcessingInfo
  readonly blocks: readonly ParsedBlock[]
  readonly assets: readonly ParsedAsset[]
  readonly estimatedTokens: number
  readonly truncated: boolean
  readonly next?: { readonly blockId: string; readonly blockOffset: number }
}
