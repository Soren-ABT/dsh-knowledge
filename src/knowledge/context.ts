import type { ContextChunkExcerpt, ContextWindow, KnowledgeChunk } from './types.js'

const DEFAULT_CONTEXT_TOKENS = 768
const DEFAULT_NEIGHBOURS = 1
const MIN_OVERLAP_CHARS = 24
const SENTENCE_BOUNDARY = /[\n\r。！？；.!?;]/

/** Options for composing an ordered evidence window from already-loaded chunks. */
export interface ComposeContextWindowOptions {
  /** Maximum chunks to include on the earlier side of the anchor. */
  readonly before?: number
  /** Maximum chunks to include on the later side of the anchor. */
  readonly after?: number
  /** Hard budget for the canonical serialized window. */
  readonly maxTokens?: number
  /** Query/identifier used to centre an oversized anchor excerpt. */
  readonly focus?: string
  /** By default context stops at a different Markdown heading path. */
  readonly crossHeading?: boolean
  /** Total chunks in the document, when known, for an exact `hasMoreAfter`. */
  readonly documentChunkCount?: number
  /** Explicit availability hints override inference from loaded chunks. */
  readonly hasMoreBefore?: boolean
  readonly hasMoreAfter?: boolean
}

/** CJK-heavy text costs about 1.5 chars/token and other text about 4.
 * This intentionally mirrors the service/chunker estimate and is deterministic
 * across platforms; it does not download or initialise a model tokenizer. */
export function estimateContextTokens(text: string): number {
  if (text.length === 0) return 0
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  const latin = text.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}

/** Serialize the exact evidence seen by rerank, tools, auto-preview and evals.
 * The output is always in document order; `>>>` marks (but never moves) the
 * canonical hit. */
export function serializeContextWindow(window: ContextWindow): string {
  const parts: string[] = []
  for (const excerpt of window.before) parts.push(serializeExcerpt(excerpt, false))
  parts.push(serializeExcerpt(window.anchor, true))
  for (const excerpt of window.after) parts.push(serializeExcerpt(excerpt, false))
  return parts.join('\n\n')
}

/**
 * Build a deterministic context window without touching a store. `chunks` may
 * contain a whole document or only a prefetched range; unrelated documents are
 * ignored. The supplied anchor remains authoritative even when it was not part
 * of the prefetched array.
 */
