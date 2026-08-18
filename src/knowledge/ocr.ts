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
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
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

/** Languages shipped by the OCR card (Cherry's tesseract default: zh + zh-Traditional + en). */
const OCR_LANGUAGES = ['chi_sim', 'chi_tra', 'eng'] as const
type OcrLanguage = (typeof OCR_LANGUAGES)[number]

/**
 * PaddleOCR engine (Cherry's local OCR) — PP-OCRv5 mobile: full Chinese
 * dictionary (18383 entries incl. 15k+ CJK). PP-OCRv6's ONNX repos ship a
 * symbol-only dict (no CJK), so v5 mobile is the practical Chinese-capable
 * choice; det 4.8MB + rec 16.5MB + dict ≈ 21MB total.
 */
interface OcrModelFile {
  url: string
  fileName: string
  minBytes: number
}

const PPOCR_FILES: readonly OcrModelFile[] = [
  {
    url: 'https://hf-mirror.com/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx',
    fileName: 'ppocrv5_det.onnx',
    minBytes: 1_000_000,
  },
  {
    url: 'https://hf-mirror.com/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.onnx',
    fileName: 'ppocrv5_rec.onnx',
    minBytes: 1_000_000,
  },
  {
    url: 'https://hf-mirror.com/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/main/inference.yml',
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
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
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
 */
export async function downloadOcrModels(): Promise<OcrModelStatus> {
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
        await downloadModelFile(file, (fraction) => {
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
 * Remove the OCR cache. The worker is released first so a Windows file lock
 * cannot block the unlink (Cherry terminates its OCR worker before deleting
 * weights for the same reason).
 */
export async function removeOcrModels(): Promise<void> {
  disposeOcrWorker()
  setOcrStatus({ status: 'idle', progress: 0, message: '' })
  await rm(ocrCacheDir(), { recursive: true, force: true })
}

/**
 * Download one engine file atomically (tmp + rename, Cherry's fetchToFile
 * posture). The dictionary entry (inference.yml) is parsed into its text file.
 */
async function downloadModelFile(file: OcrModelFile, onProgress: (fraction: number) => void): Promise<void> {
  const response = await httpFetch(file.url, { timeoutMs: 240000 })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${file.url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length < file.minBytes) {
    throw new Error(`${file.url} too small (${bytes.length} bytes) — mirror error page?`)
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
    ensureOcrWorker().postMessage({ id, type: 'ocr', png, modelDir: ocrCacheDir() })
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
  if (data.length >= expected / 8) {
    // 1-bit bitmap (JBIG2/CCITT fax scans): pdfjs hands back bit-packed rows,
    // MSB first. Every byte carries 8 pixels — treating it as grayscale would
    // shred the image and OCR would see noise.
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
      // Cherry preprocesses OCR input (grayscale → normalize → sharpen, via
      // sharp); here the same chain runs in pure JS. Low-resolution rasters
      // are upscaled 2x first (Cherry renders PDF pages at ~216dpi instead).
      const { width, height, data } = prepareForOcr(image.width, image.height, image.data)
      const png = rgbaToPng(width, height, data)
      const text = postprocessOcrText(await recognizePng(png))
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
 */
export function postprocessOcrText(text: string): string {
  return text.replace(/([\u4e00-\u9fff\u3400-\u4dbf])\s+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '$1')
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
