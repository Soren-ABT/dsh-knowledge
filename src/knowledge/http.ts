/**
 * JSON HTTP surface for the knowledge service, served on the same origin as
 * the browser panel at `/knowledge/*`. Responses use a uniform envelope:
 * `{ ok: true, value }` on success, `{ ok: false, error: { code, message } }`
 * on failure.
 * @module dsh-knowledge/knowledge/http
 */

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ConflictError, DirectorySourceError, NotFoundError, StorageUnavailableError, type KnowledgeService } from './index.js'
import type { ConfigOverrides } from './domain.js'
import { EvidenceRequestError } from './evidence.js'
import { DeploymentError } from './mineru-deployment-plan.js'
import { requireLocalManagement } from './mineru-management-security.js'
import type {
  AddFileDocumentRequest,
  AddFilesItem,
  AddFilesRequest,
  AddTextDocumentRequest,
  BaseConfig,
  CreateBaseRequest,
  EmbeddingProvider,
  ImportUrlRequest,
  SearchRequest,
  UpdateBaseRequest,
} from './types.js'

/** Headroom for a base64 file upload plus envelope. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

export function knowledgeRoute(service: KnowledgeService): WebRoute {
  return {
    kind: 'prefix',
    path: '/knowledge',
    handler: (req, res) => { void handleRequest(service, req, res) },
  }
}

async function handleRequest(service: KnowledgeService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await service.whenReady()
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const pathname = url.pathname
    const rel = pathname.slice('/knowledge'.length)
    // Decode path segments so an encoded id (`%2F` in a filename, UTF-8 ids)
    // resolves to the same string the JSON API uses. A decoded segment is
    // never used as a filesystem path — only as a store key.
    const segments = rel.split('/').filter(Boolean).map(segment => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    const method = (req.method ?? 'GET').toUpperCase()

    if (segments[0] === 'processors' && segments[1] === 'managed') requireLocalManagement(req, service.managementBindHost)

    const body = method === 'GET' ? undefined : await readJson(req)
    const value = await route(service, method, segments, body ?? {}, url.searchParams)
    if (value === undefined) {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route for ${method} ${pathname}` } })
      return
    }
    if (isRawDownload(value)) {
      const { bytes, fileName, mimeType, inline } = value
      res.writeHead(200, {
        'content-type': mimeType ?? 'application/octet-stream',
        'content-disposition': inline === true
          ? `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`
          : `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'content-length': String(bytes.byteLength),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-security-policy': "sandbox; default-src 'none'",
      })
      res.end(Buffer.from(bytes))
      return
    }
    writeJson(res, 200, { ok: true, value })
  } catch (error) {
    if (error instanceof DeploymentError) {
      writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
      return
    }
    if (error instanceof EvidenceRequestError) {
      writeJson(res, error.code === 'not_found' ? 404 : 400, { ok: false, error: { code: error.code, message: error.message } })
      return
    }
    // Same-name conflicts surface as 409 so callers can re-submit with a
    // conflict strategy instead of treating the import as a server error.
    if (error instanceof ConflictError) {
      writeJson(res, 409, { ok: false, error: { code: 'conflict', message: error.message } })
      return
    }
    // A named entity that does not exist is a caller mistake, not a server
    // failure: 404 keeps it distinct from the 5xx bucket (and from the empty
    // success a filtered summary would have produced).
    if (error instanceof NotFoundError) {
      writeJson(res, 404, { ok: false, error: { code: 'not_found', message: error.message } })
      return
    }
    if (error instanceof DirectorySourceError) {
      writeJson(res, 409, {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      })
      return
    }
    if (error instanceof StorageUnavailableError) {
      // The durable backend exists but could not be opened. Answer 503 with the
      // real cause so a caller never reads this as "the library is empty".
      writeJson(res, 503, { ok: false, error: { code: 'storage_unavailable', message: error.message } })
      return
    }
    if (error instanceof InvalidRequestError) {
      writeJson(res, 400, { ok: false, error: { code: 'invalid_request', message: error.message } })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    writeJson(res, 500, { ok: false, error: { code: 'error', message } })
  }
}

/** Marker for a binary download response (the raw-file route). */
interface RawDownload {
  rawDownload: true
  bytes: Uint8Array
  fileName: string
  mimeType?: string
  /** Serve with `Content-Disposition: inline` for in-panel embedding. */
  inline?: boolean
}

