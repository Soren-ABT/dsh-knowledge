import { describe, expect, it, vi } from 'vitest'
import { deflateSync } from 'node:zlib'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocumentBuffer } from '../src/knowledge/parse.js'
import { setLocalModelCacheDir } from '../src/knowledge/embed.js'
import {
  buildOcrUrl,
  DEFAULT_OCR_MIRROR,
  extractPdfImages,
  isOcrReady,
  normalizeRgba,
  ocrPdfText,
  postprocessOcrText,
  prepareForOcr,
  renderPdfPages,
  rgbaToPng,
} from '../src/knowledge/ocr.js'

/**
 * Build a PDF whose page content is pure vector drawing (no embedded images,
 * no text layer) — like PDFs whose body is drawn with subsetted fonts, which
 * pdf-parse cannot extract and image extraction cannot see.
 */
function buildVectorOnlyPdf(): Buffer {
  const content = 'q 0.9 0.9 0.9 rg 0 0 612 792 re f Q\n'
    + 'q 0 0 0 rg BT /F1 24 Tf 72 700 Td (Markov) Tj ET Q\n'
    + 'q 0 0 0 rg 100 600 300 4 re f Q\n'
    + '0.5 0.5 0.5 RG 4 w 100 500 200 100 re S\n'
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]))
  })
  const xrefPos = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  chunks.push(
    Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`),
  )
  return Buffer.concat(chunks)
}

/** Build a one-page "scanned" PDF embedding one raster (no text layer). */
function makeScannedPdf(bits: 1 | 8, width: number, height: number): Buffer {
  const pixels = new Uint8Array(bits === 1 ? Math.ceil((width * height) / 8) : width * height)
  if (bits === 8) {
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 3) % 256
  } else {
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = i % 3 === 0 ? 0xff : 0x00
  }
  const stream = deflateSync(pixels)
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>`,
    ),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    // The stream bytes are concatenated as raw bytes — a latin1→UTF-8 string
    // round-trip would inflate them and corrupt the deflate stream.
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent ${bits} /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`,
      ),
      stream,
      Buffer.from('\nendstream'),
    ]),
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]))
  })
  const xrefPos = Buffer.concat(chunks).length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  chunks.push(
    Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`),
  )
  return Buffer.concat(chunks)
}

