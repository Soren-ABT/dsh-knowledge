/**
 * Text chunking: split a document into overlapping character windows,
 * preferring paragraph, heading, and sentence boundaries so a chunk rarely
 * starts or ends mid-sentence. Each chunk records the markdown heading path
 * that introduces it, so retrieval can inject it as context.
 * @module dsh-knowledge/knowledge/chunk
 */
import type { DocumentSourceSpan } from './processing-types.js'
import { sliceSourceSpans } from './source-spans.js'
import { snapSliceEnd } from './text-safety.js'

/** One chunk: its text plus the markdown heading path introducing it. */
export interface ChunkPiece {
  readonly text: string
  readonly heading?: string
  readonly sourceSpans?: readonly DocumentSourceSpan[]
}

/** Normalize line endings and collapse excessive blank lines. */
export function normalizeText(text: string): string {
  return normalizeLineBreaks(text).trim()
}

function normalizeLineBreaks(text: string): string {
  // First-line indentation distinguishes literal code from a thematic break.
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Split text using the document's estimated characters per token for the size
 * and overlap budgets. Smart mode joins short paragraphs within a section.
 * Delimiter-only mode keeps the configured boundaries. Empty inputs and
 * inputs consisting entirely of recognized markup produce no index entries.
 */
export function chunkText(
  text: string,
  size: number,
  overlap: number,
  options?: { smartChunk?: boolean; separator?: string },
): ChunkPiece[] {
  const source = normalizeLineBreaks(text)
  const normalized = source.trim()
  if (normalized.length === 0) return []
  // Cherry's chunkSize/chunkOverlap are TOKEN budgets: convert to characters
  // with the document's measured chars-per-token ratio so CJK and Latin
  // content produce comparable token-sized chunks (a fixed character budget
  // made Chinese chunks ~4x the token size of English ones).
  const tokenBudget = Number.isFinite(size) ? Math.max(64, Math.trunc(size)) : 64
  const tokenOverlap = Number.isFinite(overlap) ? Math.min(Math.max(0, Math.trunc(overlap)), tokenBudget - 1) : 0
  const charsPerToken = normalized.length / Math.max(1, estimateTokens(normalized))
  const safeSize = Math.max(64, Math.round(tokenBudget * charsPerToken))
  const safeOverlap = Math.min(Math.round(tokenOverlap * charsPerToken), safeSize - 1)
  if (options?.smartChunk === false) {
    const separator = normalizeSeparator(options.separator ?? '\n\n')
    const pieces = splitDelimited(source, separator)
    // A user-defined delimiter can consume the entire source (e.g. "END").
    // Keep the legacy fallback only when no nonblank piece was filtered out.
    if (pieces.length === 0 && delimiterConsumedText(source, separator)) {
      return [{ text: normalized.slice(0, safeSize) }]
    }
    return pieces.flatMap(piece => windowOrKeep(piece, safeSize, safeOverlap, undefined))
  }
  return splitBlocks(source, { mergeSize: safeSize })
    .flatMap(block => windowOrKeep(block.text, safeSize, safeOverlap, block.heading))
}

function windowOrKeep(blockText: string, size: number, overlap: number, heading: string | undefined): ChunkPiece[] {
  if (blockText.length <= size) return [{ text: blockText, ...(heading !== undefined ? { heading } : {}) }]
  return windowBlock(blockText, size, overlap)
    // A window whose overlap lands inside a run of whitespace trims to the
    // empty string; drop those pieces here (the windowing loop must still
    // advance past them) so a chunk list never contains empty chunks.
    .filter(piece => piece.length > 0)
    .map(piece => ({
      text: piece,
      ...(heading !== undefined ? { heading } : {}),
    }))
}

/** Let users type `\n\n` literally; convert it to real newlines. */
function normalizeSeparator(separator: string): string {
  const decoded = separator.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  return decoded.length > 0 ? decoded : '\n\n'
}

function delimiterConsumedText(text: string, separator: string): boolean {
  return !isSyntaxOnlyBlock(text) && text.split(separator).every(piece => !piece.trim())
}

/**
 * Semantic-chunking mode: split into paragraph-level candidate segments
 * (heading-aware, never windowed) so the caller can embed each segment and
 * merge adjacent similar ones via {@link mergeSemanticSegments}. Exported for
 * the service layer.
 */
export function splitSemanticSegments(text: string, options?: { separator?: string }): ChunkPiece[] {
  return splitBlocks(normalizeLineBreaks(text), {
    separator: options?.separator ? normalizeSeparator(options.separator) : undefined,
  })
}

/**
 * Greedy merge of embedded candidate segments into chunks of at most `size`
 * characters: adjacent segments merge while (a) their cosine similarity is at
 * least `threshold` (semantically coherent) and (b) the combined length stays
 * within `size`. The merged chunk's vector is the length-weighted mean of its
 * segments' vectors (renormalized), so semantic chunking costs no extra
 * embedding pass. Returns chunks with the merged text, the first segment's
 * heading, and the merged vector (when vectors were provided).
 */
export function mergeSemanticSegments(
  segments: readonly ChunkPiece[],
  vectors: readonly (number[] | undefined)[],
  size: number,
  threshold = 0.75,
): Array<ChunkPiece & { embedding?: number[] }> {
  // `size` is a token budget like chunkText's; convert with the document's
  // measured chars-per-token ratio.
  const fullText = segments.map(segment => segment.text).join('\n')
  const charsPerToken = fullText.length / Math.max(1, estimateTokens(fullText))
  const tokenBudget = Number.isFinite(size) ? Math.max(64, Math.trunc(size)) : 64
  const safeSize = Math.max(64, Math.round(tokenBudget * charsPerToken))
  const out: Array<ChunkPiece & { embedding?: number[] }> = []
  if (segments.length === 0) return out
  let text = segments[0].text
  let heading = segments[0].heading
  let vec: number[] | undefined = vectors[0]
  let weight = text.length
  const flush = (): void => {
    out.push({ text, ...(heading !== undefined ? { heading } : {}), ...(vec !== undefined ? { embedding: vec } : {}) })
  }
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i]
    // +1 accounts for the '\n' joining the segments.
    const nextLength = text.length + segment.text.length + 1
    const vector = vectors[i]
    const similar = vec !== undefined && vector !== undefined
      ? cosineSimilarity(vec, vector) >= threshold
      : true
    if (nextLength <= safeSize && similar) {
      text += `\n${segment.text}`
      if (vec !== undefined && vector !== undefined) {
        const newWeight = weight + segment.text.length
        vec = normalizeAdd(vec, weight, vector, segment.text.length)
        weight = newWeight
      }
    } else {
      flush()
      text = segment.text
      heading = segment.heading
      vec = vector
      weight = text.length
    }
  }
  flush()
  return out
}

