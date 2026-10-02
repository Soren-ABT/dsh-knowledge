/**
 * Local OCR for scanned PDFs (Cherry's local-document posture). When
 * pdf-parse and anydoc both fail to extract a text layer, the PDF's pages are
 * rendered through MuPDF with a per-page raster budget and PaddleOCR
 * recognizes the full-page raster (216dpi for ordinary-sized pages).
 * Embedded rasters are extracted via pdfjs operator lists when rendering is
 * unavailable. PaddleOCR/Tesseract inference runs in a separate process so a
 * fatal native error cannot take down the host.
 * @module dsh-knowledge/knowledge/ocr
 */

import { deflateSync } from 'node:zlib'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { httpFetch } from './net.js'
import { localModelCacheDir } from './embed.js'
import { OcrProcessClient } from './ocr-process-client.js'
import { ocrError } from './ocr-protocol.js'

/** Cap on OCR work per PDF (Cherry refuses >300 pages; images are capped similarly). */
const MAX_OCR_PAGES = 100
const MAX_OCR_IMAGES = 200
/** One embedded image's pixel cap (~32MP; a single RGBA buffer beyond that is
 *  128MB+ and smells like a forged/corrupt dimension header). */
const MAX_IMAGE_PIXELS = 32_000_000
/** Total RGBA bytes collected per PDF (~512MB of decoded rasters). */
const MAX_TOTAL_RASTER_BYTES = 512 * 1024 * 1024
/** Conservative RGBA budget checked before allocating a mupdf pixmap. */
export const MAX_PAGE_RASTER_BYTES = 64 * 1024 * 1024
const MAX_RASTER_DIMENSION = 8192
/** Overall wall-clock budget for one PDF's OCR pass. Per-page timeouts alone
 *  multiply: 5 minutes × 100 pages is most of a working day for one wedged
 *  import, and the base's ingest queue is occupied for all of it. Reaching the
 *  budget fails the import rather than publishing only the recognized prefix. */
const MAX_OCR_TOTAL_MS = 15 * 60_000

export interface OcrModelStatus {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0–100 aggregate download progress across languages. */
  progress: number
  message: string
}

/** Languages shipped by the OCR card (Cherry's tesseract default: zh + zh-Traditional + en). */
const OCR_LANGUAGES = ['chi_sim', 'chi_tra', 'eng'] as const
type OcrLanguage = (typeof OCR_LANGUAGES)[number]

/**
 * PaddleOCR engine (Cherry's local OCR) — PP-OCRv5 mobile: full Chinese
 * dictionary (18383 entries incl. 15k+ CJK). PP-OCRv6's ONNX repos ship a
 * symbol-only dict (no CJK), so v5 mobile is the practical Chinese-capable
 * choice; det 4.8MB + rec 16.5MB + dict ≈ 21MB total.
 *
 * Files are fetched from a Hugging Face endpoint so users outside China can
 * point the download at huggingface.co via the shared `hfEndpoint` setting
 * (default mirror: hf-mirror.com, the China-friendly HF mirror).
 */
interface OcrModelFile {
  /** Repo-relative path on the Hugging Face endpoint, e.g. `/owner/repo/resolve/main/file`. */
  repoPath: string
  fileName: string
  minBytes: number
}

export const DEFAULT_OCR_MIRROR = 'https://hf-mirror.com'

/** Join a configured HF endpoint with an OCR model's repo path (Cherry model mirror posture). */
export function buildOcrUrl(mirror: string | undefined, repoPath: string): string {
  const base = (mirror === undefined || mirror.trim() === '' ? DEFAULT_OCR_MIRROR : mirror).trim().replace(/\/+$/, '')
  return `${base}${repoPath}`
}

const PPOCR_FILES: readonly OcrModelFile[] = [
  {
    repoPath: '/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx',
    fileName: 'ppocrv5_det.onnx',
    minBytes: 1_000_000,
  },
  {
    repoPath: '/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx',
    fileName: 'ppocrv5_rec.onnx',
    minBytes: 1_000_000,
  },
  {
    repoPath: '/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml',
    fileName: 'ppocrv5_dict.txt',
    minBytes: 10_000,
  },
]

function ocrCacheDir(): string {
  return join(localModelCacheDir(), 'ocr')
}