export function composeContextWindow(
  chunks: readonly KnowledgeChunk[],
  anchor: KnowledgeChunk,
  options: ComposeContextWindowOptions = {},
): ContextWindow {
  const beforeLimit = clampInt(options.before, 0, 10, DEFAULT_NEIGHBOURS)
  const afterLimit = clampInt(options.after, 0, 10, DEFAULT_NEIGHBOURS)
  const maxTokens = clampInt(options.maxTokens, 1, 1_000_000, DEFAULT_CONTEXT_TOKENS)
  const crossHeading = options.crossHeading === true

  const byIndex = new Map<number, KnowledgeChunk>()
  for (const chunk of chunks) {
    if (chunk.docId === anchor.docId && chunk.baseId === anchor.baseId) byIndex.set(chunk.index, chunk)
  }
  byIndex.set(anchor.index, anchor)
  const ordered = [...byIndex.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
  const earlierLoaded = ordered.filter(chunk => chunk.index < anchor.index)
  const laterLoaded = ordered.filter(chunk => chunk.index > anchor.index)
  const sameHeading = (chunk: KnowledgeChunk): boolean => crossHeading || normalizeHeading(chunk.heading) === normalizeHeading(anchor.heading)
  const eligibleBefore = takeWhile(contiguousTowardAnchor(earlierLoaded, anchor.index, -1), sameHeading)
  const eligibleAfter = takeWhile(contiguousTowardAnchor(laterLoaded, anchor.index, 1), sameHeading)

  // Keep only the requested nearest chunks, then return to reading order.
  const beforeChunks = eligibleBefore.slice(0, beforeLimit).reverse()
  const afterChunks = eligibleAfter.slice(0, afterLimit)

  let anchorExcerpt = excerptOf(anchor)
  anchorExcerpt = fitAnchorToBudget(anchorExcerpt, maxTokens, options.focus)

  const deduplicated = removeAdjacentOverlap(beforeChunks.map(excerptOf), anchorExcerpt, afterChunks.map(excerptOf))
  const beforeExcerpts = deduplicated.before
  const afterExcerpts = deduplicated.after

  // Availability is finalized after budget trimming; provisional values keep
  // construction helpers independent from the loaded-range bookkeeping.
  const hasMoreBefore = options.hasMoreBefore ?? false
  const hasMoreAfter = options.hasMoreAfter ?? false

  // Split the post-anchor budget between both sides first; an absent/short side
  // donates its unused allowance to the other side on the second pass.
  const anchorOnly = makeWindow(anchor, [], anchorExcerpt, [], hasMoreBefore, hasMoreAfter)
  const remaining = Math.max(0, maxTokens - anchorOnly.estimatedTokens)
  const beforeAllowance = afterExcerpts.length === 0 ? remaining : Math.floor(remaining / 2)
  const afterAllowance = beforeExcerpts.length === 0 ? remaining : remaining - beforeAllowance
  let fittedBefore = fitSide(beforeExcerpts, beforeAllowance, 'before')
  let fittedAfter = fitSide(afterExcerpts, afterAllowance, 'after')

  const usedBefore = estimateSideTokens(fittedBefore)
  const usedAfter = estimateSideTokens(fittedAfter)
  if (usedBefore < beforeAllowance && afterExcerpts.length > 0) {
    fittedAfter = fitSide(afterExcerpts, afterAllowance + beforeAllowance - usedBefore, 'after')
  }
  if (usedAfter < afterAllowance && beforeExcerpts.length > 0) {
    fittedBefore = fitSide(beforeExcerpts, beforeAllowance + afterAllowance - usedAfter, 'before')
  }

  let window = makeWindow(anchor, fittedBefore, anchorExcerpt, fittedAfter, hasMoreBefore, hasMoreAfter)
  window = enforceSerializedBudget(window, maxTokens, options.focus)
  const first = window.before[0] ?? window.anchor
  const last = window.after[window.after.length - 1] ?? window.anchor
  const finalHasMoreBefore = options.hasMoreBefore
    ?? (first.truncatedStart
      || first.index > 0
      || earlierLoaded.some(chunk => chunk.index < first.index))
  const finalHasMoreAfter = options.hasMoreAfter
    ?? (last.truncatedEnd
      || (options.documentChunkCount !== undefined
        ? last.index < Math.max(0, Math.trunc(options.documentChunkCount) - 1)
        : laterLoaded.some(chunk => chunk.index > last.index)))
  return makeWindow(anchor, window.before, window.anchor, window.after, finalHasMoreBefore, finalHasMoreAfter)
}

function serializeExcerpt(excerpt: ContextChunkExcerpt, anchor: boolean): string {
  const heading = excerpt.heading?.trim()
  const prefix = `${anchor ? '>>> ' : ''}${heading !== undefined && heading.length > 0 ? `[${heading}] ` : ''}`
  return `${prefix}${excerpt.text}`
}

function excerptOf(chunk: KnowledgeChunk): ContextChunkExcerpt {
  return {
    chunkId: chunk.id,
    index: chunk.index,
    ...(chunk.heading !== undefined ? { heading: chunk.heading } : {}),
    text: chunk.text,
    textStart: 0,
    textEnd: chunk.text.length,
    truncatedStart: false,
    truncatedEnd: false,
  }
}

function normalizeHeading(heading: string | undefined): string {
  return heading?.trim() ?? ''
}

/** Walk outwards from the anchor and stop at a missing index. This prevents a
 * partial prefetch from silently bridging an unloaded chunk. */
function contiguousTowardAnchor(chunks: readonly KnowledgeChunk[], anchorIndex: number, direction: -1 | 1): KnowledgeChunk[] {
  const byIndex = new Map(chunks.map(chunk => [chunk.index, chunk]))
  const result: KnowledgeChunk[] = []
  for (let index = anchorIndex + direction; ; index += direction) {
    const chunk = byIndex.get(index)
    if (chunk === undefined) break
    result.push(chunk)
  }
  return result
}

function takeWhile<T>(values: readonly T[], predicate: (value: T) => boolean): T[] {
  const result: T[] = []
  for (const value of values) {
    if (!predicate(value)) break
    result.push(value)
  }
  return result
}

function fitAnchorToBudget(excerpt: ContextChunkExcerpt, maxTokens: number, focus?: string): ContextChunkExcerpt {
  if (estimateContextTokens(serializeExcerpt(excerpt, true)) <= maxTokens) return excerpt
  return fitExcerptBySerializedBudget(excerpt, maxTokens, 'focus', true, focus)
}

function fitSide(
  candidatesInReadingOrder: readonly ContextChunkExcerpt[],
  allowance: number,
  side: 'before' | 'after',
): ContextChunkExcerpt[] {
  if (allowance <= 0 || candidatesInReadingOrder.length === 0) return []
  const nearFirst = side === 'before' ? [...candidatesInReadingOrder].reverse() : [...candidatesInReadingOrder]
  const selectedNearFirst: ContextChunkExcerpt[] = []
  let used = 0
  for (const candidate of nearFirst) {
    const available = allowance - used
    if (available <= 0) break
    const fullCost = estimateContextTokens(serializeExcerpt(candidate, false))
    if (fullCost <= available) {
      selectedNearFirst.push(candidate)
      used += fullCost
      continue
    }
    const fitted = fitExcerptBySerializedBudget(candidate, available, side === 'before' ? 'tail' : 'head', false)
    if (fitted.text.length > 0) selectedNearFirst.push(fitted)
    break
  }
  return side === 'before' ? selectedNearFirst.reverse() : selectedNearFirst
}

function estimateSideTokens(excerpts: readonly ContextChunkExcerpt[]): number {
  if (excerpts.length === 0) return 0
  return estimateContextTokens(excerpts.map(excerpt => serializeExcerpt(excerpt, false)).join('\n\n'))
}

function fitExcerptBySerializedBudget(
  excerpt: ContextChunkExcerpt,
  tokenBudget: number,
  mode: 'head' | 'tail' | 'focus',
  anchor: boolean,
  focus?: string,
): ContextChunkExcerpt {
  if (tokenBudget <= 0) return sliceExcerpt(excerpt, 0, 0)
  if (estimateContextTokens(serializeExcerpt(excerpt, anchor)) <= tokenBudget) return excerpt

  // An untrusted Markdown heading can itself be arbitrarily long. Drop it
  // from this bounded excerpt when metadata would otherwise consume the whole
  // evidence budget; the canonical chunk/search hit still retains the heading.
  let source = excerpt
  const emptyWithMetadata = sliceExcerpt(excerpt, 0, 0)
  if (excerpt.heading !== undefined
    && estimateContextTokens(serializeExcerpt(emptyWithMetadata, anchor)) >= tokenBudget) {
    const { heading: _heading, ...withoutHeading } = excerpt
    source = withoutHeading
  }

  let low = 0
  let high = source.text.length
  let best = sliceExcerpt(source, 0, 0)
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const candidate = cropExcerpt(source, length, mode, focus)
    if (estimateContextTokens(serializeExcerpt(candidate, anchor)) <= tokenBudget) {
      best = candidate
      low = length + 1
    } else {
      high = length - 1
    }
  }
  return best
}

