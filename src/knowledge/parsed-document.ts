import { createHash } from 'node:crypto'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import type { Readable } from 'node:stream'
import JSZip from 'jszip'
import type { DocumentProcessor, MineruTier, ParsedAsset, ParsedBlock, ParsedBlockType, ProcessingOutput, ProcessingWarning, SourceBox } from './processing-types.js'
import { checkProcessingAbort, object, ProcessorError } from './processor-transport.js'

export const MINERU_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 128 * 1024 * 1024, expandedBytes: 256 * 1024 * 1024,
  memberBytes: 32 * 1024 * 1024, members: 4096, blocks: 100000,
  textChars: 16 * 1024 * 1024, fieldChars: 1024 * 1024,
})

export function processingHash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }

export function parsedTextDocument(text: string, bytes: Uint8Array, provider: DocumentProcessor, optionsFingerprint: string, warnings: readonly ProcessingWarning[] = []): ProcessingOutput {
  return { document: { schemaVersion: 1, text, sourceHash: processingHash(bytes), provider, optionsFingerprint,
    completeness: 'unknown', blocks: text ? [{ id: 'text:0', index: 0, type: 'text', text, textStart: 0, textEnd: text.length }] : [],
    assets: [], warnings }, assets: [] }
}

/** Reject dangerous names before JSZip can sanitize ../ or collapse duplicates. */
export function validateArtifactPath(path: string): string {
  if (!path || path.length > 512 || /[\\\x00-\x1f\x7f:%?#]/.test(path) || path.startsWith('/') || path.normalize('NFC') !== path) {
    throw new ProcessorError('unsafe_archive', 'MinerU returned an unsafe artifact path.')
  }
  const components = path.endsWith('/') ? path.slice(0, -1).split('/') : path.split('/')
  if (components.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
    throw new ProcessorError('unsafe_archive', 'MinerU returned an unsafe artifact path.')
  }
  return path
}

function inspectArchive(bytes: Uint8Array): void {
  const limits = MINERU_ARCHIVE_LIMITS
  if (bytes.byteLength < 22 || bytes.byteLength > limits.compressedBytes) throw new ProcessorError('invalid_archive', 'MinerU returned an invalid or oversized ZIP.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.byteLength) { end = i; break }
  }
  if (end < 0) throw new ProcessorError('invalid_archive', 'MinerU returned a truncated ZIP.')
  const count = view.getUint16(end + 10, true)
  let position = view.getUint32(end + 16, true)
  const centralEnd = position + view.getUint32(end + 12, true)
  if (count === 65535 || count > limits.members || count < 1 || view.getUint16(end + 4, true) !== 0 ||
      view.getUint16(end + 6, true) !== 0 || view.getUint16(end + 8, true) !== count || centralEnd > end) {
    throw new ProcessorError('invalid_archive', 'Unsupported ZIP layout or too many MinerU artifacts.')
  }
  let expanded = 0
  const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (position + 46 > centralEnd || view.getUint32(position, true) !== 0x02014b50) throw new ProcessorError('invalid_archive', 'Invalid ZIP directory.')
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const commentLength = view.getUint16(position + 32, true)
    const next = position + 46 + nameLength + extraLength + commentLength
    if (next > centralEnd) throw new ProcessorError('invalid_archive', 'Invalid ZIP member.')
    const flags = view.getUint16(position + 8, true)
    const compression = view.getUint16(position + 10, true)
    const size = view.getUint32(position + 24, true)
    const unixType = (view.getUint32(position + 38, true) >>> 16) & 0xf000
    if ((flags & 1) !== 0 || ![0, 8].includes(compression) || unixType === 0xa000 || size > limits.memberBytes) {
      throw new ProcessorError('unsafe_archive', 'Encrypted, linked, oversized, or unsupported ZIP member.')
    }
    let name: string
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(position + 46, position + 46 + nameLength)) }
    catch { throw new ProcessorError('unsafe_archive', 'Artifact paths must be UTF-8.') }
    validateArtifactPath(name)
    if (names.has(name.toLowerCase())) throw new ProcessorError('unsafe_archive', 'Duplicate artifact paths are not allowed.')
    names.add(name.toLowerCase())
    expanded += size
    if (expanded > limits.expandedBytes) throw new ProcessorError('output_too_large', 'MinerU expanded artifacts exceed the safety limit.')
    position = next
  }
  if (position !== centralEnd) throw new ProcessorError('invalid_archive', 'Invalid ZIP directory length.')
}