function ppocrPath(fileName: string): string {
  return join(ocrCacheDir(), fileName)
}

/** Parse a PaddleOCR inference.yml `character_dict` block (list of `- 'x'` / `- x` lines). */
export function parseCharacterDict(yml: string): string[] {
  const lines = yml.split('\n')
  const idx = lines.findIndex(line => line.trim() === 'character_dict:')
  if (idx < 0) return []
  const chars: string[] = []
  for (let i = idx + 1; i < lines.length; i += 1) {
    // Note: no trim() on the value — the CJK full-width space (U+3000) is a
    // legitimate dictionary entry and trim() would strip it.
    const stripped = lines[i].replace(/^\s+/, '')
    if (!stripped.startsWith('- ')) break
    let value = stripped.slice(2)
    // YAML strings may be wrapped in single OR double quotes (`- '中'`,
    // `- "'"` for a literal quote character, or `- "\""`). Strip whichever
    // wrapper actually wraps the value.
    if (value.length >= 2) {
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    }
    chars.push(value)
  }
  return chars
}

// ── status / download management (settings panel) ────────────────────────────

let ocrStatus: OcrModelStatus = { status: 'idle', progress: 0, message: '' }
let ocrDownloadInFlight: Promise<OcrModelStatus> | null = null

export function getOcrModelStatus(): OcrModelStatus {
  return ocrStatus
}

/**
 * Whether the PaddleOCR engine is fully on disk (det + rec weights + parsed
 * dictionary) — the parse fallback gate.
 */
export function isOcrReady(): boolean {
  return PPOCR_FILES.every(file => existsSync(ppocrPath(file.fileName)))
}

function setOcrStatus(status: OcrModelStatus): void {
  ocrStatus = status
}

/**
 * Download the PaddleOCR engine files with aggregate progress; idempotent per
 * file and coalesced (concurrent callers share one in-flight download —
 * Cherry's LocalModelDownloadService.inFlight). The dictionary is parsed out
 * of the recognition model's inference.yml (Cherry's dictTextFromInferenceYml).
 *
 * @param mirror - optional HF endpoint override (the `hfEndpoint` setting);
 *   defaults to the China-friendly hf-mirror.com.
 */
