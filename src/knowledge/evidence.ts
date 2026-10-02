import { estimateContextTokens } from './context.js'
import type { KnowledgeDocument } from './types.js'
import type { DocumentEvidence, ParsedBlock, ParsedDocument } from './processing-types.js'

/** A caller-supplied evidence cursor must not surface as a server failure. */
export class EvidenceRequestError extends Error {
  constructor(readonly code: 'invalid_request' | 'not_found', message: string) {
    super(message)
    this.name = 'EvidenceRequestError'
  }
}

/** Token-bounded evidence continuation. Offsets remain canonical UTF-16
 * positions; a cropped block never invents a page or a physical rectangle. */
export function composeDocumentEvidence(doc: KnowledgeDocument, parsed: ParsedDocument, options: {
  pageIndex?: number; blockId?: string; blockOffset?: number; maxTokens?: number
} = {}): DocumentEvidence {
  const budget = Math.max(128, Math.min(4096, Math.trunc(options.maxTokens ?? 1600)))
  if (!Number.isFinite(budget)) throw new EvidenceRequestError('invalid_request', 'invalid evidence token budget')
  if (options.pageIndex !== undefined && (!Number.isInteger(options.pageIndex) || options.pageIndex < 0)) throw new EvidenceRequestError('invalid_request', 'invalid evidence page')
  const all = parsed.blocks.filter(block => options.pageIndex === undefined || block.pageIndex === options.pageIndex)
  const start = options.blockId === undefined ? 0 : all.findIndex(block => block.id === options.blockId)
  if (start < 0) throw new EvidenceRequestError('not_found', 'evidence block not found in this document/page')
  const offset = options.blockOffset ?? 0
  if (!Number.isInteger(offset) || offset < 0 || (options.blockId === undefined && offset !== 0)) throw new EvidenceRequestError('invalid_request', 'invalid evidence continuation')
  if (offset > (all[start]?.text.length ?? 0)) throw new EvidenceRequestError('invalid_request', 'evidence continuation is outside block')
  const blocks: ParsedBlock[] = []
  let used = 0
  let next: DocumentEvidence['next']
  for (let i = start; i < all.length; i++) {
    const block = all[i]!
    const from = i === start ? offset : 0
    const available = budget - used
    const crop = (length: number): ParsedBlock => ({ ...block, text: block.text.slice(from, from + length), textStart: block.textStart + from, textEnd: block.textStart + from + length })
    let low = 0, high = block.text.length - from
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (estimateContextTokens(JSON.stringify(crop(middle))) <= available) low = middle
      else high = middle - 1
    }
    if (low > 0 && from + low < block.text.length && /[\uD800-\uDBFF]/.test(block.text[from + low - 1]!) && /[\uDC00-\uDFFF]/.test(block.text[from + low]!)) low--
    if (low === 0 && block.text.length > from) {
      if (blocks.length === 0) throw new EvidenceRequestError('invalid_request', 'evidence metadata exceeds this budget; increase maxTokens')
      next = { blockId: block.id, blockOffset: from }; break
    }
    const excerpt = crop(low)
    const cost = estimateContextTokens(JSON.stringify(excerpt))
    if (cost > available) { next = { blockId: block.id, blockOffset: from }; break }
    blocks.push(excerpt)
    used += cost
    if (from + low < block.text.length) { next = { blockId: block.id, blockOffset: from + low }; break }
  }
  const assetIds = new Set(blocks.flatMap(block => block.assetIds ?? []))
  return { documentId: doc.id, title: doc.title, processing: doc.processing,
    blocks, assets: parsed.assets.filter(asset => assetIds.has(asset.id)),
    estimatedTokens: used, truncated: next !== undefined, ...(next !== undefined ? { next } : {}) }
}
