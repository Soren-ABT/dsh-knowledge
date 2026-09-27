import { chunkText, type ChunkPiece } from './chunk.js'
import { estimateContextTokens } from './context-protocol.js'
import type { DocumentSourceSpan, ParsedBlock, ParsedDocument } from './processing-types.js'
import { sliceSourceSpans } from './source-spans.js'

export interface StructuredChunkPiece extends ChunkPiece {
  readonly sourceSpans?: readonly DocumentSourceSpan[]
}

/** Structure-aware, exactly mapped chunks. Ordinary unstructured text keeps its old splitter. */
export function chunkParsedDocument(
  parsed: ParsedDocument,
  revision: string,
  size: number,
  overlap: number,
  options?: { structured?: boolean; smartChunk?: boolean; separator?: string; tokenLimit?: number },
): StructuredChunkPiece[] {
  if (parsed.blocks.length === 0) return chunkText(parsed.text, size, overlap, options)
  if (!revision) throw new Error('processing revision is required for source mappings')
  const budget = Math.min(
    Number.isFinite(size) ? Math.max(64, Math.trunc(size)) : 800,
    options?.tokenLimit !== undefined && options.tokenLimit > 0 ? Math.max(1, Math.trunc(options.tokenLimit)) : Number.MAX_SAFE_INTEGER,
  )
  const overlapTokens = Number.isFinite(overlap) ? Math.max(0, Math.min(Math.trunc(overlap), Math.floor(budget / 3))) : 0
  const result: StructuredChunkPiece[] = []
  let cursor = 0
  let heading: string | undefined
  let pendingHeading: StructuredChunkPiece | undefined
  const add = (piece: StructuredChunkPiece): void => {
    if (piece.text.trim().length === 0) return
    if (pendingHeading !== undefined) {
      const combined = joinPieces(pendingHeading, piece)
      if (estimateContextTokens(combined.text) <= budget) {
        result.push(combined)
        pendingHeading = undefined
        return
      }
      result.push(pendingHeading)
      pendingHeading = undefined
    }
    result.push(piece)
  }
  for (const block of parsed.blocks) {
    if (!Number.isSafeInteger(block.textStart) || !Number.isSafeInteger(block.textEnd)
      || block.textStart < cursor || block.textEnd < block.textStart
      || parsed.text.slice(block.textStart, block.textEnd) !== block.text) {
      throw new Error('parsed block ranges are inconsistent with canonical text')
    }
    // Preserve unmapped text too. Whitespace joins need no invented citation.
    if (block.textStart > cursor) {
      const gap = parsed.text.slice(cursor, block.textStart)
      for (const piece of windows({ text: gap, heading }, budget, overlapTokens)) add(piece)
    }
    cursor = block.textEnd
    heading = block.heading ?? heading
    const piece = blockPiece(block, revision, heading)
    if (options?.structured !== false && block.type === 'heading') {
      if (pendingHeading !== undefined) result.push(pendingHeading)
      const pieces = windows(piece, budget, 0)
      for (const earlier of pieces.slice(0, -1)) result.push(earlier)
      pendingHeading = pieces.at(-1)
      continue
    }
    const pieces = options?.structured !== false && block.type === 'table'
      ? tablePieces(piece, budget)
      : windows(piece, budget, block.type === 'equation' || block.type === 'image' ? 0 : overlapTokens)
    for (const entry of pieces) add(entry)
  }
  for (const piece of windows({ text: parsed.text.slice(cursor), heading }, budget, overlapTokens)) add(piece)
  if (pendingHeading !== undefined) result.push(pendingHeading)
  return result
}

function blockPiece(block: ParsedBlock, revision: string, heading?: string): StructuredChunkPiece {
  return {
    text: block.text,
    ...(heading !== undefined ? { heading } : {}),
    sourceSpans: block.text.length === 0 ? [] : [{
      revision, blockId: block.id, blockType: block.type,
      chunkStart: 0, chunkEnd: block.text.length,
      blockStart: 0, blockEnd: block.text.length,
      ...(block.pageIndex !== undefined ? { pageIndex: block.pageIndex } : {}),
      ...(block.bbox !== undefined ? { bbox: block.bbox } : {}),
      ...(block.assetIds !== undefined ? { assetIds: block.assetIds } : {}),
    }],
  }
}

function slicePiece(piece: StructuredChunkPiece, start: number, end: number): StructuredChunkPiece {
  // Trim by advancing offsets, not by rematching repeated source strings.
  const raw = piece.text.slice(start, end)
  const lo = start + raw.length - raw.trimStart().length
  const hi = Math.max(lo, end - (raw.length - raw.trimEnd().length))
  return {
    text: piece.text.slice(lo, hi),
    ...(piece.heading !== undefined ? { heading: piece.heading } : {}),
    ...(piece.sourceSpans !== undefined ? { sourceSpans: sliceSourceSpans(piece.sourceSpans, lo, hi) } : {}),
  }
}

function joinPieces(left: StructuredChunkPiece, right: StructuredChunkPiece, separator = '\n\n'): StructuredChunkPiece {
  const shift = left.text.length + separator.length
  return {
    text: `${left.text}${separator}${right.text}`,
    ...(right.heading !== undefined || left.heading !== undefined ? { heading: right.heading ?? left.heading } : {}),
    sourceSpans: [
      ...(left.sourceSpans ?? []),
      ...(right.sourceSpans ?? []).map(span => ({ ...span, chunkStart: span.chunkStart + shift, chunkEnd: span.chunkEnd + shift })),
    ],
  }
}