/** Weighted mean of two vectors (a*aWeight + b*bWeight), then L2-normalized. */
function normalizeAdd(a: readonly number[], aWeight: number, b: readonly number[], bWeight: number): number[] {
  const out: number[] = new Array(a.length)
  let sum = 0
  for (let i = 0; i < a.length; i += 1) {
    const v = (a[i] * aWeight + b[i] * bWeight) / (aWeight + bWeight)
    out[i] = v
    sum += v * v
  }
  const length = Math.sqrt(sum)
  // A NaN/zero norm (empty or corrupt vectors) must not divide into NaN.
  if (!Number.isFinite(length) || length === 0) return out
  for (let i = 0; i < out.length; i += 1) out[i] /= length
  return out
}

/** Cosine similarity between two equal-length vectors (true cosine, so it is
 *  correct for both unit-normalized and raw vectors; NaN-safe). */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]
    const bv = b[i]
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  const norm = Math.sqrt(normA) * Math.sqrt(normB)
  if (norm === 0) return 0
  const cosine = dot / norm
  return Number.isFinite(cosine) ? Math.max(0, Math.min(1, cosine)) : 0
}

/**
 * Refine chunks to a token budget (Cherry's `refineChunksByTokenLimit`): any
 * chunk whose estimated token count exceeds `tokenLimit` is split at the
 * nearest preferred boundary (blank line → 。/！/？ → ， → space) around the
 * midpoint, recursively, until every piece fits. Pieces with no usable
 * boundary are kept whole (splitting mid-word would hurt retrieval). A
 * `tokenLimit` of 0 (or below) is a no-op.
 */