function cropExcerpt(
  excerpt: ContextChunkExcerpt,
  length: number,
  mode: 'head' | 'tail' | 'focus',
  focus?: string,
): ContextChunkExcerpt {
  if (length <= 0) return sliceExcerpt(excerpt, 0, 0)
  if (length >= excerpt.text.length) return excerpt
  if (mode === 'head') return sliceExcerpt(excerpt, 0, sentenceEnd(excerpt.text, length))
  if (mode === 'tail') return sliceExcerpt(excerpt, sentenceStart(excerpt.text, excerpt.text.length - length), excerpt.text.length)

  const range = focusRange(excerpt.text, focus)
  // Missing focus degrades to the opening instead of an arbitrary middle
  // slice. The opening normally carries definitions required by later text.
  if (range === undefined) return sliceExcerpt(excerpt, 0, sentenceEnd(excerpt.text, length))
  const centre = Math.floor((range.start + range.end) / 2)
  let start = Math.max(0, Math.min(excerpt.text.length - length, centre - Math.floor(length / 2)))
  let end = Math.min(excerpt.text.length, start + length)
  start = sentenceStart(excerpt.text, start)
  // A backwards sentence adjustment can grow the slice; cap before selecting
  // the ending boundary so binary-search monotonicity remains predictable.
  if (end - start > length) start = end - length
  end = sentenceEnd(excerpt.text, Math.min(excerpt.text.length, start + length))
  if (end - start > length) end = start + length
  if (range !== undefined) {
    if (range.start < start) start = Math.max(0, Math.min(range.start, end - length))
    if (range.end > end) end = Math.min(excerpt.text.length, Math.max(range.end, start + length))
    if (end - start > length) {
      if (range.end - range.start >= length) {
        start = range.start
        end = Math.min(excerpt.text.length, start + length)
      } else {
        const excess = end - start - length
        const trimLeft = Math.min(excess, Math.max(0, range.start - start))
        start += trimLeft
        end -= excess - trimLeft
      }
    }
  }
  return sliceExcerpt(excerpt, start, end)
}

