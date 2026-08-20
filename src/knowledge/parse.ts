/**
 * Document parsing. Text-like formats decode directly; HTML is stripped to
 * text; PDF and DOCX use optional parsers; PPTX / XLSX / EPUB are extracted
 * from their zip container with jszip. Every parser loads lazily so a missing
 * dependency degrades to a clear error instead of breaking plugin load.
 * @module dsh-knowledge/knowledge/parse
 */

/**
 * The formats a knowledge import accepts (Cherry's `knowledgeSupportedFileExts`
 * plus json/log, which we decode as plain text). Anything else — binaries,
 * images, archives — is rejected at add time instead of being decoded into
 * garbage text (Cherry's directory scan skips unsupported extensions silently).
 */
export const SUPPORTED_DOCUMENT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'mdx', 'csv', 'html', 'htm', 'json', 'log',
  'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'epub',
] as const

/** Lowercased extension of a file name ('' when none). */
export function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : ''
}

/** Return the parsed text of a document buffer, dispatching on extension. */
export async function parseDocumentBuffer(
  buffer: Uint8Array,
  fileName: string,
  mimeType?: string,
): Promise<string> {
  const ext = extensionOf(fileName)
  if (mimeType === 'application/pdf' || ext === 'pdf') return parsePdf(buffer)
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') {
    return parseDocx(buffer)
  }
  if (ext === 'html' || ext === 'htm') return extractFromHtml(decodeText(buffer)).text
  if (ext === 'pptx') return parsePptx(buffer)
  if (ext === 'xlsx') return parseXlsx(buffer)
  if (ext === 'epub') return parseEpub(buffer)
  if (ext === 'doc') return parseDoc(buffer)
  if (ext === 'ppt') return parseLegacyOffice(buffer, 'ppt')
  if (ext === 'xls') return parseLegacyOffice(buffer, 'xlsx')
  // txt / md / csv / json / log / code and anything else text-like
  return decodeText(buffer)
}

function decodeText(buffer: Uint8Array): string {
  // UTF-8 with a GBK/GB18030 fallback: Chinese exports of txt/csv/log are
  // often GBK-encoded, and decoding them as UTF-8 silently yields U+FFFD
  // garbage. BOM wins; otherwise a decode with many replacement chars (or a
  // strict-mode failure) falls back to GB18030.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3))
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  // A cheap heuristic: count replacement characters. Real text (CJK or
  // latin) virtually never contains U+FFFD; GBK bytes decode to it in bulk.
  let replacements = 0
  for (let i = 0; i < utf8.length; i += 1) {
    if (utf8.charCodeAt(i) === 0xfffd) {
      replacements += 1
      if (replacements > 8) break
    }
  }
  if (replacements <= 8) return utf8
  try {
    return new TextDecoder('gb18030').decode(buffer)
  } catch {
    return utf8
  }
}

/** Strip an HTML document down to its title and body text. */
export function extractFromHtml(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch !== null ? decodeEntities(titleMatch[1].trim()) : ''
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
  const withoutTags = withBreaks.replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(withoutTags)
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n')
  return { title, text }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', copy: '©', reg: '®', trade: '™',
  middot: '·', bull: '•', times: '×', divide: '÷', deg: '°', plusmn: '±',
}

/** Decode HTML character references: numeric (decimal + hex) and common named entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => codePointFrom(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => codePointFrom(Number(dec)))
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

function codePointFrom(value: number): string {
  // Lone surrogates (0xD800–0xDFFF) must not pass through: String.fromCodePoint
  // accepts them, but the resulting string is not valid text and would be
  // replaced again on any later UTF-8 encode.
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\ufffd'
  return String.fromCodePoint(value)
}

// ── optional parsers ─────────────────────────────────────────────────────────

/**
 * Mean length of the non-empty lines of extracted text. Healthy text layers
 * average well above this (paragraphs of 20–80 chars); per-glyph-laid-out
 * math PDFs and corrupt-encoding layers average below 5 (one glyph per
 * "line"). This heuristic decides whether a text layer is usable as-is,
 * needs coordinate reassembly, or needs OCR instead. Exported for tests.
 */
export function averageLineLength(text: string): number {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  if (lines.length === 0) return 0
  return lines.reduce((sum, line) => sum + line.length, 0) / lines.length
}