async function boundedMember(entry: JSZip.JSZipObject, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal) checkProcessingAbort(signal)
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let count = 0
    let finished = false
    const stream = entry.nodeStream('nodebuffer') as Readable
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      if (error) { stream.destroy(); reject(error); return }
      const result = new Uint8Array(count)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
      resolve(result)
    }
    const abort = () => finish(signal?.reason ?? new DOMException('Processing canceled.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    stream.on('data', (chunk: Buffer) => {
      if (finished) return
      count += chunk.length
      if (count > MINERU_ARCHIVE_LIMITS.memberBytes) finish(new ProcessorError('output_too_large', 'Expanded artifact exceeds the safety limit.'))
      else chunks.push(chunk)
    }).on('error', () => finish(new ProcessorError('invalid_archive', 'MinerU artifact decompression failed.')))
      .on('end', () => finish()).resume()
  })
}

function field(value: unknown): string {
  if (typeof value !== 'string' || value.length > MINERU_ARCHIVE_LIMITS.fieldChars) throw new ProcessorError('invalid_response', 'Invalid or oversized structured text field.')
  return value
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', minus: '−', times: '×', divide: '÷', le: '≤', ge: '≥' }
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, name: string) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? all
    const value = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '\ufffd'
  })
}

/** A text projection only: no browser DOM, network fetch, script execution, or HTML output. */
function inertHtmlText(html: string): string {
  return decodeEntities(html.replace(/<!--[^]*?-->/g, '').replace(/<(script|style|iframe)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<eq\b[^>]*>([^]*?)<\/eq\s*>/gi, (_all, equation: string) => `$${equation.replace(/<[^>]*>/g, '')}$`)
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p\s*>/gi, '\n').replace(/<[^>]*>/g, '')).trim()
}