export async function downloadOcrModels(mirror?: string): Promise<OcrModelStatus> {
  if (ocrDownloadInFlight !== null) return ocrDownloadInFlight
  const run = (async () => {
    await mkdir(ocrCacheDir(), { recursive: true })
    const missing = PPOCR_FILES.filter(file => !existsSync(ppocrPath(file.fileName)))
    if (missing.length === 0) {
      setOcrStatus({ status: 'ready', progress: 100, message: '' })
      return getOcrModelStatus()
    }
    setOcrStatus({ status: 'downloading', progress: 0, message: '' })
    let done = 0
    try {
      for (const file of missing) {
        await downloadModelFile(file, buildOcrUrl(mirror, file.repoPath), (fraction) => {
          setOcrStatus({
            status: 'downloading',
            progress: Math.round(((done + fraction) / PPOCR_FILES.length) * 100),
            message: '',
          })
        })
        done += 1
      }
      setOcrStatus({ status: 'ready', progress: 100, message: '' })
    } catch (error) {
      setOcrStatus({
        status: 'error',
        progress: Math.round((done / PPOCR_FILES.length) * 100),
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return getOcrModelStatus()
  })()
  ocrDownloadInFlight = run.finally(() => { ocrDownloadInFlight = null })
  return ocrDownloadInFlight
}

/**
 * Remove the OCR cache. The child process exits first so a Windows file lock
 * cannot block the unlink (Cherry terminates its OCR worker before deleting
 * weights for the same reason).
 */
export async function removeOcrModels(): Promise<void> {
  await disposeOcrWorker()
  setOcrStatus({ status: 'idle', progress: 0, message: '' })
  await rm(ocrCacheDir(), { recursive: true, force: true })
}

/**
 * Download one engine file atomically (tmp + rename, Cherry's fetchToFile
 * posture). The dictionary entry (inference.yml) is parsed into its text file.
 */
async function downloadModelFile(file: OcrModelFile, url: string, onProgress: (fraction: number) => void): Promise<void> {
  const response = await httpFetch(url, { timeoutMs: 240000 })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length < file.minBytes) {
    throw new Error(`${url} too small (${bytes.length} bytes) — mirror error page?`)
  }
  const dest = ppocrPath(file.fileName)
  if (file.fileName.endsWith('.txt')) {
    // Dictionary: the downloaded bytes are the recognition model's
    // inference.yml — parse the character_dict block out of it.
    const chars = parseCharacterDict(new TextDecoder('utf-8').decode(bytes))
    if (chars.length < 1000 || !chars.some(ch => /[\u4e00-\u9fff]/.test(ch))) {
      throw new Error(`character_dict in inference.yml looks incomplete (${chars.length} entries, no CJK)`)
    }
    // Leading blank line = CTC blank token (Cherry's dictionary format).
    await writeFile(`${dest}.tmp`, `\n${chars.join('\n')}\n`)
  } else {
    await writeFile(`${dest}.tmp`, Buffer.from(bytes))
  }
  await rename(`${dest}.tmp`, dest)
  onProgress(1)
}

// ── recognition pipeline ─────────────────────────────────────────────────────

interface PdfImage {
  width: number
  height: number
  /** RGBA pixel data (normalized from whatever pdfjs decoded). */
  data: Uint8ClampedArray
}

const ocrProcess = new OcrProcessClient()

/** Resolve pdfjs-dist's wasm directory (image decoders) for fake-worker mode. */
const pdfjsWasmUrl: string | undefined = (() => {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('pdfjs-dist/package.json')
    return `${dirname(pkg).replace(/\\/g, '/')}/wasm/`
  } catch {
    return undefined
  }
})()

/** pdfjs-dist's cmaps directory: CID-keyed CJK fonts (SimSun/NSimSun/KaiTi…)
 *  map glyph ids to characters through these — without it pdfjs warns
 *  'cMapUrl/cMapPacked missing' and CJK text extraction silently degrades. */
const pdfjsCMapUrl: string | undefined = (() => {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('pdfjs-dist/package.json')
    return `${dirname(pkg).replace(/\\/g, '/')}/cmaps/`
  } catch {
    return undefined
  }
})()

/**
 * Page renderer — mupdf (Artifex' WASM build). pdfjs's CanvasGraphics
 * rendering onto @napi-rs/canvas crashes the process (native incompatibility
 * with the 2d context), so page rendering uses mupdf instead: pure WASM, no
 * native code, renders vector-only pages (subsetted-font PDFs) just as well
 * as scanned rasters. pdfjs remains only for embedded-raster extraction
 * (the no-renderer fallback).
 */
interface MupdfPixmap { asPNG(): Uint8Array; destroy(): void }
interface MupdfPage {
  getBounds(): number[]
  toPixmap(matrix: unknown, colorspace: unknown, alpha: boolean): MupdfPixmap
  destroy(): void
}
interface MupdfModule {
  Document: {
    openDocument(data: Uint8Array, magic: string): {
      countPages(): number
      loadPage(index: number): MupdfPage
      destroy(): void
    }
  }
  Matrix: { scale(x: number, y: number): unknown }
  ColorSpace: { DeviceRGB: unknown }
}

/** Small PDF pages retain 216dpi; large pixel-sized scans stay at 1x when safe. */
export function ocrRenderScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw ocrError('ocr_incomplete', 'OCR page dimensions are invalid')
  }
  const area = width * height
  if (!Number.isFinite(area) || area <= 0) throw ocrError('ocr_incomplete', 'OCR page dimensions are out of range')
  const preferred = area * 9 * 4 <= MAX_PAGE_RASTER_BYTES ? 3 : 1
  return Math.min(preferred, Math.sqrt(MAX_PAGE_RASTER_BYTES / (4 * area)) * 0.999,
    MAX_RASTER_DIMENSION / width, MAX_RASTER_DIMENSION / height)
}

let mupdfModule: MupdfModule | null | undefined
async function loadMupdf(): Promise<MupdfModule | null> {
  if (mupdfModule !== undefined) return mupdfModule
  try {
    mupdfModule = (await import('mupdf')) as unknown as MupdfModule
  } catch {
    mupdfModule = null
  }
  return mupdfModule
}