/**
 * Extract text with the NEW pdfjs (pdf-parse bundles an old pdf.js whose
 * textContent extraction fragments per-glyph-laid-out math into one "line"
 * per glyph). Items carry their transform matrix, so glyphs are re-clustered
 * into true lines by y (tolerance = median font height × 0.6) and sorted by
 * x within a line — the same line-reassembly Cherry's OCR pipeline applies
 * to detected text boxes.
 */
async function extractTextWithLayout(bytes: Uint8Array): Promise<string> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(input: Record<string, unknown>): {
      promise: Promise<{ numPages: number; getPage(n: number): Promise<unknown> }>
      destroy(): Promise<void>
    }
  }
  // CID-keyed CJK fonts (SimSun/NSimSun/KaiTi…) need pdfjs-dist's cmaps to
  // map glyph ids to characters; without them extraction silently degrades
  // for Chinese PDFs (and pdfjs warns about cMapUrl/cMapPacked).
  let cMapUrl: string | undefined
  try {
    const { createRequire } = await import('node:module')
    const { dirname } = await import('node:path')
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('pdfjs-dist/package.json')
    cMapUrl = `${dirname(pkg).replace(/\\/g, '/')}/cmaps/`
  } catch {
    // cmaps unavailable — extraction still works for non-CID fonts
  }
  const loadingTask = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    ...(cMapUrl !== undefined ? { cMapUrl, cMapPacked: true } : {}),
  })
  try {
    const doc = await loadingTask.promise as { numPages: number; getPage(n: number): Promise<unknown> }
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber) as {
        getTextContent(): Promise<{ items?: Array<{ str?: string; transform?: number[] }> }>
      }
      const content = await page.getTextContent()
      const items = (content.items ?? [])
        .map(item => ({
          str: item.str ?? '',
          x: item.transform?.[4] ?? 0,
          y: item.transform?.[5] ?? 0,
          height: Math.abs(item.transform?.[3] ?? 0) || 10,
        }))
        .filter(item => item.str.length > 0)
      if (items.length === 0) continue
      const heights = items.map(item => item.height).sort((a, b) => a - b)
      const tolerance = (heights[Math.floor(heights.length / 2)] ?? 10) * 0.6
      // Cluster glyphs into y-bands; within a band sort by x and join.
      const bands = new Map<number, Array<{ x: number; str: string }>>()
      for (const item of items) {
        const band = Math.round(item.y / tolerance)
        const list = bands.get(band) ?? []
        list.push({ x: item.x, str: item.str })
        bands.set(band, list)
      }
      const lines = [...bands.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, list]) => list.sort((a, b) => a.x - b.x).map(entry => entry.str).join(''))
        .filter(line => line.trim().length > 0)
      if (lines.length > 0) pages.push(lines.join('\n'))
    }
    return pages.join('\n\n')
  } finally {
    await loadingTask.destroy().catch(() => {})
  }
}

/** OCR fallback shared by the empty-text and corrupt-text-layer paths. */
async function ocrFallback(bytes: Uint8Array): Promise<string> {
  try {
    const { isOcrReady, ocrPdfText } = await import('./ocr.js')
    if (!isOcrReady()) return ''
    return await ocrPdfText(bytes)
  } catch {
    return ''
  }
}

