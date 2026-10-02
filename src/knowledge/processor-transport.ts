/** Bounded transport for optional document processors. Never retries mutations. */
export class ProcessorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProcessorError'
  }
}

export function processorUrl(value: string, base?: URL): URL {
  let url: URL
  try { url = new URL(value, base) } catch { throw new ProcessorError('invalid_config', 'Invalid MinerU HTTP service URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ProcessorError('invalid_config', 'MinerU requires an HTTP(S) URL without embedded credentials or a fragment.')
  }
  return url
}

export function checkProcessingAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Processing canceled.', 'AbortError')
}

export function processingBudget(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const cancel = () => controller.abort(new DOMException('Processing canceled.', 'AbortError'))
  const timer = setTimeout(() => controller.abort(new ProcessorError('timeout', 'MinerU processing exceeded its total time budget.')), timeoutMs)
  timer.unref?.()
  external?.addEventListener('abort', cancel, { once: true })
  if (external?.aborted) cancel()
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); external?.removeEventListener('abort', cancel) } }
}

export async function processingDelay(ms: number, signal: AbortSignal): Promise<void> {
  checkProcessingAbort(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function readProcessorBytes(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  checkProcessingAbort(signal)
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel()
    throw new ProcessorError('output_too_large', 'MinerU response exceeds the configured safety limit.')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      checkProcessingAbort(signal)
      const { done, value } = await reader.read()
      checkProcessingAbort(signal)
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new ProcessorError('output_too_large', 'MinerU response exceeds the configured safety limit.')
      pieces.push(value)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength }
  return bytes
}

export interface ProcessorRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: Uint8Array | string
  maxBytes?: number
  allowRedirects?: boolean
  /** A transport failure cannot prove that this side effect did not occur. */
  ambiguousSubmission?: boolean
  missingJob?: boolean
}

export class ProcessorTransport {
  readonly base: URL
  constructor(apiUrl: string, private readonly apiKey: string | undefined, readonly signal: AbortSignal) {
    this.base = processorUrl(apiUrl.replace(/\/+$/, '') + '/')
    if (this.base.search) throw new ProcessorError('invalid_config', 'The MinerU service URL must not include a query.')
    if (apiKey && /[\r\n]/.test(apiKey)) throw new ProcessorError('invalid_config', 'Invalid MinerU authentication configuration.')
  }

  endpoint(path: string): URL { return processorUrl(path.replace(/^\//, ''), this.base) }

  async bytes(target: URL, options: ProcessorRequest = {}): Promise<Uint8Array> {
    let url = target
    const originalOrigin = target.origin
    for (let redirect = 0; redirect <= 4; redirect++) {
      checkProcessingAbort(this.signal)
      const headers = new Headers(url.origin === originalOrigin ? options.headers : undefined)
      // Never propagate service credentials to a storage host, including another port.
      if (url.origin === this.base.origin && this.apiKey) headers.set('authorization', `Bearer ${this.apiKey}`)
      let response: Response
      try {
        response = await fetch(url, {
          method: options.method ?? 'GET', headers,
          body: options.body as BodyInit | undefined, redirect: 'manual', signal: this.signal,
        })
      } catch {
        checkProcessingAbort(this.signal)
        throw new ProcessorError(options.ambiguousSubmission ? 'submission_unknown' : 'network_error',
          options.ambiguousSubmission ? 'MinerU submission outcome is unknown; it was not retried automatically.' : 'The MinerU service could not be reached.')
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!options.allowRedirects || (options.method && options.method !== 'GET') || !location || redirect === 4) {
          throw new ProcessorError('invalid_response', 'Unexpected MinerU redirect.')
        }
        const next = processorUrl(location, url)
        if (url.protocol === 'https:' && next.protocol !== 'https:') throw new ProcessorError('invalid_response', 'Refused an insecure artifact redirect.')
        url = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        const code = response.status === 404 && options.missingJob ? 'job_lost' :
          response.status === 401 || response.status === 403 ? 'authentication_error' : 'provider_error'
        throw new ProcessorError(code, code === 'job_lost' ? 'MinerU no longer knows this job. The service may have restarted; explicitly reparse to submit a replacement.' : `MinerU returned HTTP ${response.status}.`)
      }
      try { return await readProcessorBytes(response, options.maxBytes ?? 2 * 1024 * 1024, this.signal) }
      catch (error) {
        checkProcessingAbort(this.signal)
        if (error instanceof ProcessorError) throw error
        throw new ProcessorError(options.ambiguousSubmission ? 'submission_unknown' : 'network_error', 'The MinerU response body could not be read completely.')
      }
    }
    throw new ProcessorError('invalid_response', 'Too many artifact redirects.')
  }

  async json(path: string, options: ProcessorRequest = {}): Promise<Record<string, unknown>> {
    const bytes = await this.bytes(this.endpoint(path), options)
    let result: unknown
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new ProcessorError(options.ambiguousSubmission ? 'submission_unknown' : 'invalid_response', 'MinerU returned invalid JSON.') }
    return object(result)
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ProcessorError('invalid_response', 'MinerU returned an invalid object.')
  return value as Record<string, unknown>
}

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new ProcessorError('invalid_response', 'MinerU returned an invalid resource identifier.')
  return value
}

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || !value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 100)) {
    throw new ProcessorError('invalid_response', 'MinerU returned an invalid capability list.')
  }
  return [...new Set(value as string[])]
}
