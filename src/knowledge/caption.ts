/**
 * Image/table captioning for imported PDFs (NexusRAG-style visual
 * intelligence): embedded page images are extracted via pdfjs, decorative
 * fragments (rule lines, icons, tiny glyphs) are filtered out by size, and a
 * vision language model describes each remaining figure. The descriptions
 * are appended to the document text so charts become searchable and quotable
 * — OCR reads the labels, captioning reads the meaning.
 *
 * Providers:
 * - `openai`: any OpenAI-compatible vision chat API (`POST {baseUrl}/chat/completions`
 *   with an image_url content part) — Qwen-VL / GPT-4o-mini / SiliconFlow etc.
 * - `ollama`: a local Ollama server (`POST {baseUrl}/api/chat` with base64
 *   images) — llava / qwen2.5vl run fully offline.
 *
 * Captioning is best-effort: a provider failure or an unreachable model
 * leaves the document text untouched (a warn is logged) — imports never
 * block on the vision model.
 * @module dsh-knowledge/knowledge/caption
 */

import { httpFetch } from './net.js'
import { extractPdfImages, rgbaToPng } from './ocr.js'

export interface CaptionConfig {
  provider: 'off' | 'openai' | 'ollama'
  model: string
  baseUrl: string
  apiKey: string
  /** Effective embedding base URL (fallback for the openai provider). */
  embeddingBaseUrl: string
}

/** Cap on captioning work per PDF (images per document). */
const MAX_CAPTION_IMAGES = 20
/** Decorative fragments (icons, rule lines, formula glyphs) are smaller than this. */
const MIN_CAPTION_EDGE = 160
/**
 * Full-page scans and huge embedded rasters are not "figures": base64-encoding
 * a 4000x3000 RGBA page (~48MB → ~64MB base64) per image would balloon the
 * vision request and the process heap. Skip anything above ~4M pixels.
 */
const MAX_CAPTION_PIXELS = 4_000_000
const CAPTION_PROMPT = '请用简洁的中文描述这张图片/图表的内容：说明它展示的主题、数据趋势或关键结论。若信息不足请直接说无法判断。'

/**
 * Caption the embedded images of a PDF. Returns the descriptions joined into
 * one block (page order), or '' when the provider is off / nothing to
 * caption / the provider failed.
 */
export async function captionPdfImages(bytes: Uint8Array, config: CaptionConfig): Promise<string> {
  if (config.provider === 'off') return ''
  const model = config.model.trim()
  if (model === '') return ''
  let images: Array<{ page: number; png: Buffer }> = []
  try {
    const extracted = await extractPdfImages(bytes)
    images = extracted
      .filter(image => image.width >= MIN_CAPTION_EDGE && image.height >= MIN_CAPTION_EDGE
        && image.width * image.height <= MAX_CAPTION_PIXELS)
      .slice(0, MAX_CAPTION_IMAGES)
      .map(image => {
        const { width, height, data } = image
        const png = rgbaToPng(width, height, data)
        return { page: image.page, png }
      })
  } catch (error) {
    console.warn(`[dsh-knowledge] caption image extraction failed: ${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
  if (images.length === 0) return ''
  const descriptions: string[] = []
  for (const { page, png } of images) {
    try {
      const text = await captionImage(png, config)
      if (text.trim().length > 0) descriptions.push(`（第 ${page} 页图表描述）${text.trim()}`)
    } catch (error) {
      console.warn(`[dsh-knowledge] caption failed for a page-${page} image: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (descriptions.length === 0) return ''
  return `\n\n[文档图表描述]\n${descriptions.join('\n')}`
}

/** Describe one PNG through the configured vision provider. */
async function captionImage(png: Buffer, config: CaptionConfig): Promise<string> {
  if (config.provider === 'ollama') return captionViaOllama(png, config)
  return captionViaOpenAI(png, config)
}

async function captionViaOpenAI(png: Buffer, config: CaptionConfig): Promise<string> {
  const baseUrl = config.baseUrl.trim() === '' ? config.embeddingBaseUrl : config.baseUrl.trim()
  if (baseUrl === '') throw new Error('captioning base URL is empty (set it or the embedding base URL)')
  const base64 = png.toString('base64')
  const response = await httpFetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey !== '' ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model.trim(),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: CAPTION_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
    }),
    timeoutMs: 120000,
  })
  if (!response.ok) throw new Error(`caption request failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = json.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error('caption response missing content')
  return content
}

async function captionViaOllama(png: Buffer, config: CaptionConfig): Promise<string> {
  const baseUrl = config.baseUrl.trim() === '' ? 'http://127.0.0.1:11434' : config.baseUrl.trim().replace(/\/+$/, '')
  const base64 = png.toString('base64')
  const response = await httpFetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model.trim(),
      messages: [{ role: 'user', content: CAPTION_PROMPT, images: [base64] }],
      stream: false,
    }),
    timeoutMs: 180000,
  })
  if (!response.ok) throw new Error(`ollama caption failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  const json = (await response.json()) as { message?: { content?: string } }
  const content = json.message?.content
  if (typeof content !== 'string') throw new Error('ollama caption response missing content')
  return content
}
