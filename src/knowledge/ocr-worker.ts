/**
 * OCR inference worker — Tesseract.js (WASM) runs in this thread so its
 * worker errors (which tesseract.js rethrows on process.nextTick) can never
 * take down the host process; a crash here surfaces as an 'error' event the
 * client catches and respawns from (Cherry's own-worker OCR posture).
 *
 * Protocol (JSON over parentPort):
 *   main → worker:  { id, type: 'ocr', png: Buffer, langPath: string }
 *                    { type: 'shutdown' }
 *   worker → main:  { id, ok: true, text } | { id, ok: false, error }
 * @module dsh-knowledge/knowledge/ocr-worker
 */

import { parentPort } from 'node:worker_threads'
import type { createWorker as TesseractCreateWorker } from 'tesseract.js'

type OcrWorker = Awaited<ReturnType<typeof TesseractCreateWorker>>
type TesseractModule = { createWorker: typeof TesseractCreateWorker }

let tesseractPromise: Promise<TesseractModule> | null = null
let workerPromise: Promise<OcrWorker> | null = null

function loadTesseract(): Promise<TesseractModule> {
  tesseractPromise ??= import('tesseract.js') as Promise<TesseractModule>
  return tesseractPromise
}

interface OcrRequest {
  id: number
  type: 'ocr'
  png: Buffer
  langPath: string
}

parentPort?.on('message', (message: OcrRequest | { type: 'shutdown' }): void => {
  if (message.type === 'shutdown') {
    process.exit(0)
    return
  }
  const { id, png, langPath } = message
  void (async () => {
    try {
      const tesseract = await loadTesseract()
      // Both languages ship together (the client downloads them as one unit).
      workerPromise ??= tesseract.createWorker('chi_sim+eng', 1, { langPath })
      const worker = await workerPromise
      // tesseract.js 7 rejects Buffer-typed input — hand it a plain Uint8Array
      // (Uint8Array.from copies, so no Buffer subclass/prototype can leak in).
      const bytes = Uint8Array.from(png)
      // @ts-expect-error tesseract.js's types still say Buffer, but v7 throws on Buffer at runtime
      const { data } = await worker.recognize(bytes)
      parentPort?.postMessage({ id, ok: true, text: data.text })
    } catch (error) {
      parentPort?.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
