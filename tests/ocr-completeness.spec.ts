import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mock = vi.hoisted(() => ({
  pages: 3, width: 612, height: 792, brokenPage: -1, allocationFailures: 0, pngFailure: false,
  matrix: vi.fn((x: number, y: number) => [x, y]),
  pixmapDestroyed: vi.fn(), pageDestroyed: vi.fn(), documentDestroyed: vi.fn(), recognize: vi.fn(),
}))
vi.mock('mupdf', () => ({
  Document: { openDocument: () => ({
    countPages: () => mock.pages,
    loadPage: (index: number) => ({
      getBounds: () => [0, 0, mock.width, mock.height],
      toPixmap: () => {
        if (index === mock.brokenPage) throw new Error('malformed page content')
        if (mock.allocationFailures-- > 0) throw new Error('malloc (318946561 bytes) failed')
        return { asPNG: () => {
          if (mock.pngFailure) throw new Error('PNG encoding failed')
          return new Uint8Array([137, 80, 78, 71])
        }, destroy: mock.pixmapDestroyed }
      },
      destroy: mock.pageDestroyed,
    }),
    destroy: mock.documentDestroyed,
  }) },
  Matrix: { scale: mock.matrix }, ColorSpace: { DeviceRGB: 'rgb' },
}))
vi.mock('../src/knowledge/ocr-process-client.js', () => ({
  OcrProcessClient: class { recognize = mock.recognize; async dispose() {} },
}))

import { setLocalModelCacheDir } from '../src/knowledge/embed.js'
import { MAX_PAGE_RASTER_BYTES, ocrPdfText, ocrRenderScale, renderPdfPages } from '../src/knowledge/ocr.js'
const dirs: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mock, { pages: 3, width: 612, height: 792, brokenPage: -1, allocationFailures: 0, pngFailure: false })
  mock.recognize.mockReset().mockResolvedValue('recognized page')
})
afterEach(async () => {
  setLocalModelCacheDir(undefined)
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('complete and bounded OCR rasters (#37)', () => {
  it('keeps ordinary pages at 216dpi and large pixel-sized scans at 1x', () => {
    expect(ocrRenderScale(612, 792)).toBe(3)
    expect(ocrRenderScale(2800, 4600)).toBe(1)
    const scale = ocrRenderScale(12000, 18000)
    expect(scale).toBeLessThan(1)
    expect(Math.ceil(12000 * scale) * Math.ceil(18000 * scale) * 4).toBeLessThanOrEqual(MAX_PAGE_RASTER_BYTES)
    expect(() => ocrRenderScale(Number.NaN, 10)).toThrow('dimensions')
  })

  it('destroys every pixmap before a 26-page scan can exhaust the WASM heap', async () => {
    Object.assign(mock, { pages: 26, width: 2800, height: 4600 })
    expect(await renderPdfPages(new Uint8Array([1]), 100)).toHaveLength(26)
    expect(mock.matrix.mock.calls.every(([x, y]) => x === 1 && y === 1)).toBe(true)
    expect(mock.pixmapDestroyed).toHaveBeenCalledTimes(26)
    expect(mock.pageDestroyed).toHaveBeenCalledTimes(26)
    expect(mock.documentDestroyed).toHaveBeenCalledOnce()
  })

  it('retries an allocation failure at a smaller scale', async () => {
    Object.assign(mock, { pages: 1, allocationFailures: 1 })
    expect(await renderPdfPages(new Uint8Array([1]), 100)).toHaveLength(1)
    expect(mock.matrix.mock.calls).toEqual([[3, 3], [1.5, 1.5]])
    expect(mock.pixmapDestroyed).toHaveBeenCalledOnce()
  })

  it('fails a missing page instead of returning a successful prefix', async () => {
    mock.brokenPage = 1
    await expect(renderPdfPages(new Uint8Array([1]), 100)).rejects.toMatchObject({ code: 'ocr_incomplete' })
    expect(mock.pixmapDestroyed).toHaveBeenCalledOnce()
    expect(mock.pageDestroyed).toHaveBeenCalledTimes(2)
    expect(mock.documentDestroyed).toHaveBeenCalledOnce()
  })

  it('releases pixmaps even when PNG encoding fails', async () => {
    mock.pngFailure = true
    await expect(renderPdfPages(new Uint8Array([1]), 100)).rejects.toThrow('PNG encoding failed')
    expect(mock.pixmapDestroyed).toHaveBeenCalledOnce()
    expect(mock.documentDestroyed).toHaveBeenCalledOnce()
  })

  it('reports the page limit instead of silently truncating the document', async () => {
    mock.pages = 101
    await expect(renderPdfPages(new Uint8Array([1]), 100)).rejects.toThrow('page limit exceeded')
    expect(mock.matrix).not.toHaveBeenCalled()
    expect(mock.documentDestroyed).toHaveBeenCalledOnce()
  })

  it('does not publish recognized text when a later page crashes the OCR child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ocr-complete-')); dirs.push(dir)
    await mkdir(join(dir, 'ocr'))
    for (const name of ['ppocrv5_det.onnx', 'ppocrv5_rec.onnx', 'ppocrv5_dict.txt']) await writeFile(join(dir, 'ocr', name), 'test')
    setLocalModelCacheDir(dir)
    mock.recognize.mockResolvedValueOnce('page one').mockRejectedValueOnce(Object.assign(new Error('child exited'), { code: 'ocr_process_crash' }))
    await expect(ocrPdfText(new Uint8Array([1]))).rejects.toMatchObject({ code: 'ocr_process_crash' })
    expect(mock.recognize).toHaveBeenCalledTimes(2)
  })
})
