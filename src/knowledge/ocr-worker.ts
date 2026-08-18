/**
 * OCR inference worker — PaddleOCR (PP-OCRv5 mobile, Cherry's engine choice
 * with a full Chinese dictionary) runs here first, Tesseract.js as fallback.
 * Everything runs in this thread so a native/WASM crash (onnxruntime,
 * OpenCV.js, tesseract's rethrown worker errors) can never take down the host
 * process; the client respawns on 'error' (Cherry's own-worker OCR posture).
 *
 * Protocol (JSON over parentPort):
 *   main → worker:  { id, type: 'ocr', png: Buffer, modelDir: string }
 *                    { type: 'shutdown' }
 *   worker → main:  { id, ok: true, text } | { id, ok: false, error }
 * @module dsh-knowledge/knowledge/ocr-worker
 */

import { parentPort } from 'node:worker_threads'
import { join } from 'node:path'
import type { PaddleOcrService as PaddleOcrServiceType } from 'ppu-paddle-ocr'
import type { createWorker as TesseractCreateWorker } from 'tesseract.js'

type OcrWorker = Awaited<ReturnType<typeof TesseractCreateWorker>>
type TesseractModule = { createWorker: typeof TesseractCreateWorker }
type PaddleModule = { PaddleOcrService: typeof PaddleOcrServiceType }

interface OcrRequest {
  id: number
  type: 'ocr'
  png: Buffer
  modelDir: string
}

let paddlePromise: Promise<PaddleOcrServiceType> | null = null
let paddleModelDir: string | null = null
let tesseractPromise: Promise<TesseractModule> | null = null
let tesseractWorkerPromise: Promise<OcrWorker> | null = null

async function getPaddle(modelDir: string): Promise<PaddleOcrServiceType> {
  if (paddlePromise === null || paddleModelDir !== modelDir) {
    paddleModelDir = modelDir
    paddlePromise = (async () => {
      const mod = await import('ppu-paddle-ocr') as PaddleModule
      const service = new mod.PaddleOcrService({
        model: {
          detection: join(modelDir, 'ppocrv5_det.onnx'),
          recognition: join(modelDir, 'ppocrv5_rec.onnx'),
          charactersDictionary: join(modelDir, 'ppocrv5_dict.txt'),
        },
      })
      await service.initialize()
      return service
    })()
    // A failed init poisons the cached promise — clear it for a later retry.
    paddlePromise.catch(() => { paddlePromise = null })
  }
  return paddlePromise
}

async function recognizeWithPaddle(service: PaddleOcrServiceType, png: Buffer): Promise<string> {
  // ppu-paddle-ocr's recognize() takes an ArrayBuffer of image bytes.
  const buffer = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer
  const result = await service.recognize(buffer, { flatten: true })
  return result.text ?? ''
}

async function recognizeWithTesseract(png: Buffer, langPath: string): Promise<string> {
  const tesseract = (tesseractPromise ??= import('tesseract.js') as Promise<TesseractModule>)
  const mod = await tesseract
  tesseractWorkerPromise ??= mod.createWorker('chi_sim+eng', 1, { langPath })
  const worker = await tesseractWorkerPromise
  // tesseract.js 7 rejects Buffer-typed input — hand it a plain Uint8Array.
  const bytes = new Uint8Array(png.buffer, png.byteOffset, png.byteLength)
  // @ts-expect-error tesseract.js's types still say Buffer, but v7 throws on Buffer at runtime
  const { data } = await worker.recognize(bytes)
  return data.text
}

parentPort?.on('message', (message: OcrRequest | { type: 'shutdown' }): void => {
  if (message.type === 'shutdown') {
    process.exit(0)
    return
  }
  const { id, png, modelDir } = message
  void (async () => {
    try {
      let text = ''
      try {
        const service = await getPaddle(modelDir)
        text = (await recognizeWithPaddle(service, png)).trim()
      } catch {
        // PaddleOCR unavailable/failed — fall back to Tesseract if its
        // traineddata is present (a previous download, or manual placement).
        text = (await recognizeWithTesseract(png, modelDir)).trim()
      }
      parentPort?.postMessage({ id, ok: true, text })
    } catch (error) {
      parentPort?.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
