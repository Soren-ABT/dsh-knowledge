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

interface Block {
  readonly text: string
  readonly heading?: string
}

/** Split into paragraph-level blocks, tracking the active markdown heading path. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let current = ''
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