export function refineChunksByTokenLimit(
  chunks: readonly ChunkPiece[],
  tokenLimit: number,
  estimateTokens: (text: string) => number,
): ChunkPiece[] {
  if (tokenLimit <= 0) return [...chunks]
  const out: ChunkPiece[] = []
  const refine = (piece: ChunkPiece): void => {
    if (estimateTokens(piece.text) <= tokenLimit || piece.text.length < 40) {
      out.push(piece)
      return
    }
    const split = splitAtPreferredBoundary(piece.text)
    if (split === null) {
      out.push(piece)
      return
    }
    const heading = piece.heading !== undefined ? { heading: piece.heading } : {}
    refine({ text: split[0], ...heading, ...(piece.sourceSpans !== undefined ? { sourceSpans: sliceSourceSpans(piece.sourceSpans, split[2], split[2] + split[0].length) } : {}) })
    refine({ text: split[1], ...heading, ...(piece.sourceSpans !== undefined ? { sourceSpans: sliceSourceSpans(piece.sourceSpans, split[3], split[3] + split[1].length) } : {}) })
  }
  for (const chunk of chunks) refine(chunk)
  return out
}

/** Split `text` at the last preferred boundary within ±25% of the midpoint. */
function splitAtPreferredBoundary(text: string): [string, string, number, number] | null {
  const mid = Math.floor(text.length / 2)
  const radius = Math.max(1, Math.floor(text.length * 0.25))
  const lo = Math.max(0, mid - radius)
  const hi = Math.min(text.length, mid + radius)
  const window = text.slice(lo, hi)
  for (const separator of ['\n\n', '。', '！', '？', '，', ', ', ' ']) {
    const idx = window.lastIndexOf(separator)
    if (idx < 0) continue
    const cut = lo + idx + separator.length
    const left = text.slice(0, cut).trim()
    const right = text.slice(cut).trim()
    if (left.length > 0 && right.length > 0) return [left, right,
      text.slice(0, cut).length - text.slice(0, cut).trimStart().length,
      cut + text.slice(cut).length - text.slice(cut).trimStart().length]
  }
  return null
}

/** Merge threshold in UTF-16 code units, matching the splitter's offsets. */
const MIN_BLOCK_CHARS = 40
const CODE_INDENT = /^(?: {4}| {0,3}\t)/

