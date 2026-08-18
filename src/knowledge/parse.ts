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
  return new TextDecoder('utf-8').decode(buffer)
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
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return '\ufffd'
  return String.fromCodePoint(value)
}

// ── optional parsers ─────────────────────────────────────────────────────────

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
  if (text.trim().length > 0) return text
  try {
    const anydoc = await loadAnydoc()
    const markdown = (await anydoc.toMarkdownBytes(Buffer.from(buffer))).trim()
    if (markdown.length > 0) return markdown
  } catch {
    // fallback failed — report the primary engine's error below
  }
  // Last resort for scanned PDFs (Cherry's local-document posture): when the
  // local OCR models are downloaded, extract the embedded page rasters and
  // recognize them. Without the models the original error stands, pointing at
  // the settings panel.
  try {
    const { isOcrReady, ocrPdfText } = await import('./ocr.js')
    if (isOcrReady()) {
      const recognized = await ocrPdfText(buffer)
      if (recognized.trim().length > 0) return recognized
    }
  } catch {
    // OCR unavailable — keep the original error
  }
  if (primaryError !== null) {
    throw new Error(`PDF parsing failed: ${primaryError.message}`)
  }
  throw new Error('PDF contains no extractable text (it may be scanned)')
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
    for (const match of xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) sharedStrings.push(decodeEntities(match[1] ?? ''))
  }
  const lines: string[] = []
  for (const name of Object.keys(zip.files).sort()) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue
    const xml = await zip.files[name].async('string')
    const rows = xml.split(/<row\b/)
    for (const row of rows) {
      const cells: string[] = []
      for (const cell of row.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)) {
        const content = cell[1] ?? ''
        const inline = /<is>([\s\S]*?)<\/is>/.exec(content)
        if (inline !== null) {
          const text = [...(inline[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decodeEntities(m[1] ?? '')).join('')
          cells.push(text)
          continue
        }
        const ref = /<v>([\s\S]*?)<\/v>/.exec(content)
        const sharedIdx = ref !== null ? Number(ref[1]) : NaN
        if (Number.isInteger(sharedIdx) && sharedIdx >= 0 && sharedIdx < sharedStrings.length) {
          cells.push(sharedStrings[sharedIdx])
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
