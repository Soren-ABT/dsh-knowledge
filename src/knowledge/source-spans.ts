import type { DocumentSourceSpan } from './processing-types.js'

/** Clip exact UTF-16 mappings to a displayed substring; never infer positions. */
export function sliceSourceSpans(
  spans: readonly DocumentSourceSpan[] | undefined,
  start: number,
  end: number,
): DocumentSourceSpan[] {
  if (spans === undefined || end <= start) return []
  const result: DocumentSourceSpan[] = []
  for (const span of spans) {
    if (!validSourceSpan(span)) continue
    const lo = Math.max(start, span.chunkStart)
    const hi = Math.min(end, span.chunkEnd)
    if (hi <= lo) continue
    result.push({
      ...span,
      chunkStart: lo - start,
      chunkEnd: hi - start,
      blockStart: span.blockStart + lo - span.chunkStart,
      blockEnd: span.blockStart + hi - span.chunkStart,
    })
  }
  return result
}

export function validSourceSpan(value: unknown): value is DocumentSourceSpan {
  if (typeof value !== 'object' || value === null) return false
  const span = value as DocumentSourceSpan
  return typeof span.revision === 'string' && span.revision.length > 0
    && typeof span.blockId === 'string' && span.blockId.length > 0
    && ['text', 'heading', 'table', 'equation', 'image', 'caption', 'code', 'list', 'unknown'].includes(span.blockType)
    && [span.chunkStart, span.chunkEnd, span.blockStart, span.blockEnd].every(n => Number.isSafeInteger(n) && n >= 0)
    && span.chunkEnd > span.chunkStart && span.blockEnd > span.blockStart
    && span.chunkEnd - span.chunkStart === span.blockEnd - span.blockStart
    && (span.pageIndex === undefined || (Number.isSafeInteger(span.pageIndex) && span.pageIndex >= 0))
}

/** Bounded citation labels. Full IDs and geometry remain in structured output. */
export function sourceSpanLabel(spans: readonly DocumentSourceSpan[] | undefined): string {
  const unique = new Map<string, DocumentSourceSpan>()
  for (const span of spans ?? []) {
    if (validSourceSpan(span)) unique.set(`${span.revision}\0${span.blockId}`, span)
  }
  if (unique.size === 0) return ''
  const labels = [...unique.values()].slice(0, 3).map(span => {
    const id = span.blockId.replace(/[\r\n\[\]\u0000-\u001f]/g, '_').slice(0, 40)
    return `${span.pageIndex === undefined ? '' : `p.${span.pageIndex + 1} `}${span.blockType}:${id}`
  })
  return `[source ${labels.join('; ')}${unique.size > 3 ? `; +${unique.size - 3}` : ''}] `
}