function isRawDownload(value: unknown): value is RawDownload {
  return typeof value === 'object' && value !== null && (value as RawDownload).rawDownload === true
}

async function route(
  service: KnowledgeService,
  method: string,
  segments: string[],
  body: Record<string, unknown>,
  query: URLSearchParams,
): Promise<unknown | undefined> {
  // /config
  if (segments[0] === 'processors' && segments[1] === 'managed' && segments.length === 3) {
    const action = segments[2]
    if (action === 'status' && method === 'GET') return service.mineruDeployment.status()
    if (method === 'POST') {
      if (action === 'python') {
        if (body.executable !== undefined && typeof body.executable !== 'string') throw new InvalidRequestError('executable must be a Python path')
        return service.mineruDeployment.pythonEnvironments(body.executable as string | undefined)
      }
      if (action === 'prepare') {
        if (typeof body.planId !== 'string' || body.confirm !== true) throw new InvalidRequestError('planId and explicit confirm:true are required')
        return service.mineruDeployment.prepare(body.planId)
      }
      if (action === 'cancel') return service.mineruDeployment.cancel()
      if (action === 'start') return service.mineruDeployment.start()
      if (action === 'stop') return service.mineruDeployment.stop()
      if (action === 'use') {
        await service.setConfig({ ...service.mineruDeployment.connection(), documentProcessorProvider: 'mineru-local', mineruTier: 'basic' })
        return { applied: true }
      }
    }
  }
  if (segments.join('/') === 'processors/managed/plan' && method === 'POST') {
    if (typeof body.root !== 'string' || (body.existingModels !== undefined && typeof body.existingModels !== 'string')) throw new InvalidRequestError('root and existingModels must be directory paths')
    if (body.pythonExecutable !== undefined && typeof body.pythonExecutable !== 'string') throw new InvalidRequestError('pythonExecutable must be a Python path')
    const config = service.getConfig()
    return service.mineruDeployment.preflight({ root: body.root, existingModels: body.existingModels as string | undefined, pythonExecutable: body.pythonExecutable as string | undefined, hfEndpoint: config.hfEndpoint, pythonIndexUrl: config.mineruPythonIndexUrl })
  }
  if (segments[0] === 'config') {
    if (method === 'GET') return service.getConfig()
    if (method === 'PUT') return service.setConfig(body as ConfigOverrides)
    return undefined
  }

  if (segments[0] === 'processors' && segments[1] === 'check' && segments.length === 2 && method === 'POST') {
    if (body.baseId !== undefined && typeof body.baseId !== 'string') throw new InvalidRequestError('baseId must be a string')
    return service.checkProcessor(body.baseId as string | undefined)
  }

  // /knowledge-toggle (invocation on/off + pinned base scope)
  if (segments[0] === 'knowledge-toggle') {
    if (method === 'GET') {
      return { enabled: service.isEnabled(), enabledBaseIds: service.getEnabledBaseIds() }
    }
    if (method === 'PUT') {
      if (typeof body.enabled === 'boolean') await service.setEnabled(body.enabled)
      if (Array.isArray(body.enabledBaseIds)) {
        await service.setEnabledBaseIds(body.enabledBaseIds.filter((id): id is string => typeof id === 'string'))
      }
      return { enabled: service.isEnabled(), enabledBaseIds: service.getEnabledBaseIds() }
    }
    return undefined
  }

  // /groups
  if (segments[0] === 'groups') {
    if (method === 'GET') return service.listGroups()
    if (method === 'POST') return service.createGroup(typeof body.name === 'string' ? body.name : '')
    if (method === 'PATCH') {
      return service.renameGroup(
        typeof body.from === 'string' ? body.from : '',
        typeof body.to === 'string' ? body.to : '',
      )
    }
    if (method === 'DELETE') {
      return service.deleteGroup(typeof body.name === 'string' ? body.name : '').then(() => ({ deleted: true }))
    }
    return undefined
  }

  // /stats
  if (segments[0] === 'stats' && method === 'GET') return service.stats()

  // /local-model-status?model=...
  if (segments[0] === 'local-model-status' && method === 'GET') {
    return service.getLocalModelStatus(query.get('model') ?? undefined)
  }

  // /probe-embedding-dimensions — embed one probe text and return the vector
  // width (Cherry's dimension probe, run before a config save).
  if (segments[0] === 'probe-embedding-dimensions' && method === 'POST') {
    return service.probeEmbeddingDimensions({
      ...(typeof body.provider === 'string' ? { provider: body.provider as EmbeddingProvider } : {}),
      ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
    })
  }

  // /local-models (list) and /local-models/download|remove|cancel?model=...
  if (segments[0] === 'local-models') {
    if (method === 'GET') return service.listLocalModels()
    if (segments[1] === 'custom' && method === 'POST') {
      return service.registerCustomLocalReranker(typeof body.id === 'string' ? body.id : '')
    }
    if (segments[1] === 'self-test' && method === 'POST') {
      return service.selfTestLocalModel(typeof body.id === 'string' ? body.id : '')
    }
    if (segments[1] === 'download' && method === 'POST') {
      return service.downloadLocalModel(query.get('model') ?? '')
    }
    if (segments[1] === 'cancel' && method === 'POST') {
      return service.cancelLocalModel(query.get('model') ?? '')
    }
    if (segments[1] === 'remove' && method === 'DELETE') {
      return service.deleteLocalModel(query.get('model') ?? '')
    }
    if (segments[1] === 'migrate' && method === 'POST') {
      return service.migrateLocalModels(typeof body.to === 'string' ? body.to : '')
    }
    return undefined
  }

  // /local-ocr (status/download/remove) — scanned-PDF OCR models
  if (segments[0] === 'local-ocr') {
    if (method === 'GET' && segments.length === 1) return service.getOcrStatus()
    if (segments[1] === 'download' && method === 'POST') return service.downloadOcr()
    if (segments[1] === 'remove' && method === 'DELETE') return service.deleteOcr()
    return undefined
  }

  // /local-ollama (pull/tags/status) — Ollama model management
  if (segments[0] === 'local-ollama') {
    if (segments[1] === 'tags' && method === 'GET') {
      return { models: await service.listOllamaModels(typeof query.get('baseUrl') === 'string' ? query.get('baseUrl')! : '') }
    }
    if (segments[1] === 'pull' && method === 'POST') {
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (model === '') throw new Error('ollama model name is empty')
      // Fire-and-forget with status polling (same posture as local models).
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
      void service.pullOllamaModel(model, baseUrl).catch(() => {})
      return { started: true }
    }
    if (segments[1] === 'pull' && method === 'DELETE') {
      const model = query.get('model') ?? ''
      if (model === '') throw new Error('ollama model name is empty')
      service.cancelOllamaPull(model)
      return { cancelled: true }
    }
    if (segments[1] === 'delete' && method === 'DELETE') {
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (model === '') throw new Error('ollama model name is empty')
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
      await service.deleteOllamaModel(model, baseUrl)
      return { deleted: true }
    }
    if (segments[1] === 'status' && method === 'GET') {
      return service.getOllamaPullStatus(query.get('model') ?? '')
    }
    if (segments[1] === 'pulls' && method === 'GET') {
      return { pulls: service.activeOllamaPulls() }
    }
    return undefined
  }

  // /model-suggestions
  if (segments[0] === 'model-suggestions' && method === 'GET') {
    return service.modelSuggestions()
  }

  // /indexing-status
  if (segments[0] === 'indexing-status' && method === 'GET') {
    return service.indexingStatus()
  }

  // /import-directory/:jobId (status) and /import-directory/:jobId/cancel
  if (segments[0] === 'import-directory' && segments.length >= 2) {
    const jobId = segments[1]
    if (method === 'GET') return service.directoryImportStatus(jobId)
    if (segments[2] === 'cancel' && method === 'POST') {
      service.cancelDirectoryImport(jobId)
      return { cancelled: true }
    }
    return undefined
  }

  // /reindex/:jobId (status) and /reindex/:jobId/cancel
  if (segments[0] === 'reindex' && segments.length >= 2) {
    const jobId = segments[1]
    if (method === 'GET') return service.reindexJobStatus(jobId)
    if (segments[2] === 'cancel' && method === 'POST') {
      service.cancelReindexJob(jobId)
      return { cancelled: true }
    }
    return undefined
  }

  // /bases
  if (segments[0] === 'bases') {
    if (segments.length === 1) {
      if (method === 'GET') return service.listBases()
      if (method === 'POST') {
        // Validate the two fields the service dereferences immediately: without
        // this, `{}` produced an internal `Cannot read properties of undefined`
        // TypeError reported as a 500 server fault.
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          throw new InvalidRequestError('createBase requires a non-empty "name"')
        }
        return service.createBase(body as unknown as CreateBaseRequest)
      }
      return undefined
    }
    const baseId = segments[1]
    if (segments.length === 2) {
      if (method === 'PATCH') return service.renameBase(baseId, body as unknown as UpdateBaseRequest)
      if (method === 'DELETE') return service.deleteBase(baseId).then(() => ({ deleted: true }))
      return undefined
    }
    if (segments.length === 3) {
      if (segments[2] === 'stats' && method === 'GET') return service.stats(baseId)
      if (segments[2] === 'reindex' && method === 'POST') return service.startReindexBase(baseId)
      if (segments[2] === 'files-batch' && method === 'POST') {
        const bodyRequest = body as Partial<AddFilesRequest>
        // A malformed body is a client mistake, not a missing endpoint: returning
        // `undefined` here fell through to the "no route" 404, which sends the
        // caller looking for the wrong problem.
        if (!Array.isArray(bodyRequest.files)) {
          throw new InvalidRequestError('files-batch requires a "files" array')
        }
        return service.addFiles({
          baseId,
          files: bodyRequest.files
            .filter((file): file is AddFilesItem => typeof file === 'object' && file !== null && typeof (file as AddFilesItem).fileName === 'string')
            .map(file => ({
              fileName: file.fileName,
              ...(typeof file.mimeType === 'string' ? { mimeType: file.mimeType } : {}),
              ...(typeof file.contentBase64 === 'string' ? { contentBase64: file.contentBase64 } : {}),
            })),
          ...(bodyRequest.conflict === 'rename' || bodyRequest.conflict === 'replace' || bodyRequest.conflict === 'detect'
            ? { conflict: bodyRequest.conflict }
            : {}),
          ...(typeof bodyRequest.parentDirectoryId === 'string' ? { parentDirectoryId: bodyRequest.parentDirectoryId } : {}),
        })
      }
      if (segments[2] === 'restore' && method === 'POST') {
        const config = typeof body.config === 'object' && body.config !== null
          ? body.config as BaseConfig
          : undefined
        return service.restoreBase(baseId, typeof body.name === 'string' ? body.name : '', config)
      }
      if (segments[2] === 'import-directory' && method === 'POST') {
        return service.importDirectory({ baseId, path: typeof body.path === 'string' ? body.path : '' })
      }
      if (segments[2] === 'import-directory-tree' && method === 'POST') {
        return service.importDirectoryTree(baseId, typeof body.path === 'string' ? body.path : '')
      }
      if (segments[2] === 'import-path' && method === 'POST') {
        return service.importFromPath(baseId, typeof body.path === 'string' ? body.path : '')
      }
      if (segments[2] === 'source-path' && method === 'POST') {
        return service.setBaseSourcePath(
          baseId,
          typeof body.sourceId === 'string' ? body.sourceId : '',
          typeof body.path === 'string' ? body.path : '',
        )
      }
      if (segments[2] === 'directories' && method === 'POST') {
        return service.createDirectory(
          baseId,
          typeof body.title === 'string' ? body.title : 'directory',
          typeof body.parentDirectoryId === 'string' ? body.parentDirectoryId : undefined,
        )
      }
      if (segments[2] === 'documents') {
        if (method === 'GET') return service.listDocuments(baseId)
        if (method === 'POST') {
          if (typeof body.url === 'string') {
            return service.addUrlDocument({
              baseId,
              url: body.url,
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(typeof body.parentDirectoryId === 'string' ? { parentDirectoryId: body.parentDirectoryId } : {}),
            } satisfies ImportUrlRequest)
          }
          const request = body as Partial<AddTextDocumentRequest & AddFileDocumentRequest>
          if (typeof request.contentBase64 === 'string') {
            const conflict = body.conflict
            return service.addFileDocument({
              baseId,
              fileName: typeof body.fileName === 'string' ? body.fileName : 'document',
              ...(typeof body.mimeType === 'string' ? { mimeType: body.mimeType } : {}),
              ...(typeof body.title === 'string' ? { title: body.title } : {}),
              ...(conflict === 'keep' || conflict === 'replace' || conflict === 'rename' || conflict === 'detect'
                ? { conflict: conflict as 'keep' | 'replace' | 'rename' | 'detect' }
                : {}),
              ...(typeof body.parentDirectoryId === 'string' ? { parentDirectoryId: body.parentDirectoryId } : {}),
              contentBase64: request.contentBase64,
            })
          }
          return service.addTextDocument({
            baseId,
            title: typeof body.title === 'string' ? body.title : 'untitled',
            content: typeof body.content === 'string' ? body.content : '',
            ...(typeof body.parentDirectoryId === 'string' ? { parentDirectoryId: body.parentDirectoryId } : {}),
          })
        }
      }
    }
    return undefined
  }

  // /documents/:id (and sub-resources) + bulk routes
  if (segments[0] === 'documents') {
    if (segments.length === 1) {
      if (method === 'DELETE') return service.deleteDocuments(readIds(body), { recursive: body.recursive === true })
      return undefined
    }
    if (segments.length === 2 && segments[1] === 'reindex' && method === 'POST') {
      return service.reindexDocuments(readIds(body))
    }
    const documentId = segments[1]
    if (segments.length === 4 && segments[2] === 'artifacts' && method === 'GET') {
      const revision = query.get('revision')
      if (revision === null || revision === '') throw new InvalidRequestError('evidence revision is required')
      return { rawDownload: true, inline: true, ...await service.getEvidenceAsset(documentId, segments[3]!, revision) } satisfies RawDownload
    }
    if (segments.length === 2) {
      if (method === 'GET') {
        const rawTextLimit = readIntQuery(query, 'rawTextLimit')
        const includeChunks = query.get('includeChunks') !== 'false'
        return service.getDocument(documentId, {
          includeChunks,
          ...(rawTextLimit !== undefined ? { rawTextLimit } : {}),
        })
      }
      if (method === 'PATCH') return service.renameDocument(documentId, typeof body.title === 'string' ? body.title : '')
      if (method === 'DELETE') {
        return service.deleteDocument(documentId, { recursive: query.get('recursive') === 'true' || body.recursive === true })
          .then(() => ({ deleted: true }))
      }
      return undefined
    }
    if (segments.length === 3) {
      if (segments[2] === 'cancel' && method === 'POST') return service.cancelProcessing(documentId)
      if (segments[2] === 'evidence' && method === 'GET') {
        const pageIndex = strictIntQuery(query, 'pageIndex', 0, 100_000)
        const blockOffset = strictIntQuery(query, 'blockOffset', 0, 32 * 1024 * 1024)
        const maxTokens = strictIntQuery(query, 'maxTokens', 128, 4096)
        const blockId = query.get('blockId') ?? undefined
        if (blockOffset !== undefined && blockId === undefined) throw new InvalidRequestError('blockOffset requires blockId')
        return service.readDocumentEvidence(documentId, { revision: query.get('revision') ?? undefined, pageIndex, blockId, blockOffset, maxTokens })
      }
      if (segments[2] === 'chunks' && method === 'GET') {
        // Every chunk carries its embedding vector (1024 floats by default, so
        // megabytes per document), and the panel's preview never reads it.
        // `includeEmbeddings=false` drops it from the payload; the default keeps
        // the historical shape for existing callers.
        const withEmbeddings = query.get('includeEmbeddings') !== 'false'
        return service
          .listChunks(documentId, readIntQuery(query, 'limit'), readIntQuery(query, 'offset'))
          .map(chunk => withEmbeddings ? chunk : (({ embedding: _embedding, ...rest }) => rest)(chunk))
      }
      if (segments[2] === 'reindex' && method === 'POST') {
        if (body.mode !== undefined && body.mode !== 'reparse' && body.mode !== 'rechunk') throw new InvalidRequestError('mode must be reparse or rechunk')
        return service.reindexDocument(documentId, { mode: body.mode as 'reparse' | 'rechunk' | undefined })
      }
      if (segments[2] === 'delete-impact' && method === 'GET') return service.getDeleteImpact(documentId)
      if (segments[2] === 'refresh' && method === 'POST') return service.refreshUrlDocument(documentId)
      if (segments[2] === 'raw' && method === 'GET') {
        const raw = await service.getRawFile(documentId)
        if (raw === undefined) return undefined
        // `?inline=1` serves the bytes for in-panel embedding (Cherry's file
        // preview); the default stays an attachment download.
        return { rawDownload: true, inline: query.get('inline') === '1', ...raw }
      }
    }
    return undefined
  }

  // /search
  if (segments[0] === 'search' && method === 'POST') {
    // `request.query.trim()` is the service's first statement; an absent query
    // used to surface as an internal TypeError reported as a 500.
    if (typeof body.query !== 'string' || body.query.trim() === '') {
      throw new InvalidRequestError('search requires a non-empty "query"')
    }
    if (body.filter !== undefined) {
      if (typeof body.filter !== 'object' || body.filter === null || Array.isArray(body.filter)) {
        throw new InvalidRequestError('filter must be an object')
      }
      const filter = body.filter as Record<string, unknown>
      for (const key of ['excludeDocIds', 'titleExcludes'] as const) {
        const value = filter[key]
        if (value !== undefined && (!Array.isArray(value) || !value.every(item => typeof item === 'string'))) {
          throw new InvalidRequestError(`filter.${key} must be an array of strings`)
        }
      }
    }
    return service.search(body as unknown as SearchRequest)
  }

  return undefined
}

/** A client mistake: a malformed body, a bad content type, an id-less batch. It
 *  is mapped to 400 so a caller's error is not reported as a server fault (and
 *  does not count as a 5xx in monitoring). */
export class InvalidRequestError extends Error {
  readonly code = 'invalid_request'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequestError'
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === '') return {}
  if (mediaType !== 'application/json') throw new InvalidRequestError('content type must be application/json')
  const text = await readBody(req)
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new InvalidRequestError('body is not valid JSON')
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new InvalidRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readIds(body: Record<string, unknown>): string[] {
  return Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
}

function readIntQuery(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? Math.trunc(value) : undefined
}

function strictIntQuery(query: URLSearchParams, key: string, min: number, max: number): number | undefined {
  const raw = query.get(key)
  if (raw === null) return undefined
  const value = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) throw new InvalidRequestError(`invalid ${key}`)
  return value
}
