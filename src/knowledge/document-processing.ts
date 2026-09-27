import { createHash } from 'node:crypto'
import type { ArtifactRepository, ProcessingJobRecord } from './artifacts.js'
import type { KnowledgeConfig } from './types.js'
import type { DocumentProcessingInfo, ParsedDocument, ProcessingOutput, ProcessingProgress, ProcessingWarning } from './processing-types.js'
import { extensionOf, parseDocumentBuffer } from './parse.js'
import { extractPdfWithMineru } from './mineru.js'
import { extractWithMineruLocal } from './mineru-local.js'
import { parsedTextDocument } from './parsed-document.js'

export interface ProcessedFile {
  readonly text: string
  readonly parsed: ParsedDocument
  readonly processing: DocumentProcessingInfo
}

export function processorFingerprint(config: KnowledgeConfig): string {
  // Credentials are neither persisted nor used as an artifact identity.
  return hash(JSON.stringify({
    version: 1, provider: config.documentProcessorProvider,
    host: config.documentProcessorProvider === 'mineru-local' ? config.mineruLocalUrl : config.mineruApiHost,
    tier: config.mineruTier ?? 'basic',
    caption: { provider: config.imageCaptionProvider, model: config.imageCaptionModel, host: config.imageCaptionBaseUrl },
  }))
}

function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }

export function processorErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'canceled'
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(code) ? code : 'processing_failed'
}

/** Do not copy upstream response bodies/URLs/tokens into persisted diagnostics. */
export function processorErrorMessage(error: unknown): string {
  const code = processorErrorCode(error)
  if (code === 'parse_failed') return 'MinerU extraction failed (provider unavailable); local parsing failed (parse_failed); check the document processor settings'
  return `document processor failed (${code}); check processor configuration and service health`
}

export interface ProcessFileInput {
  readonly baseId: string
  readonly documentId: string
  readonly fileName: string
  readonly mimeType?: string
  readonly bytes: Uint8Array
  readonly config: KnowledgeConfig
  readonly artifacts: ArtifactRepository
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: ProcessingProgress) => void
  /** Startup-only recovery, never silently reuse artifacts for explicit reparse. */
  readonly resume?: boolean
}

/** All file entry points use this function. Cloud is only contacted when the
 * user explicitly selected the legacy cloud provider (never as local fallback). */