function focusRange(text: string, focus: string | undefined): { start: number; end: number } | undefined {
  const needle = focus?.trim()
  if (needle === undefined || needle.length === 0) return undefined
  const haystack = text.toLowerCase()
  const exact = haystack.indexOf(needle.toLowerCase())
  if (exact >= 0) return { start: exact, end: exact + needle.length }

  // Fall back to the longest meaningful query component (identifier, word or
  // CJK run), keeping generic prompt words from stealing the centre.
  const ignored = new Set(['请问', '什么', '如何', '怎么', '这个', '那个', 'please', 'what', 'how', 'this', 'that'])
  const components = needle.match(/[\p{L}\p{N}_./:-]+/gu) ?? []
  const cjkBigrams = components.flatMap(component => {
    if (!/^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(component) || component.length < 2) return []
    return Array.from({ length: component.length - 1 }, (_, index) => component.slice(index, index + 2))
  })
  const candidates = [...components, ...cjkBigrams]
    .filter(component => component.length >= 2 && !ignored.has(component.toLowerCase()))
    .sort((a, b) => b.length - a.length)
  for (const candidate of candidates) {
    const index = haystack.indexOf(candidate.toLowerCase())
    if (index >= 0) return { start: index, end: index + candidate.length }
  }
  return undefined
}

function sentenceStart(text: string, target: number): number {
  const floor = Math.max(0, target - 96)
  for (let index = Math.min(target - 1, text.length - 1); index >= floor; index -= 1) {
    if (SENTENCE_BOUNDARY.test(text[index])) return index + 1
  }
  return target
}

function sentenceEnd(text: string, target: number): number {
  const ceiling = Math.min(text.length, target + 96)
  for (let index = Math.max(0, target); index < ceiling; index += 1) {
    if (SENTENCE_BOUNDARY.test(text[index])) return index + 1
  }
  return target
}

function sliceExcerpt(excerpt: ContextChunkExcerpt, start: number, end: number): ContextChunkExcerpt {
  const safeStart = Math.max(0, Math.min(excerpt.text.length, Math.trunc(start)))
  const safeEnd = Math.max(safeStart, Math.min(excerpt.text.length, Math.trunc(end)))
  return {
    ...excerpt,
    text: excerpt.text.slice(safeStart, safeEnd),
    textStart: excerpt.textStart + safeStart,
    textEnd: excerpt.textStart + safeEnd,
    truncatedStart: excerpt.truncatedStart || safeStart > 0,
    truncatedEnd: excerpt.truncatedEnd || safeEnd < excerpt.text.length,
  }
}

