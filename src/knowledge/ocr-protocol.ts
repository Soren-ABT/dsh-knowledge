export const OCR_PROTOCOL_VERSION = 1 as const

export type OcrProcessRequest =
  | { protocolVersion: 1; id: number; operation: 'recognize'; png: Uint8Array; modelDir: string }
  | { protocolVersion: 1; id: number; operation: 'status' }
  | { protocolVersion: 1; id: number; operation: 'shutdown' }

export type OcrProcessResponse = {
  protocolVersion: 1
  id: number
  operation: OcrProcessRequest['operation']
} & ({ ok: true; text?: string } | { ok: false; error: string })

export function ocrError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
