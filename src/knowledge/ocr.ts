/**
 * Local OCR for scanned PDFs (Cherry's local-document posture, adapted to
 * pure-JS dependencies). When pdf-parse and anydoc both fail to extract a
 * text layer, the PDF's pages are typically embedded rasters — pdfjs extracts
 * those images without rendering, they are PNG-encoded (node:zlib, no canvas
 * dependency), and Tesseract.js (WASM, its own worker thread) recognizes the
 * text. Traineddata downloads through our proxied fetch from mirror sources
 * into `<localModelCacheDir>/ocr/`.
 * @module dsh-knowledge/knowledge/ocr
 */

import { gunzipSync, deflateSync } from 'node:zlib'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { httpFetch } from './net.js'
import { localModelCacheDir } from './embed.js'

/** Cap on OCR work per PDF (Cherry refuses >300 pages; images are capped similarly). */
const MAX_OCR_PAGES = 100
const MAX_OCR_IMAGES = 200

export interface OcrModelStatus {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0–100 aggregate download progress across languages. */
  progress: number
  message: string
}

/** Languages shipped by the OCR card (Chinese-first; English for mixed docs). */
const OCR_LANGUAGES = ['chi_sim', 'eng'] as const
type OcrLanguage = (typeof OCR_LANGUAGES)[number]

/** Mirror order: jsdelivr npm mirror (reachable in CN), official tessdata, backstop. */
const LANG_SOURCES: ReadonlyArray<(lang: OcrLanguage) => string> = [
  lang => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
  lang => `https://tessdata.projectnaptha.com/4.0.0/${lang}.traineddata.gz`,
]

function ocrCacheDir(): string {
  return join(localModelCacheDir(), 'ocr')
}

function traineddataPath(lang: OcrLanguage): string {
  return join(ocrCacheDir(), `${lang}.traineddata`)
}

// ── status / download management (settings panel) ────────────────────────────

let ocrStatus: OcrModelStatus = { status: 'idle', progress: 0, message: '' }

export function getOcrModelStatus(): OcrModelStatus {
  return ocrStatus
}

/** Whether every shipped OCR language is on disk (the parse fallback gate). */
export function isOcrReady(): boolean {
  return OCR_LANGUAGES.every(lang => existsSync(traineddataPath(lang)))
}

function setOcrStatus(status: OcrModelStatus): void {
  ocrStatus = status
}

