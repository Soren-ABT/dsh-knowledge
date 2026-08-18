import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { parseDocumentBuffer } from '../src/knowledge/parse.js'
import {
  buildOcrUrl,
  DEFAULT_OCR_MIRROR,
  ocrPdfText,
  postprocessOcrText,
  prepareForOcr,
  rgbaToPng,
} from '../src/knowledge/ocr.js'

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

describe('OCR input preparation (Cherry: grayscale → normalize → sharpen)', () => {
  it('upscales small rasters 2x and returns grayscale RGBA of the new size', () => {
    const rgba = new Uint8ClampedArray(8 * 8 * 4)
    for (let i = 0; i < 8 * 8; i += 1) {
      const v = (i * 3) % 256
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255
    }
    const out = prepareForOcr(8, 8, rgba)
    expect(out.width).toBe(16)
    expect(out.height).toBe(16)
    expect(out.data.length).toBe(16 * 16 * 4)
    // Grayscale: every channel equals the first, alpha opaque.
    expect(out.data[4]).toBe(out.data[5])
    expect(out.data[6]).toBe(out.data[5])
    expect(out.data[7]).toBe(255)
  })

  it('keeps a large raster at its original size', () => {
    const rgba = new Uint8ClampedArray(1500 * 1000 * 4)
    rgba.fill(255)
    const out = prepareForOcr(1500, 1000, rgba)
    expect(out.width).toBe(1500)
    expect(out.height).toBe(1000)
  })
})

describe('OCR text post-processing', () => {
  it('collapses spaces between CJK glyphs but keeps inter-word spaces', () => {
    expect(postprocessOcrText('中 文 测 试 OCR 12345\n')).toBe('中文测试 OCR 12345\n')
    expect(postprocessOcrText('hello world 中文 测试')).toBe('hello world 中文测试')
  })
})

describe('OCR model download mirror (hfEndpoint)', () => {
  const repoPath = '/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/main/inference.onnx'

  it('defaults to the China-friendly hf-mirror.com when no endpoint is configured', () => {
    expect(buildOcrUrl(undefined, repoPath)).toBe(`${DEFAULT_OCR_MIRROR}${repoPath}`)
    expect(buildOcrUrl('', repoPath)).toBe(`${DEFAULT_OCR_MIRROR}${repoPath}`)
  })

  it('honors the configured endpoint for overseas users', () => {
    expect(buildOcrUrl('https://huggingface.co', repoPath)).toBe(`https://huggingface.co${repoPath}`)
  })

  it('strips trailing slashes from the configured endpoint', () => {
    expect(buildOcrUrl('https://huggingface.co/', repoPath)).toBe(`https://huggingface.co${repoPath}`)
  })
})