/** A pixel-sized 26-page scan reproduces the old 350MB-per-pixmap allocation. */
function makeLargeRepeatedScan(): Buffer {
  const width = 2800, height = 4600, count = 26
  const stream = deflateSync(Buffer.alloc(width * height, 180))
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im1 Do Q`
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${i + 5} 0 R`).join(' ')}] /Count ${count} >>`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    ...Array.from({ length: count }, () => Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im1 3 0 R >> >> /Contents 4 0 R >>`)),
  ]
  const chunks = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.concat(chunks).length)
    chunks.push(Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]))
  }
  const xrefPos = Buffer.concat(chunks).length
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
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
    // Point the cache at an EMPTY directory so this asserts the gate rather than
    // whatever happens to be installed on the machine running the suite: the same
    // '' used to be produced both by this gate and by a missing worker swallowing
    // its own failure, so the test passed for the wrong reason wherever the real
    // models were already downloaded.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr-gate-'))
    vi.stubEnv('DSH_HOME', dir)
    setLocalModelCacheDir(dir)
    try {
      const text = await ocrPdfText(makeScannedPdf(8, 4, 4))
      expect(text).toBe('')
    } finally {
      setLocalModelCacheDir(undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports an engine failure instead of claiming the document has no text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr-engine-'))
    const ocrDir = join(dir, 'ocr')
    await mkdir(ocrDir, { recursive: true })
    // PaddleOCR's files exist, so the readiness gate passes and the OCR path is
    // really taken. The worker, however, exists only as a build artifact — never
    // beside src/ — so every page fails.
    for (const name of ['ppocrv5_det.onnx', 'ppocrv5_rec.onnx', 'ppocrv5_dict.txt']) {
      await writeFile(join(ocrDir, name), 'x')
    }
    vi.stubEnv('DSH_HOME', dir)
    setLocalModelCacheDir(dir)
    try {
      // The setup itself must hold, or this test would silently assert the gate.
      expect(isOcrReady()).toBe(true)
      // Models installed + engine broken is an ENGINE failure. It used to return ''
      // like an empty document, and the caller then told the user to download the
      // models they already had (issue #17). The page must be big enough to be
      // rendered (a degenerate 4x4 page falls back to raster extraction, which
      // finds nothing and therefore attempts no recognition at all).
      await expect(ocrPdfText(makeScannedPdf(8, 20, 20))).rejects.toThrow(/OCR could not process this document/)
    } finally {
      setLocalModelCacheDir(undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a scanned PDF without OCR models still fails with the clear error', async () => {
    await expect(parseDocumentBuffer(makeScannedPdf(8, 20, 20), 'scan.pdf', 'application/pdf'))
      .rejects.toThrow(/no extractable text|PDF parsing failed/)
  })

  it('keeps a failing pdf-parse run from leaking a host-level rejection', async () => {
    // pdf-parse v1 bundles pdf.js v1.10, whose failure path leaves an
    // unhandled rejection behind: getDocument throws before the local doc is
    // assigned, so the library's unawaited doc.destroy() never runs. Node 22
    // escalates that stray rejection to a process-level unhandled rejection, so
    // without the dedicated worker thread this test fails on Node 22.19 with
    // "Vitest caught 1 unhandled error" while every assertion still passes.
    const leaked: unknown[] = []
    const onUnhandled = (reason: unknown): void => { leaked.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(parseDocumentBuffer(makeScannedPdf(8, 20, 20), 'scan.pdf', 'application/pdf'))
        .rejects.toThrow(/no extractable text|PDF parsing failed/)
      await expect(parseDocumentBuffer(Buffer.from('this is not a pdf at all %%%'), 'broken.pdf', 'application/pdf'))
        .rejects.toThrow(/PDF parsing failed/)
      // Give any stray rejection created by the failed loads time to surface.
      await new Promise(resolve => setTimeout(resolve, 1500))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(leaked).toEqual([])
  })
})

describe('pdfjs scanned-raster decode (real pipeline)', () => {
  // Native pdfjs startup can exceed Vitest's 5 s unit-test budget on a cold,
  // contended Windows runner; keep the wider budget local to this real pipeline.
  it('decodes an 8-bit grayscale page and normalizes it to grayscale RGBA', async () => {
    const images = await extractPdfImages(makeScannedPdf(8, 30, 20))
    expect(images).toHaveLength(1)
    expect(images[0].width).toBe(30)
    expect(images[0].height).toBe(20)
    // pdfjs's decoded layout varies with image size (RGBA for small rasters,
    // RGB for larger 8-bit grayscale) — normalizeRgba must handle both.
    expect(images[0].data.length).toBeGreaterThanOrEqual(30 * 20)
    const rgba = normalizeRgba(images[0])
    expect(rgba.length).toBe(30 * 20 * 4)
    // Grayscale: every channel equals the first, alpha opaque.
    for (let i = 0; i < 30 * 20; i += 1) {
      expect(rgba[i * 4]).toBe(rgba[i * 4 + 1])
      expect(rgba[i * 4 + 1]).toBe(rgba[i * 4 + 2])
      expect(rgba[i * 4 + 3]).toBe(255)
    }
  }, 30_000)

  it('decodes a 1-bit (JBIG2/CCITT-style) page as bit-packed rows into pure black/white RGBA', async () => {
    // A larger raster (100x80) decodes as bit-packed 1bpp (~1000 bytes); small
    // rasters come back pre-expanded to RGBA — both must normalize to the same
    // black/white RGBA.
    const images = await extractPdfImages(makeScannedPdf(1, 100, 80))
    expect(images).toHaveLength(1)
    const small = await extractPdfImages(makeScannedPdf(1, 30, 20))
    const decodeSizes = new Set([...images, ...small].map(image => image.data.length))
    expect(decodeSizes.size).toBeGreaterThanOrEqual(1)
    for (const image of [...images, ...small]) {
      const rgba = normalizeRgba(image)
      expect(rgba.length).toBe(image.width * image.height * 4)
      for (let i = 0; i < image.width * image.height; i += 1) {
        const v = rgba[i * 4]
        expect(v === 0 || v === 255).toBe(true)
        expect(rgba[i * 4 + 1]).toBe(v)
        expect(rgba[i * 4 + 2]).toBe(v)
        expect(rgba[i * 4 + 3]).toBe(255)
      }
    }
  })

  it('normalizes a single-channel 8-bit grayscale buffer (defensive branch)', () => {
    const data = new Uint8ClampedArray(4 * 4)
    for (let i = 0; i < 16; i += 1) data[i] = i * 16
    const rgba = normalizeRgba({ width: 4, height: 4, data })
    expect(rgba.length).toBe(16 * 4)
    for (let i = 0; i < 16; i += 1) {
      expect(rgba[i * 4]).toBe(data[i])
      expect(rgba[i * 4 + 1]).toBe(data[i])
      expect(rgba[i * 4 + 2]).toBe(data[i])
      expect(rgba[i * 4 + 3]).toBe(255)
    }
  })
})

describe('full-page rendering (mupdf, Cherry pdfPageOcr path)', () => {
  it('renders all 26 large scan pages at their native size without exhausting the WASM heap (#37)', { timeout: 45_000 }, async () => {
    const pages = await renderPdfPages(makeLargeRepeatedScan(), 100)
    expect(pages).toHaveLength(26)
    expect(pages?.map(page => page.page)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1))
    for (const { png } of pages ?? []) {
      expect(png.readUInt32BE(16)).toBe(2800)
      expect(png.readUInt32BE(20)).toBe(4600)
    }
  })
  it('renders a raster-only page into one PNG', async () => {
    const pages = await renderPdfPages(makeScannedPdf(8, 40, 30), 10)
    expect(pages).not.toBeNull()
    expect(pages!.length).toBe(1)
    expect(pages![0].page).toBe(1)
    const png = pages![0].png
    // Valid PNG with an IHDR chunk (magic + length + type).
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR')
    expect(png.length).toBeGreaterThan(100)
  })

  it('renders a vector-only page (no embedded images at all)', async () => {
    // A page whose content is pure vector drawing — the case that used to
    // OCR only stray character-fragment images (or nothing at all).
    const pages = await renderPdfPages(buildVectorOnlyPdf(), 10)
    expect(pages).not.toBeNull()
    expect(pages!.length).toBe(1)
    expect(pages![0].png.length).toBeGreaterThan(100)
  })

  it('returns null when mupdf is unavailable', async () => {
    // Can't easily unload mupdf; the guard here documents the contract the
    // caller relies on for the extraction fallback.
    const pages = await renderPdfPages(new Uint8Array([1, 2, 3]), 10)
    // Invalid input: mupdf throws → null (fallback path).
    expect(pages).toBeNull()
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