/**
 * Render every page of a PDF to a full-page PNG (Cherry's pdfPageOcr: scanned
 * pages and vector-only pages both end up as one image per page, so OCR sees
 * the complete layout instead of isolated embedded fragments). Returns null
 * when the renderer is unavailable — the caller falls back to embedded-raster
 * extraction. Exported for tests.
 */
export async function renderPdfPages(bytes: Uint8Array, maxPages: number): Promise<Array<{ page: number; png: Buffer }> | null> {
  const mupdf = await loadMupdf()
  if (mupdf === null) return null
  let document: ReturnType<MupdfModule['Document']['openDocument']> | null = null
  try {
    document = mupdf.Document.openDocument(Uint8Array.from(bytes), 'application/pdf')
    const out: Array<{ page: number; png: Buffer }> = []
    const pageCount = document.countPages()
    if (pageCount > maxPages) throw ocrError('ocr_incomplete', `OCR page limit exceeded (${pageCount} pages, limit ${maxPages}); split the PDF or use MinerU`)
    let totalBytes = 0
    for (let index = 0; index < pageCount; index += 1) {
      // NO yield here, deliberately. mupdf's render is synchronous WASM and this
      // runs in the host process, so a long document does block the event loop —
      // but yielding between pages was measured to CRASH the process: with a
      // `setImmediate` yield, 2 of 6 runs of tests/ocr.spec.ts died with an
      // access violation (0xC0000005); with the yield removed, 6 of 6 passed,
      // twice. Correcting the stall means moving the render into the OCR worker
      // thread (where mupdf state is per-thread), not interleaving it here; that
      // is recorded as a deferred item. The byte budget below at least bounds
      // how much work one pass can do.
      let page: MupdfPage | null = null
      try {
        page = document.loadPage(index)
        const bounds = page.getBounds()
        let scale = ocrRenderScale(bounds[2] - bounds[0], bounds[3] - bounds[1])
        let png: Buffer | undefined
        for (let attempt = 0; attempt < 4; attempt += 1) {
          let pixmap: MupdfPixmap | undefined
          try {
            pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
            png = Buffer.from(pixmap.asPNG())
            break
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (attempt === 3 || !/malloc|memory|allocat/i.test(message)) throw error
            scale /= 2
            console.warn(`[dsh-knowledge] page ${index + 1} raster allocation failed; retrying at ${scale}x`)
          } finally {
            // page.destroy() does not release its pixmap. Keep only the copied
            // PNG and free the large WASM raster before rendering another page.
            pixmap?.destroy()
          }
        }
        if (png === undefined || png.length === 0) throw new Error('empty page raster')
        if (totalBytes + png.length > MAX_TOTAL_RASTER_BYTES) {
          throw new Error(`raster byte budget exceeded after ${out.length}/${pageCount} pages; split the PDF or use MinerU`)
        }
        out.push({ page: index + 1, png })
        totalBytes += png.length
      } catch (error) {
        throw ocrError('ocr_incomplete', `OCR page ${index + 1}/${pageCount} render failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        // Always release the page back to the WASM heap, even when rendering
        // threw (a malformed page would otherwise accumulate until the
        // document is destroyed, inflating WASM memory).
        page?.destroy()
      }
    }
    return out
  } catch (error) {
    // Once a renderer opened the PDF, a missing page must fail the import.
    // Only an unavailable renderer/document-open failure may use extraction.
    if (document !== null) throw error
    console.warn(`[dsh-knowledge] mupdf render failed, falling back to embedded rasters: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    document?.destroy()
  }
}

/** Legacy function name retained for callers; waits for the OCR child to exit. */
export async function disposeOcrWorker(): Promise<void> {
  await ocrProcess.dispose()
}

/**
 * Extract every embedded raster on each PDF page via pdfjs (no canvas
 * rendering — scanned pages are embedded images), normalize to RGBA.
 * Exported for tests (the decoded shape drives normalizeRgba's branches).
 */
export async function extractPdfImages(bytes: Uint8Array): Promise<Array<PdfImage & { page: number }>> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument(input: Record<string, unknown>): {
      promise: Promise<{ numPages: number; getPage(n: number): Promise<unknown> }>
      destroy(): Promise<void>
    }
    OPS: { paintImageXObject: number }
  }
  const loadingTask = pdfjs.getDocument({
    // pdfjs 6 rejects Buffer-typed input — always hand it a plain Uint8Array.
    data: Uint8Array.from(bytes),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    // Fake-worker mode cannot derive the image-decoder wasm path by itself on
    // some hosts — point it at pdfjs-dist/wasm explicitly (trailing slash).
    ...(pdfjsWasmUrl !== undefined ? { wasmUrl: pdfjsWasmUrl } : {}),
    // CID-font cmaps for CJK PDFs (SimSun etc.) — see pdfjsCMapUrl above.
    ...(pdfjsCMapUrl !== undefined ? { cMapUrl: pdfjsCMapUrl, cMapPacked: true } : {}),
  })
  try {
    const doc = await loadingTask.promise as { numPages: number; getPage(n: number): Promise<unknown> }
    const out: Array<PdfImage & { page: number }> = []
    if (doc.numPages > MAX_OCR_PAGES) throw ocrError('ocr_incomplete', `OCR page limit exceeded (${doc.numPages} pages); split the PDF or use MinerU`)
    const pageCount = doc.numPages
    let totalRasterBytes = 0
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber) as {
        getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
        objs: {
          has(name: string): boolean
          get(name: string): { width: number; height: number; data: Uint8ClampedArray | Uint8Array } | null
        }
      }
      const ops = await page.getOperatorList()
      for (let i = 0; i < ops.fnArray.length; i += 1) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue
        if (out.length >= MAX_OCR_IMAGES) throw ocrError('ocr_incomplete', `OCR image limit exceeded at page ${pageNumber}; split the PDF or use MinerU`)
        const name = ops.argsArray[i][0] as string
        // pdfjs decodes images asynchronously; objs.get() throws until the
        // decode lands. Poll has() with a timeout; a failed decode (e.g.
        // unsupported codec) fails the import rather than losing that image.
        const image = await waitForImage(page, name, 5000)
        if (image === null || image.width <= 0 || image.height <= 0 || !image.data) {
          throw ocrError('ocr_incomplete', `OCR image decoding failed at page ${pageNumber}`)
        }
        // Memory guard: a single forged/oversized dimension header must not
        // allocate a huge RGBA buffer (RangeError) or OOM the process, and
        // the cumulative raster bytes stay bounded across the whole PDF.
        const pixels = image.width * image.height
        if (pixels > MAX_IMAGE_PIXELS) throw ocrError('ocr_incomplete', `OCR image at page ${pageNumber} exceeds the pixel budget`)
        const bytes = pixels * 4
        if (totalRasterBytes + bytes > MAX_TOTAL_RASTER_BYTES) throw ocrError('ocr_incomplete', `OCR raster budget exceeded at page ${pageNumber}; split the PDF or use MinerU`)
        totalRasterBytes += bytes
        out.push({ width: image.width, height: image.height, data: normalizeRgba(image), page: pageNumber })
      }
    }
    return out
  } finally {
    await loadingTask.destroy().catch(() => {})
  }
}