/** Standalone markup. Leave arguments that could contain authored text intact. */
const SYNTAX_ONLY_LINE: readonly RegExp[] = [
  /^(?:-[ \t]*){3,}$/, /^(?:\*[ \t]*){3,}$/, /^(?:_[ \t]*){3,}$/, // Markdown thematic breaks
  /^<hr(?:[ \t][^<>]*)?\/?>$/i,
  /^([=\-~^"'`#*+_])\1{3,}$/,           // RST transitions / Org rules repeat one character
  /^'{3,}$/, /^\|={3,}$/,                // AsciiDoc horizontal rule / table delimiter
  /^\$\$$/, /^\\\[$/, /^\\\]$/,          // LaTeX display math
  /^\\(?:begin|end)\{[a-zA-Z][a-zA-Z0-9@*-]*\}$/,
  /^\\begin\{(?:tabular|array)\}(?:\[[tbc]\])?\{[lcr| \t]+\}$/,
  /^\\(?:hline|toprule|midrule|bottomrule)$/, /^\\cline\{\d+-\d+\}$/,
  /^\.\.\s+[A-Za-z0-9_-]+::$/,          // RST directive without arguments
]

function isSyntaxOnlyBlock(text: string): boolean {
  return text.split('\n').every(line => {
    const trimmed = line.trim()
    return !trimmed || (!CODE_INDENT.test(line) && SYNTAX_ONLY_LINE.some(pattern => pattern.test(trimmed)))
  })
}

/** Source offsets keep code recognizable even if a custom separator cuts a line in half. */
function* codeRanges(text: string, includeIndented: boolean): Generator<{ start: number; end: number }, undefined> {
  let opening: { start: number; marker: string } | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    const start = offset
    const end = start + line.length
    offset = end + 1
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (match !== null) {
      const [, marker, rest] = match
      if (opening === undefined) {
        if (marker[0] !== '`' || !rest.includes('`')) opening = { start, marker }
      } else if (marker[0] === opening.marker[0] && marker.length >= opening.marker.length && !rest.trim()) {
        yield { start: opening.start, end }
        opening = undefined
      }
    } else if (includeIndented && opening === undefined && CODE_INDENT.test(line) && line.trim()) {
      yield { start, end }
    }
  }
  if (opening !== undefined) yield { start: opening.start, end: text.length }
}

/** Split at every literal separator, retaining markup-looking pieces inside code. */
function splitDelimited(text: string, separator: string): string[] {
  const out: string[] = []
  const ranges = codeRanges(text, true)
  let code = ranges.next().value
  let start = 0
  for (const raw of text.split(separator)) {
    const end = start + raw.length
    const piece = raw.trim()
    if (piece) {
      const contentStart = end - raw.trimStart().length
      while (code !== undefined && code.end <= contentStart) code = ranges.next().value
      const inCode = code !== undefined && code.start < contentStart + piece.length
      if (inCode || !isSyntaxOnlyBlock(raw)) out.push(piece)
    }
    start = end + separator.length
  }
  return out
}

/** Read paragraphs in section order. Only the ordinary smart path supplies a merge budget. */
function splitBlocks(text: string, options: { mergeSize?: number; separator?: string }): ChunkPiece[] {
  const blocks: ChunkPiece[] = []
  const headings: string[] = []
  let path: string | undefined
  let sectionStart = 0
  const append = (body: string): void => {
    const previous = blocks.at(-1)
    if (options.mergeSize !== undefined && previous !== undefined && blocks.length > sectionStart
      && (previous.text.length < MIN_BLOCK_CHARS || body.length < MIN_BLOCK_CHARS)
      && previous.text.length + 2 + body.length <= options.mergeSize) {
      blocks[blocks.length - 1] = { ...previous, text: `${previous.text}\n\n${body}` }
    } else {
      blocks.push({ text: body, ...(path !== undefined ? { heading: path } : {}) })
    }
  }

  const readProse = (prose: string): void => {
    let paragraph: string[] = []
    const flush = (): void => {
      if (!paragraph.length) return
      const raw = paragraph.join('\n')
      paragraph = []
      if (options.separator !== undefined && raw.includes(options.separator)) {
        for (const piece of splitDelimited(raw, options.separator)) append(piece)
      } else if (!isSyntaxOnlyBlock(raw)) {
        append(raw.trim())
      }
    }
    for (const line of prose.split('\n')) {
      const heading = matchHeading(line)
      if (heading !== undefined) {
        flush()
        headings.length = heading.level
        headings[heading.level - 1] = heading.title
        path = headings.filter(Boolean).join(' > ')
        // Another occurrence of the same title starts a distinct section.
        sectionStart = blocks.length
      } else if (!line.trim()) {
        flush()
      } else {
        paragraph.push(line)
      }
    }
    flush()
  }

  let offset = 0
  for (const range of codeRanges(text, false)) {
    readProse(text.slice(offset, range.start))
    append(text.slice(range.start, range.end).trim())
    offset = range.end
  }
  readProse(text.slice(offset))
  if (blocks.length === 0 && headings.length > 0) {
    // Heading-only documents still have searchable text, even if rules between
    // the headings were discarded.
    const titles = text.split('\n').filter(line => matchHeading(line) !== undefined)
    blocks.push({ text: titles.join('\n\n').trim() })
  } else if (blocks.length === 0 && options.separator !== undefined && delimiterConsumedText(text, options.separator)) {
    blocks.push({ text: text.trim() })
  }
  return blocks
}

function matchHeading(line: string): { level: number; title: string } | undefined {
  const match = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/.exec(line)
  if (match === null) return undefined
  return { level: match[1].length, title: match[2].trim() }
}

/** Window one long block at the best scored break (Cherry's splitter). */
function windowBlock(block: string, size: number, overlap: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < block.length) {
    const end = start + size
    if (end >= block.length) {
      chunks.push(block.slice(start).trim())
      break
    }
    // Prefer a high-quality break within the last WINDOW_RATIO of the budget
    // (heading > code edge > rule > paragraph > list > sentence > newline).
    const windowStart = Math.max(start + 1, end - Math.max(1, Math.round(size * WINDOW_RATIO)))
    let cut = Math.max(findCut(block, end, windowStart), start + 1)
    const tailStart = Math.max(cut - overlap, start + 1)
    if (block.length - tailStart <= size) {
      const tail = block.slice(tailStart)
      if (tail.trim() && isSyntaxOnlyBlock(tail)) {
        // Cutting immediately before a Setext underline can create a final
        // "---" hit. Rebalance the two windows without losing the underline.
        const middle = Math.ceil((start + block.length + overlap) / 2)
        const earliest = Math.max(start + 1, block.length - size + overlap)
        const searchStart = Math.max(earliest, middle - Math.round(size * WINDOW_RATIO))
        const balanced = snapSliceEnd(block, findCut(block, middle, searchStart))
        if (balanced >= earliest) cut = Math.min(cut, balanced)
      }
    }
    chunks.push(block.slice(start, cut).trim())
    const next = Math.max(cut - overlap, start + 1)
    if (next <= start) break
    start = next
  }
  return chunks
}

