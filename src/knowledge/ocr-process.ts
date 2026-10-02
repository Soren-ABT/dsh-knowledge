/**
 * OCR inference process — PaddleOCR (PP-OCRv5 mobile, Cherry's engine choice
 * with a full Chinese dictionary) runs here first, Tesseract.js as fallback.
 * A native/WASM fatal exits this child instead of the DSH host. Requests are
 * serialized so the engines never share concurrent inference state.
 *
 * Protocol: versioned IPC with advanced Buffer/Uint8Array serialization.
 * @module dsh-knowledge/knowledge/ocr-process
 */

import { join } from 'node:path'
import { OCR_PROTOCOL_VERSION, type OcrProcessRequest, type OcrProcessResponse } from './ocr-protocol.js'
import type { PaddleOcrService as PaddleOcrServiceType } from 'ppu-paddle-ocr'
import type { createWorker as TesseractCreateWorker } from 'tesseract.js'

type OcrWorker = Awaited<ReturnType<typeof TesseractCreateWorker>>
type TesseractModule = { createWorker: typeof TesseractCreateWorker }
type PaddleModule = { PaddleOcrService: typeof PaddleOcrServiceType }

let paddlePromise: Promise<PaddleOcrServiceType> | null = null
let paddleModelDir: string | null = null
let tesseractPromise: Promise<TesseractModule> | null = null
let tesseractWorkerPromise: Promise<OcrWorker> | null = null

async function getPaddle(modelDir: string): Promise<PaddleOcrServiceType> {
  if (paddlePromise === null || paddleModelDir !== modelDir) {
    paddleModelDir = modelDir
    paddlePromise = (async () => {
      // Raise onnxruntime's log level BEFORE the model loads: PaddleOCR's
      // ONNX files carry dozens of unused constant initializers and the
      // per-tensor clean-up warnings flood the host console otherwise.
      try {
        const { env } = await import('onnxruntime-node') as { env?: { logLevel?: string } }
        if (env !== undefined) env.logLevel = 'error'
      } catch {
        // log-level control unavailable — warnings are cosmetic anyway
      }
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
  // A failed createWorker poisons the cached promise (every later fallback
  // would fail instantly) — mirror getPaddle's reset so the next attempt
  // retries from scratch.
  tesseractWorkerPromise ??= mod.createWorker('chi_sim+eng', 1, { langPath }).catch((error: unknown) => {
    tesseractWorkerPromise = null
    throw error
  })
  const worker = await tesseractWorkerPromise
  // tesseract.js 7 rejects Buffer-typed input — hand it a plain Uint8Array.
  const bytes = new Uint8Array(png.buffer, png.byteOffset, png.byteLength)
  // @ts-expect-error tesseract.js's types still say Buffer, but v7 throws on Buffer at runtime
  const { data } = await worker.recognize(bytes)
  return data.text
}

let queue = Promise.resolve()
process.on('disconnect', () => process.exit(0))
process.on('message', (message: OcrProcessRequest): void => {
  if (message.protocolVersion !== OCR_PROTOCOL_VERSION) return
  if (message.operation === 'shutdown') {
    process.exit(0)
    return
  }
  const respond = (response: OcrProcessResponse): void => { if (process.connected) process.send?.(response) }
  if (message.operation === 'status') {
    respond({ protocolVersion: OCR_PROTOCOL_VERSION, id: message.id, operation: 'status', ok: true })
    return
  }
  const { id, modelDir } = message
  const png = Buffer.from(message.png)
  queue = queue.then(async () => {
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
      respond({ protocolVersion: OCR_PROTOCOL_VERSION, id, operation: 'recognize', ok: true, text })
    } catch (error) {
      respond({ protocolVersion: OCR_PROTOCOL_VERSION, id, operation: 'recognize', ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
})
