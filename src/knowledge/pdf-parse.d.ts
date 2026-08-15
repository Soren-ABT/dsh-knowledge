/** Minimal ambient types for pdf-parse (CommonJS, no bundled declarations). */
declare module 'pdf-parse' {
  export interface PdfParseResult {
    text: string
    numpages: number
    numrender: number
    info: unknown
    metadata: unknown
    version: string
  }
  function pdfParse(dataBuffer: Uint8Array | Buffer, options?: unknown): Promise<PdfParseResult>
  export default pdfParse
}