function removeAdjacentOverlap(
  before: readonly ContextChunkExcerpt[],
  anchor: ContextChunkExcerpt,
  after: readonly ContextChunkExcerpt[],
): { before: ContextChunkExcerpt[]; after: ContextChunkExcerpt[] } {
  const nextBefore = [...before]
  const nextAfter = [...after]
  // Earlier chunks yield duplicate suffixes to the chunk closer to the anchor.
  for (let index = 0; index < nextBefore.length - 1; index += 1) {
    const overlap = longestSuffixPrefix(nextBefore[index].text, nextBefore[index + 1].text)
    if (overlap >= MIN_OVERLAP_CHARS) nextBefore[index] = sliceExcerpt(nextBefore[index], 0, nextBefore[index].text.length - overlap)
  }
  if (nextBefore.length > 0) {
    const last = nextBefore.length - 1
    const overlap = longestSuffixPrefix(nextBefore[last].text, anchor.text)
    if (overlap >= MIN_OVERLAP_CHARS) nextBefore[last] = sliceExcerpt(nextBefore[last], 0, nextBefore[last].text.length - overlap)
  }
  // The anchor is authoritative; later chunks lose duplicate prefixes.
  let previous = anchor
  for (let index = 0; index < nextAfter.length; index += 1) {
    const overlap = longestSuffixPrefix(previous.text, nextAfter[index].text)
    if (overlap >= MIN_OVERLAP_CHARS) nextAfter[index] = sliceExcerpt(nextAfter[index], overlap, nextAfter[index].text.length)
    previous = nextAfter[index]
  }
  return {
    before: nextBefore.filter(excerpt => excerpt.text.length > 0),
    after: nextAfter.filter(excerpt => excerpt.text.length > 0),
  }
}

function longestSuffixPrefix(left: string, right: string): number {
  const max = Math.min(left.length, right.length)
  for (let length = max; length >= MIN_OVERLAP_CHARS; length -= 1) {
    if (left.slice(left.length - length) === right.slice(0, length)) return length
  }
  return 0
}

function makeWindow(
  anchorChunk: Pick<KnowledgeChunk, 'id' | 'index'>,
  before: ContextChunkExcerpt[],
  anchor: ContextChunkExcerpt,
  after: ContextChunkExcerpt[],
  hasMoreBefore: boolean,
  hasMoreAfter: boolean,
): ContextWindow {
  const draft: ContextWindow = {
    anchorChunkId: anchorChunk.id,
    anchorIndex: anchorChunk.index,
    before,
    anchor,
    after,
    estimatedTokens: 0,
    hasMoreBefore,
    hasMoreAfter,
  }
  return { ...draft, estimatedTokens: estimateContextTokens(serializeContextWindow(draft)) }
}

function enforceSerializedBudget(window: ContextWindow, maxTokens: number, focus?: string): ContextWindow {
  let before = [...window.before]
  let after = [...window.after]
  let anchor = window.anchor
  let next = window
  while (next.estimatedTokens > maxTokens && (before.length > 0 || after.length > 0)) {
    // Shrink the farthest excerpt before dropping it. This absorbs separator /
    // heading rounding without sacrificing an entire side of a small window.
    const beforeDistance = before.length > 0 ? next.anchorIndex - before[0].index : -1
    const afterDistance = after.length > 0 ? after[after.length - 1].index - next.anchorIndex : -1
    const excess = next.estimatedTokens - maxTokens
    if (afterDistance >= beforeDistance) {
      const index = after.length - 1
      const excerpt = after[index]
      const cost = estimateContextTokens(serializeExcerpt(excerpt, false))
      const fitted = fitExcerptBySerializedBudget(excerpt, Math.max(0, cost - excess - 1), 'head', false)
      if (fitted.text.length === 0 || fitted.text.length >= excerpt.text.length) after.pop()
      else after[index] = fitted
    } else {
      const excerpt = before[0]
      const cost = estimateContextTokens(serializeExcerpt(excerpt, false))
      const fitted = fitExcerptBySerializedBudget(excerpt, Math.max(0, cost - excess - 1), 'tail', false)
      if (fitted.text.length === 0 || fitted.text.length >= excerpt.text.length) before.shift()
      else before[0] = fitted
    }
    next = makeWindow(
      { id: next.anchorChunkId, index: next.anchorIndex },
      before,
      anchor,
      after,
      next.hasMoreBefore,
      next.hasMoreAfter,
    )
  }
  if (next.estimatedTokens > maxTokens) {
    anchor = fitExcerptBySerializedBudget(anchor, maxTokens, 'focus', true, focus)
    next = makeWindow(
      { id: next.anchorChunkId, index: next.anchorIndex },
      [],
      anchor,
      [],
      next.hasMoreBefore,
      next.hasMoreAfter,
    )
  }
  return next
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
