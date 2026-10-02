/** MinerU 4.0.6 V1 adapter. This never calls the cloud adapter or installs models. */
import type { MineruTier, ProcessingOutput, ProcessingProgress, ProcessorCapabilities } from './processing-types.js'
import { MINERU_ARCHIVE_LIMITS, normalizeMineruArchive, processingHash } from './parsed-document.js'
import { checkProcessingAbort, identifier, object, processingBudget, processingDelay, ProcessorError, ProcessorTransport, processorUrl, stringList } from './processor-transport.js'

export { ProcessorError } from './processor-transport.js'
export interface MineruLocalSettings { apiUrl: string; apiKey?: string; tier?: MineruTier; timeoutMs?: number }
export interface MineruLocalOptions {
  signal?: AbortSignal
  onProgress?: (progress: ProcessingProgress) => void
  /** Only resume a persisted job bound by the caller to these source bytes/options. */
  resumeJobId?: string
}
const statuses = new Set(['queued', 'running', 'completed', 'partial', 'failed', 'canceled'])
const tiers = new Set(['flash', 'basic', 'standard', 'advanced'])
const timeout = (settings: MineruLocalSettings, fallback: number) =>
  settings.timeoutMs !== undefined && Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0
    ? Math.min(Math.max(1, Math.floor(settings.timeoutMs)), 2 * 60 * 60 * 1000) : fallback

async function capabilities(transport: ProcessorTransport): Promise<ProcessorCapabilities> {
  const health = await transport.json('/v1/health')
  if (health.status !== 'ok' || typeof health.version !== 'string' || !/^4\.\d+\.\d+(?:[.-][\w.-]+)?$/.test(health.version)) {
    throw new ProcessorError('unsupported_version', 'This adapter requires a healthy MinerU 4.x V1 service (validated against 4.0.6).')
  }
  const features = object(health.features)
  const outputFormats = stringList(features.output_formats)
  const sources = stringList(features.sources)
  if (!outputFormats.includes('zip') || !sources.includes('file_id')) throw new ProcessorError('unsupported_capability', 'The MinerU service must support file_id sources and ZIP output.')
  const response = await transport.json('/v1/tiers')
  if (response.object !== 'list' || !Array.isArray(response.data) || response.data.length > 16) throw new ProcessorError('invalid_response', 'Invalid MinerU tier response.')
  const available = response.data.map(value => {
    const id = object(value).id
    if (typeof id !== 'string' || !tiers.has(id)) throw new ProcessorError('invalid_response', 'Invalid MinerU tier identifier.')
    return id
  })
  if (!available.length || new Set(available).size !== available.length) throw new ProcessorError('invalid_response', 'Empty or duplicated MinerU tiers.')
  return { provider: 'mineru-local', version: health.version, tiers: available, outputFormats, sources }
}

export async function probeMineruLocal(settings: MineruLocalSettings, signal?: AbortSignal): Promise<ProcessorCapabilities> {
  const budget = processingBudget(Math.min(timeout(settings, 15000), 15000), signal)
  try { return await capabilities(new ProcessorTransport(settings.apiUrl, settings.apiKey, budget.signal)) }
  finally { budget.dispose() }
}

function job(value: Record<string, unknown>, expectedId?: string): { id: string; status: string } {
  const id = identifier(value.job_id)
  if (expectedId && expectedId !== id) throw new ProcessorError('invalid_response', 'MinerU returned a different job identifier.')
  if (typeof value.status !== 'string' || !statuses.has(value.status)) throw new ProcessorError('invalid_response', 'MinerU returned an unsupported job state.')
  return { id, status: value.status }
}

function fileId(upload: Record<string, unknown>, expectedBytes: number): string {
  const file = object(upload.file)
  if (file.purpose !== undefined && file.purpose !== 'parse') throw new ProcessorError('invalid_response', 'MinerU returned a non-source upload file.')
  if (file.bytes !== undefined && file.bytes !== expectedBytes) throw new ProcessorError('invalid_response', 'MinerU upload size does not match the source.')
  return identifier(file.id)
}

function uploadHeaders(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {}
  const raw = object(value)
  const result: Record<string, string> = Object.create(null)
  if (Object.keys(raw).length > 64) throw new ProcessorError('invalid_response', 'Too many upload headers.')
  for (const [key, val] of Object.entries(raw)) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof val !== 'string' || val.length > 8192 || /[\r\n]/.test(val) ||
        ['host', 'cookie', 'connection', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
      throw new ProcessorError('invalid_response', 'MinerU returned an unsafe upload header.')
    }
    result[key] = val
  }
  return result
}

