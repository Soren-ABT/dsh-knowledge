import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { parseDocumentBuffer } from '../src/knowledge/parse.js'
import { ocrPdfText, rgbaToPng } from '../src/knowledge/ocr.js'

/** Build a "scanned" PDF: one page embedding a grayscale raster (no text layer). */
function makeScannedPdf(width: number, height: number): Buffer {
  const pixels = new Uint8Array(width * height)
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = 255
  const stream = deflateSync(pixels)
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${stream.length} >>\nstream\n${Buffer.from(stream).toString('latin1')}\nendstream`,
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`))
  })
  const xrefPos = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`))
  return Buffer.concat(chunks)
}

describe('rgbaToPng', () => {
  it('emits a valid PNG header with the right dimensions', () => {
    const rgba = new Uint8ClampedArray(2 * 2 * 4)
    rgba.fill(255)
    const png = rgbaToPng(2, 2, rgba)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR: length 13, width 2, height 2, bit depth 8, color type 6 (RGBA)
    expect(png.subarray(8, 12)).toEqual(Buffer.from([0, 0, 0, 13]))
    expect(png.readUInt32BE(16)).toBe(2)
    expect(png.readUInt32BE(20)).toBe(2)
    expect(png[24]).toBe(8)
    expect(png[25]).toBe(6)
    // IEND trailer
    expect(png.subarray(png.length - 8, png.length - 4)).toEqual(Buffer.from('IEND', 'latin1'))
  })
})

describe('local OCR fallback', () => {
  it('returns empty when the OCR models are not downloaded (caller keeps its error)', async () => {
    // The test environment has no traineddata on disk, so this is the gate path.
    const text = await ocrPdfText(makeScannedPdf(4, 4))
    expect(text).toBe('')
  })

  it('a scanned PDF without OCR models still fails with the clear error', async () => {
    await expect(parseDocumentBuffer(makeScannedPdf(20, 20), 'scan.pdf', 'application/pdf'))
      .rejects.toThrow(/no extractable text|PDF parsing failed/)
  })
})
