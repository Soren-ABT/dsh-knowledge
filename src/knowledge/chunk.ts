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
  const safeSize = Math.max(64, Math.trunc(size))
  const safeOverlap = Math.min(Math.max(0, Math.trunc(overlap)), safeSize - 1)
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
  const safeSize = Math.max(64, Math.trunc(size))
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
  if (length === 0) return out
  for (let i = 0; i < out.length; i += 1) out[i] /= length
  return out
}

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return Math.max(0, Math.min(1, dot))
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
      if (/^\s*(```|~~~)\s*$/.test(line)) fence = ''
      continue
    }
    const fenceStart = /^\s*(```+|~~~+)/.exec(line)
    if (fenceStart !== null) {
      flush()
      fence = fenceStart[1].slice(0, 3)
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

/** Window one long block at sentence boundaries. */
function windowBlock(block: string, size: number, overlap: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < block.length) {
    const end = start + size
    if (end >= block.length) {
      chunks.push(block.slice(start).trim())
      break
    }
    // Prefer a sentence boundary within the last 40% of the window.
    const cut = Math.max(findCut(block, end, start + Math.floor(size * 0.6)), start + 1)
    chunks.push(block.slice(start, cut).trim())
    const next = Math.max(cut - overlap, start + 1)
    if (next <= start) break
    start = next
  }
  return chunks
}

function findCut(block: string, end: number, min: number): number {
  const window = block.slice(min, end)
  let best = -1
  for (const sep of ['。', '！', '？', '. ', '! ', '? ', '\n']) {
    const idx = window.lastIndexOf(sep)
    if (idx >= 0) best = Math.max(best, min + idx + sep.length)
  }
  return best > min ? best : end
}