function mimeType(name: string): string {
  const extension = name.split('.').at(-1)?.toLowerCase()
  return ({ pdf: 'application/pdf', html: 'text/html', htm: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', epub: 'application/epub+zip' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}

export async function extractWithMineruLocal(bytes: Uint8Array, fileName: string, settings: MineruLocalSettings, options: MineruLocalOptions = {}): Promise<ProcessingOutput> {
  if (!bytes.byteLength || bytes.byteLength > 200 * 1024 * 1024) throw new ProcessorError('invalid_input', 'MinerU input must be nonempty and at most 200 MiB.')
  // Send a display basename only, not the host's private absolute source path.
  const name = fileName.split(/[\\/]/).at(-1) ?? ''
  if (!name || name.length > 512 || /[\x00-\x1f\x7f]/.test(name)) throw new ProcessorError('invalid_input', 'Invalid document filename.')
  const tier = settings.tier ?? 'standard'
  if (!tiers.has(tier)) throw new ProcessorError('invalid_config', 'Unsupported MinerU tier.')
  const budget = processingBudget(timeout(settings, 30 * 60 * 1000), options.signal)
  const transport = new ProcessorTransport(settings.apiUrl, settings.apiKey, budget.signal)
  let jobId: string | undefined
  const progress = (stage: ProcessingProgress['stage']) => options.onProgress?.({ stage, ...(jobId ? { jobId } : {}) })
  try {
    checkProcessingAbort(budget.signal)
    progress('checking')
    const supported = await capabilities(transport)
    if (!supported.tiers.includes(tier)) throw new ProcessorError('unsupported_capability', 'The selected MinerU tier is not advertised by this service.')
    let result: Record<string, unknown>
    if (options.resumeJobId) {
      jobId = identifier(options.resumeJobId)
      progress('parsing')
      result = await transport.json(`/v1/parse/jobs/${jobId}`, { missingJob: true })
    } else {
      progress('uploading')
      const sourceHash = processingHash(bytes)
      let upload = await transport.json('/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: name, bytes: bytes.byteLength, mime_type: mimeType(name), purpose: 'parse', sha256sum: sourceHash }), ambiguousSubmission: true })
      const uploadId = identifier(upload.id)
      if (upload.status === 'pending') {
        if (typeof upload.upload_url !== 'string' || upload.upload_url.length > 8192 || (upload.upload_method !== undefined && upload.upload_method !== null && upload.upload_method !== 'PUT')) {
          throw new ProcessorError('invalid_response', 'MinerU returned an invalid upload destination.')
        }
        const uploadUrl = processorUrl(upload.upload_url, transport.base)
        if (transport.base.protocol === 'https:' && uploadUrl.protocol !== 'https:') throw new ProcessorError('invalid_response', 'Refused an insecure document upload.')
        await transport.bytes(uploadUrl, { method: 'PUT', headers: uploadHeaders(upload.upload_headers), body: bytes })
        upload = await transport.json(`/v1/uploads/${uploadId}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256sum: sourceHash }), ambiguousSubmission: true })
        if (identifier(upload.id) !== uploadId) throw new ProcessorError('invalid_response', 'MinerU completed a different upload.')
      }
      if (upload.status !== 'completed') throw new ProcessorError('invalid_response', 'MinerU upload did not complete.')
      if (upload.sha256sum !== undefined && upload.sha256sum !== null && upload.sha256sum !== sourceHash) throw new ProcessorError('invalid_response', 'MinerU upload hash does not match the source.')
      const sourceId = fileId(upload, bytes.byteLength)
      result = await transport.json('/v1/parse/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ source: { type: 'file_id', file_id: sourceId }, page_range: 'all' }], tier, output_formats: ['zip'] }), ambiguousSubmission: true })
      try { jobId = job(result).id }
      catch { throw new ProcessorError('submission_unknown', 'MinerU job submission returned an invalid envelope; it was not resubmitted automatically.') }
      progress('parsing')
    }
    let state = job(result, jobId).status
    while (state === 'queued' || state === 'running') {
      progress(state === 'queued' ? 'queued' : 'parsing')
      await processingDelay(1000, budget.signal)
      result = await transport.json(`/v1/parse/jobs/${jobId}`, { missingJob: true })
      state = job(result, jobId).status
    }
    if (state === 'canceled') throw new ProcessorError('canceled', 'MinerU canceled this processing job.')
    if (state === 'failed') throw new ProcessorError('processing_failed', 'MinerU could not parse this document. Check the service logs and parser configuration.')
    if (!Array.isArray(result.files) || result.files.length !== 1) throw new ProcessorError('invalid_response', 'MinerU returned an unexpected number of file results.')
    const parsed = object(result.files[0])
    if (parsed.status !== 'completed') throw new ProcessorError('processing_failed', 'MinerU did not produce a usable result for this document.')
    const output = object(object(parsed.output_files).zip)
    const outputId = identifier(output.file_id)
    if (typeof output.bytes !== 'number' || !Number.isInteger(output.bytes) || output.bytes <= 0 || output.bytes > MINERU_ARCHIVE_LIMITS.compressedBytes) {
      throw new ProcessorError('invalid_response', 'MinerU ZIP size is invalid or exceeds the safety limit.')
    }
    progress('downloading')
    const archive = await transport.bytes(transport.endpoint(`/v1/files/${outputId}/content`), { allowRedirects: true, maxBytes: MINERU_ARCHIVE_LIMITS.compressedBytes })
    if (archive.byteLength !== output.bytes) throw new ProcessorError('invalid_response', 'MinerU ZIP download size does not match the output manifest.')
    progress('normalizing')
    const normalized = await normalizeMineruArchive(archive, bytes, { tier, processorVersion: supported.version, partial: state === 'partial', signal: budget.signal })
    checkProcessingAbort(budget.signal)
    progress('completed')
    return normalized
  } catch (error) {
    const canceled = options.signal?.aborted === true
    if (canceled && jobId) {
      // Independent bounded signal: the original cancellation must not prevent the
      // best-effort remote DELETE. A service may still finish in-flight inference.
      const cleanup = processingBudget(1500)
      try { await new ProcessorTransport(settings.apiUrl, settings.apiKey, cleanup.signal).bytes(transport.endpoint(`/v1/parse/jobs/${jobId}`), { method: 'DELETE' }) }
      catch { /* Cancellation remains local even if the service cannot acknowledge. */ }
      finally { cleanup.dispose() }
    }
    progress(canceled ? 'canceled' : 'failed')
    if (canceled) throw new DOMException('Processing canceled.', 'AbortError')
    if (budget.signal.aborted) throw budget.signal.reason
    throw error
  } finally { budget.dispose() }
}
