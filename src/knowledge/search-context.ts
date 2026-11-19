import { clampInt } from './bounds.js'
import { composeContextWindow } from './context.js'
import type { RankedHit } from './retrieval.js'
import type { Store } from './store.js'
import type { KnowledgeChunk, SearchHit } from './types.js'

export function searchHitOf(store: Store, chunk: KnowledgeChunk | undefined, hit: RankedHit): SearchHit | undefined {
  if (chunk === undefined) return undefined
  return {
    chunkId: chunk.id,
    docId: chunk.docId,
    baseId: chunk.baseId,
    documentTitle: store.getDocument(chunk.docId)?.title ?? chunk.docId,
    ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
    index: chunk.index,
    text: chunk.text,
    ...(chunk.sourceSpans !== undefined ? { sourceSpans: chunk.sourceSpans } : {}),
    ...(chunk.processingRevision !== undefined ? { processingRevision: chunk.processingRevision } : {}),
    score: hit.score,
    ...(hit.vectorScore !== undefined ? { vectorScore: hit.vectorScore } : {}),
    ...(hit.lexicalScore !== undefined ? { lexicalScore: hit.lexicalScore } : {}),
  }
}

/** Attach token-bounded ordered context to all hits while loading all merged
 * document ranges through one storage operation. */
export function attachContextWindows(
  store: Store,
  hits: readonly SearchHit[],
  focus: string,
  radius: number,
  maxTokens: number,
  reserveTokens?: (hit: SearchHit) => number,
): SearchHit[] {
  if (hits.length === 0) return []
  const safeRadius = clampInt(radius, 0, 10, 0)
  const ranges = mergeChunkRanges(hits.map(hit => ({
    docId: hit.docId,
    fromIdx: Math.max(0, hit.index - safeRadius),
    toIdx: hit.index + safeRadius,
  })))
  const loaded = store.listChunksByIndexRanges(ranges)
  const byDoc = new Map<string, KnowledgeChunk[]>()
  for (const chunk of loaded) {
    const list = byDoc.get(chunk.docId) ?? []
    list.push(chunk)
    byDoc.set(chunk.docId, list)
  }
  return hits.map(hit => {
    const anchor: KnowledgeChunk = {
      id: hit.chunkId,
      docId: hit.docId,
      baseId: hit.baseId,
      index: hit.index,
      text: hit.text,
      ...(hit.sourceSpans !== undefined ? { sourceSpans: hit.sourceSpans } : {}),
      ...(hit.processingRevision !== undefined ? { processingRevision: hit.processingRevision } : {}),
      ...(hit.heading !== undefined ? { heading: hit.heading } : {}),
    }
    const neighbours = byDoc.get(hit.docId) ?? [anchor]
    const document = store.getDocument(hit.docId)
    const contextWindow = composeContextWindow(neighbours, anchor, {
      before: safeRadius,
      after: safeRadius,
      maxTokens: Math.max(1, maxTokens - (reserveTokens?.(hit) ?? 0)),
      focus,
      documentChunkCount: document?.chunkCount,
    })
    const legacy = safeRadius > 0
      ? neighbours
        .filter(chunk => chunk.id !== anchor.id && chunk.index >= anchor.index - safeRadius && chunk.index <= anchor.index + safeRadius)
        .sort((a, b) => a.index - b.index)
        .map(chunk => `${chunk.heading !== undefined ? `[${chunk.heading}] ` : ''}${chunk.text}`)
        .join('\n\n')
      : ''
    const { siblingContext: _oldSibling, contextWindow: _oldWindow, ...base } = hit
    return {
      ...base,
      contextWindow,
      ...(legacy.length > 0 ? { siblingContext: legacy } : {}),
    }
  })
}

function mergeChunkRanges(
  ranges: readonly { docId: string; fromIdx: number; toIdx: number }[],
): Array<{ docId: string; fromIdx: number; toIdx: number }> {
  const ordered = [...ranges].sort((a, b) => a.docId.localeCompare(b.docId) || a.fromIdx - b.fromIdx || a.toIdx - b.toIdx)
  const merged: Array<{ docId: string; fromIdx: number; toIdx: number }> = []
  for (const range of ordered) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && previous.docId === range.docId && range.fromIdx <= previous.toIdx + 1) {
      previous.toIdx = Math.max(previous.toIdx, range.toIdx)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}