/** Wait for a pdfjs image object to finish decoding (has() poll + timeout). */
async function waitForImage(
  page: { objs: { has(name: string): boolean; get(name: string): { width: number; height: number; data: Uint8ClampedArray | Uint8Array } | null } },
  name: string,
  timeoutMs: number,
): Promise<{ width: number; height: number; data: Uint8ClampedArray | Uint8Array } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.objs.has(name)) {
      const resolved = page.objs.get(name)
      if (resolved !== null) return resolved
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return null
}

/** Normalize pdfjs-decoded pixel data (RGBA / RGB / single-channel gray / 1-bit) to RGBA. */
export function normalizeRgba(image: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): Uint8ClampedArray {
  const { width, height, data } = image
  const expected = width * height
  // Defense in depth: a forged dimension header must not allocate an
  // unbounded buffer here (extractPdfImages already filters, but this
  // function is exported and stands alone).
  if (expected <= 0 || expected > MAX_IMAGE_PIXELS || expected * 4 > 0xffffffff) {
    throw new Error(`image dimensions out of range: ${width}×${height}`)
  }
  if (data.length >= expected * 4) {
    // pdfjs decodes to RGBA; ensure the alpha channel is opaque (it usually is).
    const rgba = new Uint8ClampedArray(expected * 4)
    rgba.set(data.subarray(0, expected * 4))
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
    return rgba
  }
  if (data.length >= expected * 3) {
    // 8-bit RGB (pdfjs also decodes 8-bit grayscale as 3 channels).
    const rgba = new Uint8ClampedArray(expected * 4)
    for (let i = 0; i < expected; i += 1) {
      rgba[i * 4] = data[i * 3]
      rgba[i * 4 + 1] = data[i * 3 + 1]
      rgba[i * 4 + 2] = data[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
    return rgba
  }
  if (data.length >= expected) {
    // Single-channel 8-bit grayscale — one byte per pixel.
    const rgba = new Uint8ClampedArray(expected * 4)
    for (let i = 0; i < expected; i += 1) {
      const v = data[i] ?? 0
      rgba[i * 4] = v
      rgba[i * 4 + 1] = v
      rgba[i * 4 + 2] = v
      rgba[i * 4 + 3] = 255
    }
    return rgba
  }
  // 1-bit bitmap (JBIG2/CCITT fax scans): pdfjs hands back bit-packed rows,
  // MSB first, ~expected/8 bytes. Every byte carries 8 pixels — treating it
  // as grayscale would shred the image and OCR would see noise.
  const rgba = new Uint8ClampedArray(expected * 4)
  for (let i = 0; i < expected; i += 1) {
    const bit = (data[i >> 3] >> (7 - (i & 7))) & 1
    const v = bit === 1 ? 255 : 0
    rgba[i * 4] = v
    rgba[i * 4 + 1] = v
    rgba[i * 4 + 2] = v
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

/** Encode RGBA pixels as PNG using only node:zlib (no canvas/native deps). */
export function rgbaToPng(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const rowBytes = 1 + width * 4
  const raw = Buffer.alloc(height * rowBytes)
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * rowBytes + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

let crcTable: Uint32Array | null = null

function crc32(buffer: Buffer): number {
  crcTable ??= (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
    return table
  })()
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * OCR a scanned PDF. The preferred path renders every page to a full-page
 * raster via mupdf (Cherry's pdfPageOcr) so vector-only pages — e.g. PDFs
 * whose body is drawn with subsetted fonts instead of embedded bitmaps — are
 * recognized as complete pages rather than as isolated character fragments.
 * Without a renderer it falls back to extracting embedded rasters via pdfjs
 * operator lists.
 *
 * Returns '' when the OCR models are not downloaded (the caller keeps its
 * "download the models" hint) or when the pages simply contained no text.
 * THROWS on a missing page, an engine failure, or a work-budget limit. Partial
 * text is never returned as a successful import (issues #17 and #37).
 */
export async function ocrPdfText(bytes: Uint8Array): Promise<string> {
  if (!isOcrReady()) return ''
  const deadline = Date.now() + MAX_OCR_TOTAL_MS
  const pageTexts = new Map<number, string[]>()
  try {
    const rendered = await renderPdfPages(bytes, MAX_OCR_PAGES)
    const recognize = async (page: number, png: Buffer): Promise<void> => {
      try {
        const text = postprocessOcrText(await ocrProcess.recognize(png, ocrCacheDir()))
        if (text.length > 0) {
          const bucket = pageTexts.get(page) ?? []
          bucket.push(text)
          pageTexts.set(page, bucket)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw ocrError((error as { code?: string }).code ?? 'ocr_failed', `OCR failed for page ${page}: ${message}`)
      }
    }
    if (rendered !== null) {
      // Full-page renders: one PNG per page, straight into the recognizer
      // (mupdf output needs no grayscale/normalize chain).
      for (const { page, png } of rendered) {
        if (Date.now() >= deadline) {
          throw ocrError('ocr_incomplete', `OCR time budget reached after ${pageTexts.size}/${rendered.length} pages; split the PDF or use MinerU`)
        }
        await recognize(page, png)
      }
    } else {
      // No renderer — fall back to the embedded-raster extraction path.
      const images = await extractPdfImages(bytes)
      for (const image of images) {
        if (Date.now() >= deadline) {
          throw ocrError('ocr_incomplete', `OCR time budget reached after ${pageTexts.size} pages; split the PDF or use MinerU`)
        }
        // Cherry preprocesses OCR input (grayscale → normalize → sharpen, via
        // sharp); here the same chain runs in pure JS. Low-resolution rasters
        // are upscaled 2x first (Cherry renders PDF pages at ~216dpi instead).
        const { width, height, data } = prepareForOcr(image.width, image.height, image.data)
        const png = rgbaToPng(width, height, data)
        await recognize(image.page, png)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[dsh-knowledge] OCR failed for scanned PDF: ${message}`)
    throw ocrError((error as { code?: string }).code ?? 'ocr_incomplete', `OCR could not process this document completely: ${message}`)
  }
  return [...pageTexts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, texts]) => texts.join('\n'))
    .join('\n\n')
}

/** Nearest-neighbour 2x upscale for low-resolution rasters (pure JS). */
function upscale2x(width: number, height: number, rgba: Uint8ClampedArray): { width: number; height: number; data: Uint8ClampedArray } {
  const out = new Uint8ClampedArray(width * height * 4 * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4
      const r = rgba[src], g = rgba[src + 1], b = rgba[src + 2], a = rgba[src + 3]
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const dst = ((y * 2 + dy) * width * 2 + (x * 2 + dx)) * 4
          out[dst] = r; out[dst + 1] = g; out[dst + 2] = b; out[dst + 3] = a
        }
      }
    }
  }
  return { width: width * 2, height: height * 2, data: out }
}

/**
 * Cherry's OCR input chain (sharp grayscale → normalize → sharpen) in pure JS:
 * grayscale, min-max contrast stretch, then a 3x3 unsharp kernel. Small
 * rasters are upscaled 2x before the chain so thin strokes survive.
 */
export function prepareForOcr(width: number, height: number, rgba: Uint8ClampedArray): { width: number; height: number; data: Uint8ClampedArray } {
  let w = width, h = height, data = rgba
  if (w < 1200 && h < 800) {
    const up = upscale2x(w, h, data)
    w = up.width; h = up.height; data = up.data
  }
  const gray = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i += 1) {
    // Perceptual luma (Rec. 601), same weights sharp uses for grayscale().
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2])
  }
  // normalize(): min-max stretch to the full 0-255 range.
  let min = 255, max = 0
  for (let i = 0; i < gray.length; i += 1) {
    if (gray[i] < min) min = gray[i]
    if (gray[i] > max) max = gray[i]
  }
  const range = max - min
  const stretched = new Uint8ClampedArray(w * h)
  if (range > 0) {
    for (let i = 0; i < gray.length; i += 1) {
      stretched[i] = Math.round(((gray[i] - min) / range) * 255)
    }
  } else {
    stretched.set(gray)
  }
  // sharpen(): unsharp kernel on the stretched gray.
  const sharpened = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const px = Math.min(w - 1, Math.max(0, x + kx))
          const py = Math.min(h - 1, Math.max(0, y + ky))
          sum += stretched[py * w + px] * SHARPEN_KERNEL[(ky + 1) * 3 + (kx + 1)]
        }
      }
      sharpened[y * w + x] = Math.min(255, Math.max(0, sum))
    }
  }
  const out = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i += 1) {
    const v = sharpened[i]
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255
  }
  return { width: w, height: h, data: out }
}

/** 3x3 unsharp kernel (sums to 1, mild edge boost). */
const SHARPEN_KERNEL = [
  0, -0.4, 0,
  -0.4, 2.6, -0.4,
  0, -0.4, 0,
]

/**
 * Tesseract separates CJK glyphs with spaces ("中 文 测 试"); collapse spaces
 * between CJK characters so the indexed text matches natural search queries.
 * Only HORIZONTAL whitespace is folded: newlines separate OCR lines and must
 * survive (a CJK line ending next to a CJK line starting would otherwise be
 * glued into one line, destroying paragraph structure).
 */
export function postprocessOcrText(text: string): string {
  return text.replace(/([\u4e00-\u9fff\u3400-\u4dbf])[ \t\u3000\u00a0]+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
}

/** List engine files currently on disk (settings panel detail). */
export async function listOcrLanguages(): Promise<Array<{ lang: string; ready: boolean }>> {
  let files: string[] = []
  try {
    files = await readdir(ocrCacheDir())
  } catch {
    // no cache yet
  }
  const onDisk = new Set(files)
  return PPOCR_FILES.map(file => ({ lang: file.fileName, ready: onDisk.has(file.fileName) }))
}
