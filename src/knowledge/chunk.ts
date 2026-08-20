/**
 * Text chunking: split a document into overlapping character windows,
 * preferring paragraph, heading, and sentence boundaries so a chunk rarely
 * starts or ends mid-sentence. Each chunk records the markdown heading path
 * that introduces it, so retrieval can inject it as context.
 * @module dsh-knowledge/knowledge/chunk
 */

/** One chunk: its text plus the markdown heading path introducing it. */
export interface ChunkPiece {
  readonly text: string
  readonly heading?: string
}

/** Normalize line endings and collapse excessive blank lines. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split `text` into chunks of at most `size` characters with `overlap`
 * characters shared between consecutive chunks. With `smartChunk` (default)
 * blocks are paragraphs and markdown headings; otherwise the text splits on
 * `separator` only. Long blocks are windowed at sentence boundaries.
 * @returns non-empty array of chunks (guaranteed one chunk for non-empty input).
 */
export function chunkText(
  text: string,
  size: number,
  overlap: number,
  options?: { smartChunk?: boolean; separator?: string },
): ChunkPiece[] {
  const normalized = normalizeText(text)
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
  const smartChunk = options?.smartChunk ?? true
  const blocks = smartChunk
    ? splitBlocks(normalized)
    : [{ text: normalized, heading: undefined }]
  const chunks: ChunkPiece[] = []
  for (const block of blocks) {
    // In delimiter-only mode, split the text on the configured separator first.
    if (!smartChunk) {
      const separator = normalizeSeparator(options?.separator ?? '\n\n')
      const pieces = block.text.split(separator).map(piece => piece.trim()).filter(piece => piece.length > 0)
      for (const piece of pieces) {
        chunks.push(...windowOrKeep(piece, safeSize, safeOverlap, block.heading))
      }
      continue
    }
    chunks.push(...windowOrKeep(block.text, safeSize, safeOverlap, block.heading))
  }
  // A degenerate guard: always yield at least one chunk for non-empty input.
  return chunks.length > 0 ? chunks : [{ text: normalized.slice(0, safeSize) }]
}

function windowOrKeep(blockText: string, size: number, overlap: number, heading: string | undefined): ChunkPiece[] {
  if (blockText.length <= size) return [{ text: blockText, ...(heading !== undefined ? { heading } : {}) }]
  return windowBlock(blockText, size, overlap).map(piece => ({
    text: piece,
    ...(heading !== undefined ? { heading } : {}),
  }))
}

/** Let users type `\n\n` literally; convert it to real newlines. */
function normalizeSeparator(separator: string): string {
  const decoded = separator.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  return decoded.length > 0 ? decoded : '\n\n'
}

/**
 * Semantic-chunking mode: split into paragraph-level candidate segments
 * (heading-aware, never windowed) so the caller can embed each segment and
 * merge adjacent similar ones via {@link mergeSemanticSegments}. Exported for
 * the service layer.
 */
export function splitSemanticSegments(text: string, options?: { separator?: string }): ChunkPiece[] {
  const normalized = normalizeText(text)
  if (normalized.length === 0) return []
  const blocks = splitBlocks(normalized)
  if (options?.separator === undefined || options.separator === '') return blocks
  const separator = normalizeSeparator(options.separator)
  const out: ChunkPiece[] = []
  for (const block of blocks) {
    for (const piece of block.text.split(separator).map(piece => piece.trim()).filter(piece => piece.length > 0)) {
      out.push({ text: piece, ...(block.heading !== undefined ? { heading: block.heading } : {}) })
    }
  }
  return out
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
    refine({ text: split[0], ...heading })
    refine({ text: split[1], ...heading })
  }
  for (const chunk of chunks) refine(chunk)
  return out
}

/** Split `text` at the last preferred boundary within ±25% of the midpoint. */
function splitAtPreferredBoundary(text: string): [string, string] | null {
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
    if (left.length > 0 && right.length > 0) return [left, right]
  }
  return null
}

interface Block {
  readonly text: string
  readonly heading?: string
}

/** Split into paragraph-level blocks, tracking the active markdown heading path. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let current = ''
  /** Fence marker (` ``` ` or `~~~`) when inside a code block — blank lines and
   *  headings inside the fence must not break the block (Cherry's splitter
   *  code-fence protection). */
  let fence = ''
  const headings: string[] = []
  const headingPath = (): string | undefined => {
    // Skip levels never seen (e.g. `#` directly under `###`) so the path has no empty segments.
    const present = headings.filter(entry => entry !== undefined && entry.trim().length > 0)
    return present.length > 0 ? present.join(' > ') : undefined
  }

  const flush = (): void => {
    if (current.trim().length > 0) {
      const path = headingPath()
      blocks.push({ text: current.trim(), ...(path !== undefined ? { heading: path } : {}) })
    }
    current = ''
  }

  for (const line of text.split('\n')) {
    if (fence !== '') {
      // Inside a fence: keep everything (including blank lines) in the block.
      current += (current.length > 0 ? '\n' : '') + line
      // Close when the line is a run of the SAME fence character at least as
      // long as the opener (GitHub rule: ```` closes ```, and a 4-backtick
      // opener needs 4+ backticks). The opener's full string is kept so the
      // length is not lost.
      const closer = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
      if (closer.test(line)) fence = ''
      continue
    }
    const fenceStart = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceStart !== null) {
      flush()
      fence = fenceStart[1]
      current = line
      continue
    }
    const heading = matchHeading(line)
    if (heading !== undefined) {
      flush()
      // Maintain a heading stack: a heading at level L replaces everything at L and deeper.
      const level = heading.level
      headings.length = level
      headings[level - 1] = heading.title
      continue
    }
    if (line.trim().length === 0) {
      flush()
      continue
    }
    current += (current.length > 0 ? '\n' : '') + line
  }
  flush()
  return blocks
}

function matchHeading(line: string): { level: number; title: string } | undefined {
  const match = /^(#{1,6})\s+(.+)$/.exec(line)
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
    const cut = Math.max(findCut(block, end, windowStart), start + 1)
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
