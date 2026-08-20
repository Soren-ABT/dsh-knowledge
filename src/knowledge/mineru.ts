/**
 * Remote document processor — MinerU (Cherry's `mineru` file processor).
 * Used for scanned / complex-layout PDFs when configured: the file is
 * uploaded to the MinerU API (batch task → PUT upload → poll → download the
 * result zip), and the extracted Markdown replaces the local parse output.
 * Falls back to the local pipeline on any API failure.
 *
 * API shape mirrors Cherry's `processors/mineru/*` (file-urls/batch +
 * extract-results/batch + zip download).
 * @module dsh-knowledge/knowledge/mineru
 */

import JSZip from 'jszip'
import { httpFetch } from './net.js'

export interface MineruSettings {
  apiKey: string
  apiHost: string
}

const POLL_INTERVAL_MS = 5000
const EXTRACT_TIMEOUT_MS = 30 * 60_000

interface MineruEnvelope<T> {
  code: number
  data: T
  msg?: string
}

interface BatchData {
  batch_id: string
  file_urls: string[]
  headers?: Array<Record<string, string>>
}

interface ExtractFileResult {
  state: 'done' | 'waiting-file' | 'pending' | 'running' | 'failed' | 'converting'
  err_msg?: string
  full_zip_url?: string
}

async function apiJson<T>(
  url: string,
  settings: MineruSettings,
  init?: { method?: string; body?: string; signal?: AbortSignal },
): Promise<MineruEnvelope<T>> {
  const response = await httpFetch(url, {
    method: init?.method ?? 'GET',
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      accept: '*/*',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body,
    timeoutMs: 60000,
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
  })
  if (!response.ok) {
    throw new Error(`mineru request failed: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
  return (await response.json()) as MineruEnvelope<T>
}

/**
 * Extract a PDF's text through the MinerU API. Returns the Markdown text;
 * throws on API/processing failure so the caller can fall back to local.
 * An external `signal` (e.g. the document was deleted) aborts the polling
 * loop and the in-flight requests so a paid remote batch is not left running.
 */
export async function extractPdfWithMineru(
  bytes: Uint8Array,
  fileName: string,
  settings: MineruSettings,
  signal?: AbortSignal,
): Promise<string> {
  const host = settings.apiHost.trim() === '' ? 'https://mineru.net' : settings.apiHost.trim().replace(/\/+$/, '')

  // 1. Create the batch task and get a signed upload URL.
  const batch = await apiJson<BatchData>(`${host}/api/v4/file-urls/batch`, settings, {
    method: 'POST',
    body: JSON.stringify({
      files: [{ name: fileName, data_id: 'dsh-knowledge' }],
    }),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (batch.code !== 0 || batch.data.batch_id === '') {
    throw new Error(`mineru batch create failed: ${batch.msg ?? 'empty batch_id'}`)
  }
  const uploadUrl = batch.data.file_urls[0]
  if (!uploadUrl) throw new Error('mineru batch create returned no upload URL')

  // 2. PUT the file bytes to the signed URL.
  const upload = await httpFetch(uploadUrl, {
    method: 'PUT',
    headers: batch.data.headers?.[0],
    body: bytes,
    timeoutMs: 120000,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!upload.ok) throw new Error(`mineru upload failed: HTTP ${upload.status}`)

  // 3. Poll the batch result until the file is done (or failed).
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw new Error('mineru extraction aborted (document was deleted)')
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const result = await apiJson<{ extract_result?: ExtractFileResult[] }>(
      `${host}/api/v4/extract-results/batch/${batch.data.batch_id}`,
      settings,
      signal !== undefined ? { signal } : undefined,
    )
    if (result.code !== 0) throw new Error(`mineru poll failed: ${result.msg ?? 'non-zero code'}`)
    const fileResult = result.data.extract_result?.[0]
    if (fileResult === undefined) continue
    if (fileResult.state === 'failed') {
      throw new Error(`mineru extract failed: ${fileResult.err_msg ?? 'unknown error'}`)
    }
    if (fileResult.state === 'done') {
      if (!fileResult.full_zip_url) throw new Error('mineru extract done without a result zip')
      // 4. Download the zip and pull the Markdown out of it.
      const zipResponse = await httpFetch(fileResult.full_zip_url, {
        timeoutMs: 120000,
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!zipResponse.ok) throw new Error(`mineru result download failed: HTTP ${zipResponse.status}`)
      const zip = await JSZip.loadAsync(new Uint8Array(await zipResponse.arrayBuffer()))
      const markdownEntry = Object.values(zip.files).find(
        entry => !entry.dir && /\.md$/i.test(entry.name) && !entry.name.includes('__assets__'),
      )
      if (markdownEntry === undefined) throw new Error('mineru result zip contains no markdown')
      const markdown = await markdownEntry.async('string')
      if (markdown.trim().length === 0) throw new Error('mineru returned empty markdown')
      return markdown
    }
  }
  throw new Error('mineru extract timed out')
}