async function parsePdf(buffer: Uint8Array): Promise<string> {
  // Primary engine: pdf-parse (pdf.js). On failure or an empty extraction,
  // fall back to @firecrawl/anydoc (Cherry's AnydocReader fallback posture):
  // anydoc detects the format by content signature and returns structured
  // Markdown, so an unusual/corrupt-ish PDF that pdf.js rejects can still be
  // indexed. Only when both engines fail does the import fail.
  let primaryError: Error | null = null
  let text = ''
  try {
    const pdfParse = await loadPdfParse()
    const result = await pdfParse(Buffer.from(buffer))
    text = typeof result?.text === 'string' ? result.text : ''
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error))
  }
  if (text.trim().length > 0) {
    // A text layer exists — decide whether it is usable:
    // - healthy lines (avg ≥ 5 chars): keep it;
    // - per-glyph math layout: reassemble true lines from glyph coordinates;
    // - corrupt encoding (reassembly still yields junk): render + OCR.
    const avgLine = averageLineLength(text)
    if (avgLine >= 5) return text
    let reassembled = ''
    try {
      reassembled = await extractTextWithLayout(buffer)
    } catch {
      // reassembly unavailable — fall through to OCR
    }
    if (averageLineLength(reassembled) >= 12 && reassembled.trim().length > 0) return reassembled
    const recognized = await ocrFallback(buffer)
    if (recognized.trim().length > 0) return recognized
    // anydoc as the last resort before the fragmented original.
    try {
      const anydoc = await loadAnydoc()
      const markdown = (await anydoc.toMarkdownBytes(Buffer.from(buffer))).trim()
      if (markdown.length > 0) return markdown
    } catch {
      // fallback failed — report the primary engine's error below
    }
    return text
  }
  try {
    const anydoc = await loadAnydoc()
    const markdown = (await anydoc.toMarkdownBytes(Buffer.from(buffer))).trim()
    if (markdown.length > 0) return markdown
  } catch {
    // fallback failed — report the primary engine's error below
  }
  // Last resort for scanned PDFs (Cherry's local-document posture): when the
  // local OCR models are downloaded, recognize the full-page renders. Without
  // the models the original error stands, pointing at the settings panel.
  let ocrReady = false
  try {
    const { isOcrReady, ocrPdfText } = await import('./ocr.js')
    ocrReady = isOcrReady()
    if (ocrReady) {
      const recognized = await ocrPdfText(buffer)
      if (recognized.trim().length > 0) return recognized
    }
  } catch {
    // OCR unavailable — keep the original error
  }
  if (primaryError !== null) {
    throw new Error(`PDF parsing failed: ${primaryError.message}`)
  }
  throw new Error(
    ocrReady
      ? 'PDF contains no extractable text (it may be scanned)'
      : 'PDF contains no extractable text (it may be scanned) — download the local OCR models in Settings → Local Models to auto-recognize scans',
  )
}