/** Download all OCR languages with aggregate progress; idempotent per file. */
export async function downloadOcrModels(): Promise<OcrModelStatus> {
  await mkdir(ocrCacheDir(), { recursive: true })
  const missing = OCR_LANGUAGES.filter(lang => !existsSync(traineddataPath(lang)))
  if (missing.length === 0) {
    setOcrStatus({ status: 'ready', progress: 100, message: '' })
    return getOcrModelStatus()
  }
  setOcrStatus({ status: 'downloading', progress: 0, message: '' })
  let done = 0
  try {
    for (const lang of missing) {
      await downloadLanguage(lang, (fraction) => {
        setOcrStatus({
          status: 'downloading',
          progress: Math.round(((done + fraction) / OCR_LANGUAGES.length) * 100),
          message: '',
        })
      })
      done += 1
    }
    setOcrStatus({ status: 'ready', progress: 100, message: '' })
  } catch (error) {
    setOcrStatus({
      status: 'error',
      progress: Math.round((done / OCR_LANGUAGES.length) * 100),
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  return getOcrModelStatus()
}

/** Remove the OCR cache (worker releases the WASM heap on next use anyway). */
export async function removeOcrModels(): Promise<void> {
  setOcrStatus({ status: 'idle', progress: 0, message: '' })
  await rm(ocrCacheDir(), { recursive: true, force: true })
}

/** Download one language's traineddata.gz through the mirror chain and gunzip it. */
async function downloadLanguage(lang: OcrLanguage, onProgress: (fraction: number) => void): Promise<void> {
  let lastError: unknown
  for (const buildUrl of LANG_SOURCES) {
    try {
      const url = buildUrl(lang)
      const response = await httpFetch(url, { timeoutMs: 120000 })
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
      const gz = new Uint8Array(await response.arrayBuffer())
      // A mirror error page / LFS pointer is tiny — reject on size before inflating.
      if (gz.length < 100_000) throw new Error(`traineddata from ${url} too small (${gz.length} bytes)`)
      const data = gunzipSync(gz)
      await writeFile(traineddataPath(lang), data)
      // Tesseract.js looks for `<lang>.traineddata.gz` under langPath first —
      // keep the compressed copy alongside the inflated one.
      await writeFile(`${traineddataPath(lang)}.gz`, gz)
      onProgress(1)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to download OCR language ${lang}`)
}

// ── recognition pipeline ─────────────────────────────────────────────────────

interface PdfImage {
  width: number
  height: number
  /** RGBA pixel data (normalized from whatever pdfjs decoded). */
  data: Uint8ClampedArray
}

// ── OCR worker client ────────────────────────────────────────────────────────
// Tesseract.js runs inside a dedicated worker thread: its errors are rethrown
// on process.nextTick and would kill the host process otherwise. A worker
// crash surfaces as an 'error' event here — in-flight requests fail, the next
// call respawns (Cherry's own-worker OCR posture).

const OCR_WORKER_REQUEST_TIMEOUT_MS = 5 * 60_000

let ocrWorker: Worker | null = null
let ocrRequestSeq = 0
const ocrPending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>()

function ocrWorkerPath(): string {
  return fileURLToPath(new URL('./ocr-worker.mjs', import.meta.url))
}

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

function failAllOcrPending(error: Error): void {
  for (const { reject } of ocrPending.values()) reject(error)
  ocrPending.clear()
}

function ensureOcrWorker(): Worker {
  if (ocrWorker !== null) return ocrWorker
  const worker = new Worker(ocrWorkerPath())
  worker.unref()
  worker.on('message', (message: { id?: number; ok?: boolean; text?: string; error?: string }): void => {
    if (message.id === undefined) return
    const pending = ocrPending.get(message.id)
    if (pending === undefined) return
    ocrPending.delete(message.id)
    if (message.ok === true) pending.resolve(message.text ?? '')
    else pending.reject(new Error(message.error ?? 'OCR worker failed'))
  })
  const onFailure = (error: Error): void => {
    if (ocrWorker !== worker) return
    failAllOcrPending(error)
    ocrWorker = null
  }
  worker.on('error', (error) => onFailure(error instanceof Error ? error : new Error(String(error))))
  worker.on('exit', () => onFailure(new Error('OCR worker exited')))
  ocrWorker = worker
  return worker
}

function recognizePng(png: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++ocrRequestSeq
    const timer = setTimeout(() => {
      ocrPending.delete(id)
      reject(new Error('OCR request timed out'))
    }, OCR_WORKER_REQUEST_TIMEOUT_MS)
    timer.unref?.()
    ocrPending.set(id, {
      resolve: (text) => { clearTimeout(timer); resolve(text) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    ensureOcrWorker().postMessage({ id, type: 'ocr', png, langPath: ocrCacheDir() })
  })
}

/** Release the worker (plugin teardown). Idempotent. */
export function disposeOcrWorker(): void {
  const worker = ocrWorker
  ocrWorker = null
  failAllOcrPending(new Error('OCR worker disposed'))
  if (worker !== null) {
    try {
      worker.postMessage({ type: 'shutdown' })
    } catch {
      // already dead
    }
    void worker.terminate()
  }
}

/**
 * Extract every embedded raster on each PDF page via pdfjs (no canvas
 * rendering — scanned pages are embedded images), normalize to RGBA.
 */
async function extractPdfImages(bytes: Uint8Array): Promise<Array<PdfImage & { page: number }>> {
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
  })
  try {
    const doc = await loadingTask.promise as { numPages: number; getPage(n: number): Promise<unknown> }
    const out: Array<PdfImage & { page: number }> = []
    const pageCount = Math.min(doc.numPages, MAX_OCR_PAGES)
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber) as {
        getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
        objs: {
          has(name: string): boolean
          get(name: string): { width: number; height: number; data: Uint8ClampedArray | Uint8Array } | null
        }
      }
      const ops = await page.getOperatorList()
      for (let i = 0; i < ops.fnArray.length && out.length < MAX_OCR_IMAGES; i += 1) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue
        const name = ops.argsArray[i][0] as string
        // pdfjs decodes images asynchronously; objs.get() throws until the
        // decode lands. Poll has() with a timeout — a failed decode (e.g.
        // unsupported codec) simply skips that image.
        const image = await waitForImage(page, name, 5000)
        if (image === null || image.width <= 0 || image.height <= 0 || !image.data) continue
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

function normalizeRgba(image: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): Uint8ClampedArray {
  const { width, height, data } = image
  const expected = width * height
  if (data.length >= expected * 4) {
    // pdfjs decodes to RGBA; ensure the alpha channel is opaque (it usually is).
    const rgba = new Uint8ClampedArray(expected * 4)
    rgba.set(data.subarray(0, expected * 4))
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
    return rgba
  }
  if (data.length >= expected * 3) {
    const rgba = new Uint8ClampedArray(expected * 4)
    for (let i = 0; i < expected; i += 1) {
      rgba[i * 4] = data[i * 3]
      rgba[i * 4 + 1] = data[i * 3 + 1]
      rgba[i * 4 + 2] = data[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
    return rgba
  }
  // Grayscale (or unknown) — replicate the single channel.
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
 * OCR a scanned PDF: extract embedded page rasters and recognize them.
 * Returns '' when the OCR models are not downloaded (the caller keeps its
 * "no extractable text" error) or when nothing was recognized.
 */
export async function ocrPdfText(bytes: Uint8Array): Promise<string> {
  if (!isOcrReady()) return ''
  try {
    const images = await extractPdfImages(bytes)
    if (images.length === 0) return ''
    const pageTexts = new Map<number, string[]>()
    for (const image of images) {
      const png = rgbaToPng(image.width, image.height, image.data)
      const text = (await recognizePng(png)).trim()
      if (text.length > 0) {
        const bucket = pageTexts.get(image.page) ?? []
        bucket.push(text)
        pageTexts.set(image.page, bucket)
      }
    }
    return [...pageTexts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, texts]) => texts.join('\n'))
      .join('\n\n')
  } catch (error) {
    // Surface OCR failures so a scanned PDF that could not be recognized
    // shows why in the host log (the caller keeps its original error).
    console.warn(`[dsh-knowledge] OCR failed for scanned PDF: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

/** List languages currently on disk (settings panel detail). */
export async function listOcrLanguages(): Promise<Array<{ lang: string; ready: boolean }>> {
  let files: string[] = []
  try {
    files = await readdir(ocrCacheDir())
  } catch {
    // no cache yet
  }
  const onDisk = new Set(files.filter(name => name.endsWith('.traineddata')))
  return OCR_LANGUAGES.map(lang => ({ lang, ready: onDisk.has(`${lang}.traineddata`) }))
}