function tableText(html: string): string {
  const rows: string[][] = []
  const pending = new Map<number, { text: string; remaining: number }>()
  const rowPattern = /<tr\b[^>]*>([^]*?)<\/tr\s*>/gi
  for (const row of html.matchAll(rowPattern)) {
    if (rows.length >= 4096) throw new ProcessorError('output_too_large', 'Too many table rows.')
    const cells: string[] = []
    for (const [column, span] of pending) {
      cells[column] = span.text
      span.remaining--
      if (span.remaining <= 0) pending.delete(column)
    }
    let column = 0
    for (const cell of row[1].matchAll(/<(td|th)\b([^>]*)>([^]*?)<\/\1\s*>/gi)) {
      while (cells[column] !== undefined) column++
      const content = inertHtmlText(cell[3]).replace(/\|/g, '\\|').replace(/\r?\n/g, ' / ')
      const spanValue = (name: string) => Math.min(64, Math.max(1, Number(cell[2].match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'))?.[1] ?? 1)))
      const columns = spanValue('colspan')
      const rowSpan = spanValue('rowspan')
      for (let offset = 0; offset < columns; offset++) {
        if (column >= 256) throw new ProcessorError('output_too_large', 'Too many table columns.')
        cells[column] = content
        if (rowSpan > 1) pending.set(column, { text: content, remaining: rowSpan - 1 })
        column++
      }
    }
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return inertHtmlText(html)
  const width = Math.max(...rows.map(row => row.length))
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')
}

function inlineText(value: unknown, depth = 0): string {
  if (depth > 16 || !Array.isArray(value) || value.length > 100000) throw new ProcessorError('invalid_response', 'Invalid inline content.')
  const text = value.map(item => {
    const span = object(item)
    if (span.type === 'hyperlink') return inlineText(span.content, depth + 1)
    const content = field(span.content)
    if (span.type === 'equation_inline') return `$${content}$`
    if (span.type === 'code_inline') return '`' + content + '`'
    if (span.type !== 'text') throw new ProcessorError('unsupported_schema', 'Unsupported MinerU inline content type.')
    return content
  }).join('')
  return field(text)
}

function sourceBox(value: unknown, warn: (code: string, message: string) => void): SourceBox | undefined {
  if (value === undefined || value === null) return undefined
  // docvortex.middle 2.0 BBox is normalized 0..1, NOT pixels/points or 0..1000.
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) || value[0] >= value[2] || value[1] >= value[3]) {
    warn('geometry_unavailable', 'Invalid upstream block geometry was omitted.')
    return undefined
  }
  return { coordinateSpace: 'normalized', x0: value[0], y0: value[1], x1: value[2], y1: value[3] }
}

const leafTypes: Record<string, ParsedBlockType> = {
  text: 'text', ref_text: 'text', doc_title: 'heading', paragraph_title: 'heading',
  header: 'text', footer: 'text', number: 'text', aside_text: 'text', page_footnote: 'text',
  equation: 'equation', image_body: 'image', table_body: 'table', chart_body: 'table',
  code_body: 'code', algorithm_body: 'code', image_caption: 'caption', image_footnote: 'caption',
  table_caption: 'caption', table_footnote: 'caption', chart_caption: 'caption', chart_footnote: 'caption',
  code_caption: 'caption', code_footnote: 'caption', list_item: 'list', index_item: 'list',
}
const groups = new Set(['image', 'table', 'chart', 'code', 'list', 'index'])

export interface NormalizeMineruOptions { tier: MineruTier; processorVersion?: string; partial?: boolean; signal?: AbortSignal }

export async function normalizeMineruArchive(archive: Uint8Array, sourceBytes: Uint8Array, options: NormalizeMineruOptions): Promise<ProcessingOutput> {
  if (options.signal) checkProcessingAbort(options.signal)
  inspectArchive(archive)
  let zip: JSZip
  try { zip = await JSZip.loadAsync(archive) }
  catch { throw new ProcessorError('invalid_archive', 'MinerU returned an unreadable ZIP.') }
  const entries = Object.values(zip.files)
  const manifests = entries.filter(entry => !entry.dir && /(^|\/)middle_json\.json$/.test(entry.name))
  if (manifests.length !== 1) throw new ProcessorError('unsupported_schema', 'MinerU ZIP must contain exactly one middle_json.json.')
  const root = manifests[0].name.slice(0, -'middle_json.json'.length)
  const assetInfo: ParsedAsset[] = []
  const assetBytes: { id: string; bytes: Uint8Array }[] = []
  const assetsByPath = new Map<string, ParsedAsset>()
  let expandedBytes = 0
  let middle: Record<string, unknown> | undefined
  for (const entry of entries) {
    if (options.signal) checkProcessingAbort(options.signal)
    validateArtifactPath(entry.name)
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw new ProcessorError('unsafe_archive', 'ZIP member path was rewritten.')
    if (entry.dir) continue
    const bytes = await boundedMember(entry, options.signal)
    expandedBytes += bytes.byteLength
    if (expandedBytes > MINERU_ARCHIVE_LIMITS.expandedBytes) throw new ProcessorError('output_too_large', 'Expanded ZIP exceeds the safety limit.')
    if (entry.name === manifests[0].name) {
      try { middle = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
      catch { throw new ProcessorError('invalid_response', 'Invalid MinerU MiddleJson artifact.') }
    }
    const relative = entry.name.startsWith(root) ? entry.name.slice(root.length) : ''
    // Images are served as inert bytes by the artifact route, never as active SVG/HTML.
    const mimeTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
    const extension = relative.split('.').at(-1)?.toLowerCase() ?? ''
    if (relative.startsWith('images/') && mimeTypes[extension]) {
      const asset = { id: `asset-${processingHash(relative).slice(0, 24)}`, path: relative, mimeType: mimeTypes[extension], byteLength: bytes.length, sha256: processingHash(bytes) }
      assetInfo.push(asset); assetBytes.push({ id: asset.id, bytes }); assetsByPath.set(relative, asset)
    }
    await yieldTurn()
  }
  if (!middle || middle.schema !== 'docvortex.middle' || middle.schema_version !== '2.0') throw new ProcessorError('unsupported_schema', 'Only docvortex.middle schema 2.0 is supported. Reconfigure or update the MinerU service.')
  if (!Array.isArray(middle.pages) || middle.pages.length > 10000 || typeof middle.is_full_document !== 'boolean') throw new ProcessorError('invalid_response', 'Invalid MiddleJson pages or completeness.')
  const warnings: ProcessingWarning[] = []
  const warn = (code: string, message: string) => { if (!warnings.some(w => w.code === code)) warnings.push({ code, message }) }
  const blocks: ParsedBlock[] = []
  const parts: string[] = []
  const processedPages: number[] = []
  let length = 0
  let heading = ''
  let traversed = 0
  const append = (block: Omit<ParsedBlock, 'index' | 'textStart' | 'textEnd'>) => {
    if (!block.text && !block.assetIds?.length) return
    if (blocks.length >= MINERU_ARCHIVE_LIMITS.blocks) throw new ProcessorError('output_too_large', 'Too many parsed blocks.')
    if (parts.length) length += 2
    const textStart = length
    length += block.text.length
    if (length > MINERU_ARCHIVE_LIMITS.textChars) throw new ProcessorError('output_too_large', 'Parsed text exceeds the safety limit.')
    blocks.push({ ...block, index: blocks.length, textStart, textEnd: length })
    parts.push(block.text)
  }
  const visit = (raw: unknown, pageIndex: number, path: string, parentId?: string, depth = 0) => {
    if (++traversed > MINERU_ARCHIVE_LIMITS.blocks || depth > 16) throw new ProcessorError('output_too_large', 'Structured document is too deep or large.')
    const block = object(raw)
    const type = typeof block.type === 'string' ? block.type : ''
    const id = `p${pageIndex}:${path}`
    if (groups.has(type)) {
      if (!Array.isArray(block.content)) throw new ProcessorError('invalid_response', 'Invalid structured block children.')
      block.content.forEach((child, index) => visit(child, pageIndex, `${path}.${index}`, id, depth + 1))
      return
    }
    const mapped = leafTypes[type] ?? 'unknown'
    if (mapped === 'unknown') warn('unknown_block_type', 'Some upstream block types were retained as plain text.')
    let text = typeof block.content === 'string' ? field(block.content) : inlineText(block.content)
    if (mapped === 'table' || mapped === 'image') text = tableText(text)
    else if (mapped === 'equation' && text.trim()) text = `$$\n${text.trim()}\n$$`
    if (mapped === 'heading') heading = text.trim()
    const references: string[] = []
    if (typeof block.image_path === 'string' && block.image_path) references.push(block.image_path)
    if (typeof block.image_url === 'string' && block.image_url) warn('remote_asset_omitted', 'External image resources were not fetched.')
    if (typeof block.content === 'string') {
      for (const match of block.content.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) references.push(match[1])
    }
    const assetIds: string[] = []
    for (const reference of references) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) { warn('remote_asset_omitted', 'External image resources were not fetched.'); continue }
      validateArtifactPath(reference)
      const asset = assetsByPath.get(reference)
      if (asset) { if (!assetIds.includes(asset.id)) assetIds.push(asset.id) }
      else warn('asset_unavailable', 'An upstream image reference has no supported local asset.')
    }
    if (!text.trim() && assetIds.length) text = mapped === 'equation' ? '[Equation image; text unavailable]' : '[Image; text unavailable]'
    if (!text.trim() && mapped === 'equation') warn('equation_text_unavailable', 'Some equations contain no searchable text.')
    append({ id, type: mapped, text, pageIndex, ...(heading ? { heading } : {}),
      ...(parentId ? { parentId } : {}), ...(assetIds.length ? { assetIds } : {}), bbox: sourceBox(block.bbox, warn) })
  }
  for (const rawPage of middle.pages) {
    if (options.signal) checkProcessingAbort(options.signal)
    const page = object(rawPage)
    if (!Number.isInteger(page.page_idx) || (page.page_idx as number) < 0 || (page.page_idx as number) > 100000 || !Array.isArray(page.blocks)) throw new ProcessorError('invalid_response', 'Invalid structured page.')
    const pageIndex = page.page_idx as number
    if (processedPages.length && pageIndex <= processedPages[processedPages.length - 1]) throw new ProcessorError('invalid_response', 'Structured pages are not in strict source order.')
    processedPages.push(pageIndex)
    for (let i = 0; i < page.blocks.length; i++) {
      visit(page.blocks[i], pageIndex, `b${i}`)
      if (i % 128 === 0) { await yieldTurn(); if (options.signal) checkProcessingAbort(options.signal) }
    }
  }
  const contiguous = processedPages.every((page, index) => page === index)
  const partial = options.partial === true || middle.is_full_document !== true || !contiguous
  if (partial) warn('partial_document', 'The parser did not confirm complete contiguous source coverage.')
  const metadata = middle.metadata == null ? undefined : object(middle.metadata)
  const producer = metadata?.producer == null ? undefined : object(metadata.producer)
  const version = producer && typeof producer.version === 'string' && producer.version.length <= 100 ? producer.version : options.processorVersion
  const result: ProcessingOutput = {
    document: { schemaVersion: 1, text: parts.join('\n\n'), sourceHash: processingHash(sourceBytes), provider: 'mineru-local',
      processorVersion: version, optionsFingerprint: processingHash(JSON.stringify({ schema: 1, tier: options.tier, pageRange: 'all', output: 'zip' })),
      completeness: partial ? 'partial' : 'complete', ...(contiguous && !partial ? { pageCount: processedPages.length } : {}),
      processedPages, blocks, assets: assetInfo, warnings },
    assets: assetBytes, originalResult: archive,
  }
  if (options.signal) checkProcessingAbort(options.signal)
  return result
}