async function parseDocx(buffer: Uint8Array): Promise<string> {
  try {
    const mammoth = await loadMammoth()
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) })
    const text = result?.value ?? ''
    if (text.trim().length === 0) throw new Error('DOCX contains no extractable text')
    return text
  } catch (error) {
    throw new Error(`DOCX parsing failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function parseDoc(buffer: Uint8Array): Promise<string> {
  try {
    const WordExtractor = await loadWordExtractor()
    const extractor = new WordExtractor()
    const doc = await extractor.extract(Buffer.from(buffer))
    const text = doc.getBody() ?? ''
    if (text.trim().length === 0) throw new Error('DOC contains no extractable text')
    return text
  } catch (error) {
    throw new Error(`DOC parsing failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Legacy OLE office formats (.ppt / .xls) via @firecrawl/anydoc → Markdown. */
async function parseLegacyOffice(buffer: Uint8Array, format: string): Promise<string> {
  try {
    const anydoc = await loadAnydoc()
    const markdown = await anydoc.toMarkdownBytes(buffer, format)
    const text = markdown.trim()
    if (text.length === 0) throw new Error('document contains no extractable content')
    return text
  } catch (error) {
    throw new Error(`document parsing failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function parsePptx(buffer: Uint8Array): Promise<string> {
  const zip = await loadZip(buffer)
  const slides: string[] = []
  for (const name of Object.keys(zip.files).sort()) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue
    const xml = await zip.files[name].async('string')
    slides.push(stripXmlText(xml, 'a:t'))
  }
  if (slides.length === 0) throw new Error('PPTX contains no extractable slides')
  return slides.join('\n\n')
}

async function parseXlsx(buffer: Uint8Array): Promise<string> {
  const zip = await loadZip(buffer)
  const shared = zip.files['xl/sharedStrings.xml']
  const sharedStrings: string[] = []
  if (shared !== undefined) {
    const xml = await shared.async('string')
    // One entry per <si> — a rich-text shared string with multiple runs
    // (<r><t>…</t></r>×N) must join into ONE string, not N entries, or every
    // later index would be off by the run count.
    for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const inner = si[1] ?? ''
      const text = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeEntities(m[1] ?? '')).join('')
      sharedStrings.push(text)
    }
  }
  const lines: string[] = []
  for (const name of Object.keys(zip.files).sort()) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue
    const xml = await zip.files[name].async('string')
    const rows = xml.split(/<row\b/)
    for (const row of rows) {
      const cells: string[] = []
      for (const cell of row.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)) {
        const tag = cell[0] ?? ''
        const type = /<c\b[^>]*\bt="([^"]*)"/.exec(tag)?.[1]
        const content = cell[1] ?? ''
        const inline = /<is>([\s\S]*?)<\/is>/.exec(content)
        if (inline !== null) {
          const text = [...(inline[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeEntities(m[1] ?? '')).join('')
          cells.push(text)
          continue
        }
        const ref = /<v>([\s\S]*?)<\/v>/.exec(content)
        const raw = ref?.[1] ?? ''
        if (type === 's') {
          // Shared-string reference: the <v> is an INDEX, and only for t="s".
          const sharedIdx = Number(raw)
          if (Number.isInteger(sharedIdx) && sharedIdx >= 0 && sharedIdx < sharedStrings.length) {
            cells.push(sharedStrings[sharedIdx])
          }
        } else if (type === 'b') {
          cells.push(raw === '1' ? '1' : '0')
        } else if (raw.trim().length > 0) {
          // Numbers, dates, formula results etc.: <v> is the literal value.
          cells.push(decodeEntities(raw))
        }
      }
      if (cells.some(cell => cell.trim().length > 0)) lines.push(cells.join('\t'))
    }
  }
  if (lines.length === 0) throw new Error('XLSX contains no extractable cells')
  return lines.join('\n')
}

async function parseEpub(buffer: Uint8Array): Promise<string> {
  const zip = await loadZip(buffer)
  const pages: string[] = []
  for (const name of Object.keys(zip.files).sort()) {
    if (!/\.(xhtml|html|htm)$/.test(name)) continue
    if (/nav|toc|cover/i.test(name)) continue
    const html = await zip.files[name].async('string')
    const text = extractFromHtml(html).text
    if (text.trim().length > 0) pages.push(text)
  }
  if (pages.length === 0) throw new Error('EPUB contains no extractable pages')
  return pages.join('\n\n')
}

/** Extract the text nodes of one XML tag name, in document order. */
function stripXmlText(xml: string, tag: string): string {
  const parts: string[] = []
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g')
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) parts.push(decodeEntities(match[1]))
  }
  return parts.join('')
}

// ── lazy loaders ─────────────────────────────────────────────────────────────

async function loadPdfParse(): Promise<(buffer: Buffer) => Promise<{ text?: string }>> {
  // pdf-parse v1 is CommonJS; the default export is the parser function.
  const mod = await import('pdf-parse')
  return mod.default
}

async function loadMammoth(): Promise<{ extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }> }> {
  const mod = await import('mammoth')
  return (mod.default ?? mod) as { extractRawText(input: { buffer: Buffer }): Promise<{ value?: string }> }
}

async function loadWordExtractor(): Promise<new () => { extract(input: Buffer): Promise<{ getBody(): string }> }> {
  const mod = await import('word-extractor')
  return (mod.default ?? mod) as new () => { extract(input: Buffer): Promise<{ getBody(): string }> }
}

async function loadAnydoc(): Promise<{ toMarkdownBytes(bytes: Uint8Array, format?: string): Promise<string> }> {
  const mod = await import('@firecrawl/anydoc')
  return mod as unknown as { toMarkdownBytes(bytes: Uint8Array, format?: string): Promise<string> }
}

interface ZipHandle {
  files: Record<string, { async(type: 'string'): Promise<string> }>
}

/** Cap on total uncompressed bytes accepted from an office archive (zip-bomb guard). */
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024

async function loadZip(buffer: Uint8Array): Promise<ZipHandle> {
  const mod = await import('jszip')
  const JSZip = (mod.default ?? mod) as new () => { loadAsync(data: Uint8Array): Promise<ZipHandle> }
  let zip: ZipHandle
  try {
    zip = await new JSZip().loadAsync(buffer)
  } catch (error) {
    throw new Error(`archive parsing failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Zip-bomb guard: reject archives whose declared uncompressed size exceeds
  // the cap before any entry is inflated into memory. (JSZip's
  // `_data.uncompressedSize` is internal; the entries' names + `_data` shape
  // is not a public API, so probe via the loader object instead.)
  const total = Object.values(zip.files).reduce((sum, entry) => {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    return sum + (typeof size === 'number' && Number.isFinite(size) ? size : 0)
  }, 0)
  if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
    throw new Error(`archive too large to unpack (${Math.round(total / 1024 / 1024)} MB uncompressed)`)
  }
  return zip
}