export async function processDocumentFile(input: ProcessFileInput): Promise<ProcessedFile> {
  input.signal?.throwIfAborted()
  const { config, bytes, artifacts, baseId, documentId } = input
  const sourceHash = hash(bytes)
  const fingerprint = processorFingerprint(config)
  const previous = input.resume ? await artifacts.getJob(baseId, documentId) : undefined
  const matching = previous?.sourceHash === sourceHash && previous.fingerprint === fingerprint ? previous : undefined
  if (matching?.state === 'completed' && matching.artifact !== undefined) {
    const parsed = await artifacts.load(baseId, documentId, matching.artifact)
    return { text: parsed.text, parsed, processing: { ...matching.artifact, reused: true } }
  }
  if (matching?.errorCode === 'submission_unknown') throw Object.assign(new Error('previous submission outcome is unknown; explicitly reparse to retry'), { code: 'submission_unknown' })
  let job: ProcessingJobRecord = {
    version: 1, baseId, documentId, sourceHash, fingerprint, state: 'running',
    progress: { stage: 'checking' }, updatedAt: Date.now(),
  }
  await artifacts.saveJob(job)
  let progressWrite: Promise<void> = Promise.resolve()
  const progress = (value: ProcessingProgress): void => {
    const retainedId = value.jobId ?? job.progress.jobId ?? matching?.progress.jobId
    job = { ...job, progress: { ...value, ...(retainedId !== undefined ? { jobId: retainedId } : {}) }, updatedAt: Date.now() }
    // Keep the external id even after download/normalization stage events.
    const snapshot = job
    progressWrite = progressWrite.then(() => artifacts.saveJob(snapshot))
    void progressWrite.catch(() => {})
    input.onProgress?.(value)
  }
  const warnings: ProcessingWarning[] = []
  try {
    let output: ProcessingOutput | undefined
    let remoteFailure: unknown
    const pdf = extensionOf(input.fileName) === 'pdf'
    if (pdf && config.documentProcessorProvider === 'mineru-local') {
      try {
        output = await extractWithMineruLocal(bytes, input.fileName, {
          apiUrl: config.mineruLocalUrl ?? 'http://127.0.0.1:8000',
          apiKey: config.mineruLocalApiKey,
          tier: config.mineruTier ?? 'basic',
          timeoutMs: config.documentProcessingTimeoutMs ?? 1_800_000,
        }, {
          signal: input.signal, onProgress: progress,
          ...(matching?.state === 'running' && matching.progress.jobId !== undefined ? { resumeJobId: matching.progress.jobId } : {}),
        })
      } catch (error) {
        input.signal?.throwIfAborted()
        if (['job_lost', 'submission_unknown'].includes(processorErrorCode(error))) throw error
        remoteFailure = error
      }
    } else if (pdf && config.documentProcessorProvider === 'mineru') {
      if (config.mineruApiKey.trim() === '') {
        remoteFailure = Object.assign(new Error('MinerU cloud requires a key'), { code: 'configuration_missing' })
      } else {
        try {
          progress({ stage: 'parsing' })
          const text = await extractPdfWithMineru(bytes, input.fileName, { apiHost: config.mineruApiHost, apiKey: config.mineruApiKey }, input.signal)
          output = parsedTextDocument(text, bytes, 'mineru', fingerprint)
        } catch (error) { input.signal?.throwIfAborted(); remoteFailure = error }
      }
    }
    if (output === undefined) {
      if (remoteFailure !== undefined) warnings.push({ code: 'processor_fallback', message: `${processorErrorMessage(remoteFailure)}; used built-in local parsing` })
      progress({ stage: 'parsing' })
      try {
        const text = await parseDocumentBuffer(bytes, input.fileName, input.mimeType)
        input.signal?.throwIfAborted()
        output = parsedTextDocument(text, bytes, 'builtin', fingerprint, warnings)
      } catch (error) {
        input.signal?.throwIfAborted()
        if (remoteFailure !== undefined) throw Object.assign(new Error(`MinerU extraction failed (${processorErrorCode(remoteFailure)}); local parsing failed (${processorErrorCode(error)})`), { code: 'parse_failed' })
        throw error
      }
    }
    if (!output.document.text.trim()) throw Object.assign(new Error('parsed document is empty'), { code: 'empty_result' })
    // Captioning remains opt-in, but now runs identically on import and reparse.
    if (pdf && config.imageCaptionProvider !== 'off') {
      try {
        const { captionPdfImages } = await import('./caption.js')
        input.signal?.throwIfAborted()
        const caption = await captionPdfImages(bytes, {
          provider: config.imageCaptionProvider, model: config.imageCaptionModel,
          baseUrl: config.imageCaptionBaseUrl, apiKey: config.imageCaptionApiKey,
          embeddingBaseUrl: config.embeddingBaseUrl,
        })
        input.signal?.throwIfAborted()
        if (caption.trim()) {
          const start = output.document.text.length + 2
          output = { ...output, document: { ...output.document,
            text: `${output.document.text}\n\n${caption}`,
            blocks: [...output.document.blocks, { id: 'generated-caption', index: output.document.blocks.length, type: 'caption', text: caption, textStart: start, textEnd: start + caption.length }],
            warnings: [...output.document.warnings, { code: 'generated_caption', message: 'Image descriptions are model-generated, not verbatim source text.' }],
          } }
        }
      } catch (error) {
        input.signal?.throwIfAborted()
        output = { ...output, document: { ...output.document, warnings: [...output.document.warnings, { code: 'caption_failed', message: processorErrorMessage(error) }] } }
      }
    }
    input.signal?.throwIfAborted()
    output = { ...output, document: { ...output.document, optionsFingerprint: fingerprint } }
    progress({ stage: 'normalizing' })
    await progressWrite
    const processing = await artifacts.save(baseId, documentId, output)
    input.signal?.throwIfAborted()
    await artifacts.saveJob({ ...job, state: 'completed', artifact: processing, progress: { stage: 'completed' }, updatedAt: Date.now() })
    return { text: output.document.text, parsed: output.document, processing }
  } catch (error) {
    await progressWrite.catch(() => {})
    const canceled = input.signal?.aborted === true
    await artifacts.saveJob({ ...job, state: canceled ? 'canceled' : 'failed', errorCode: processorErrorCode(error), progress: { ...job.progress, stage: canceled ? 'canceled' : 'failed' }, updatedAt: Date.now() }).catch(() => {})
    throw error
  }
}