/** Exact bounded continuation; a giant formula/row cannot bypass the token cap. */
function windows(piece: StructuredChunkPiece, budget: number, overlap: number): StructuredChunkPiece[] {
  if (piece.text.trim().length === 0) return []
  if (estimateContextTokens(piece.text) <= budget) return [slicePiece(piece, 0, piece.text.length)]
  const pieces: StructuredChunkPiece[] = []
  let start = 0
  while (start < piece.text.length) {
    let end = boundedEnd(piece.text, start, budget)
    if (end < piece.text.length) {
      const floor = start + Math.floor((end - start) * 0.7)
      for (let i = end - 1; i >= floor; i -= 1) {
        if (/[\n。！？.!?;]/.test(piece.text[i])) { end = i + 1; break }
      }
    }
    const part = slicePiece(piece, start, end)
    if (part.text.length > 0) pieces.push(part)
    if (end >= piece.text.length) break
    let next = end
    if (overlap > 0) {
      while (next > start + 1 && estimateContextTokens(piece.text.slice(next - 1, end)) <= overlap) next -= 1
    }
    start = Math.max(start + 1, next)
  }
  return pieces
}

function boundedEnd(text: string, start: number, budget: number): number {
  let low = start + 1
  let high = Math.min(text.length, start + budget * 4)
  let best = low
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (estimateContextTokens(text.slice(start, mid)) <= budget) { best = mid; low = mid + 1 }
    else high = mid - 1
  }
  // Never split a surrogate pair. Offsets remain UTF-16, not code-point indices.
  if (best < text.length && /[\uD800-\uDBFF]/.test(text[best - 1]) && /[\uDC00-\uDFFF]/.test(text[best])) best -= 1
  return Math.max(start + 1, best)
}

function tablePieces(piece: StructuredChunkPiece, budget: number): StructuredChunkPiece[] {
  if (estimateContextTokens(piece.text) <= budget) return [piece]
  if (/<table\b/i.test(piece.text)) return htmlTablePieces(piece, budget)
  const lines = [...piece.text.matchAll(/[^\n]+(?:\n|$)|\n/g)].map(match => ({ start: match.index, end: match.index + match[0].length, text: match[0] }))
  const separator = lines.findIndex(line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line.text.trim()))
  if (separator !== 1 || lines.length < 3) return windows(piece, budget, 0)
  const header = slicePiece(piece, 0, lines[1].end)
  const headerCost = estimateContextTokens(header.text + '\n')
  // Oversized headers cannot be repeated truthfully under the budget. Retain
  // all their source bytes as bounded pieces rather than silently truncate.
  if (headerCost >= budget / 2) return windows(piece, budget, 0)
  const result: StructuredChunkPiece[] = []
  let current = header
  let hasRow = false
  const flush = (): void => { if (hasRow) result.push(current); current = header; hasRow = false }
  for (const line of lines.slice(2)) {
    if (line.text.trim().length === 0) continue
    const row = slicePiece(piece, line.start, line.end)
    const combined = joinPieces(current, row, '\n')
    if (estimateContextTokens(combined.text) <= budget) { current = combined; hasRow = true; continue }
    flush()
    for (const segment of windows(row, Math.max(1, budget - headerCost), 0)) {
      const candidate = joinPieces(current, segment, '\n')
      if (hasRow && estimateContextTokens(candidate.text) > budget) flush()
      current = joinPieces(current, segment, '\n')
      hasRow = true
    }
  }
  flush()
  return result
}

/** Keep HTML table rows/header as exact slices, not a lossy HTML-to-text guess. */
function htmlTablePieces(piece: StructuredChunkPiece, budget: number): StructuredChunkPiece[] {
  const rows = [...piece.text.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi)]
  if (rows.length < 2) return windows(piece, budget, 0)
  let headerRows = 0
  while (headerRows < rows.length && /<th\b/i.test(rows[headerRows][0])) headerRows += 1
  if (headerRows === 0 || headerRows === rows.length) return windows(piece, budget, 0)
  // A row range includes any intervening wrapper/spacing so no source content
  // disappears when the table uses thead/tbody or a trailing caption.
  const header = slicePiece(piece, 0, rows[headerRows].index)
  const tailStart = rows.at(-1)!.index + rows.at(-1)![0].length
  const tail = slicePiece(piece, tailStart, piece.text.length)
  const envelope = estimateContextTokens(header.text + tail.text + '\n\n')
  if (envelope >= budget / 2) return windows(piece, budget, 0)
  const result: StructuredChunkPiece[] = []
  let body: StructuredChunkPiece | undefined
  const wrap = (body: StructuredChunkPiece): StructuredChunkPiece => joinPieces(joinPieces(header, body, ''), tail, '')
  const flush = (): void => { if (body !== undefined) result.push(wrap(body)); body = undefined }
  for (let i = headerRows; i < rows.length; i += 1) {
    const row = slicePiece(piece, rows[i].index, i + 1 < rows.length ? rows[i + 1].index : tailStart)
    for (const segment of windows(row, budget - envelope, 0)) {
      const candidate = body === undefined ? segment : joinPieces(body, segment, '')
      if (body !== undefined && estimateContextTokens(wrap(candidate).text) > budget) flush()
      body = body === undefined ? segment : joinPieces(body, segment, '')
    }
  }
  flush()
  return result
}