/**
 * Cherry's break-point model (adapted from splitter.ts): markdown boundaries
 * scored by structural quality, distance-decayed toward the end of the window
 * (a break at the window edge keeps DECAY_FACTOR of its score). Chinese
 * sentence punctuation joins as a low-scoring fallback. The cut lands at the
 * pattern's match index (the newline stays with the next block), except
 * sentence punctuation which cuts AFTER the mark.
 */
const BREAK_PATTERNS: ReadonlyArray<{ pattern: RegExp; score: number; after?: boolean }> = [
  { pattern: /\n#{1}(?!#)/g, score: 100 },
  { pattern: /\n#{2}(?!#)/g, score: 90 },
  { pattern: /\n#{3}(?!#)/g, score: 80 },
  { pattern: /\n#{4}(?!#)/g, score: 70 },
  { pattern: /\n#{5}(?!#)/g, score: 60 },
  { pattern: /\n#{6}(?!#)/g, score: 50 },
  { pattern: /\n```/g, score: 80 },
  { pattern: /\n(?:---|\*\*\*|___)\s*\n/g, score: 60 },
  { pattern: /\n\n+/g, score: 20 },
  { pattern: /[。！？]/g, score: 8, after: true },
  { pattern: /\n[-*]\s/g, score: 5 },
  { pattern: /\n\d+\.\s/g, score: 5 },
  { pattern: /\n/g, score: 1 },
]
/** ~22% of the chunk budget — how far back from the target we hunt for a break. */
const WINDOW_RATIO = 0.22
/** Distance-decay strength: a break at the window edge keeps 70% of its score. */
const DECAY_FACTOR = 0.7

function findCut(block: string, end: number, min: number): number {
  const windowSize = Math.max(1, end - min)
  let bestPos = -1
  let bestScore = -1
  const source = block.slice(min, end)
  for (const { pattern, score, after } of BREAK_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const cut = min + match.index + (after === true ? match[0].length : 0)
      const decayed = score * Math.pow(DECAY_FACTOR, (end - cut) / windowSize)
      if (decayed > bestScore) {
        bestScore = decayed
        bestPos = cut
      }
    }
  }
  return bestPos > min ? bestPos : end
}

/** CJK-heavy text costs ~1.5 chars/token, latin ~4 — same rule as the service layer. */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  const latin = text.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}
