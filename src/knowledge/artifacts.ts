import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm, stat, readdir } from 'node:fs/promises'
import { resolve, relative, join, isAbsolute } from 'node:path'
import type { DocumentProcessingInfo, ParsedDocument, ProcessingOutput, ProcessingProgress } from './processing-types.js'

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_ASSET_BYTES = 32 * 1024 * 1024
const MAX_RESULT_BYTES = 128 * 1024 * 1024
const component = (value: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('invalid artifact identity')
  return value
}
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

interface Manifest {
  readonly version: 1
  readonly baseId: string
  readonly documentId: string
  readonly info: DocumentProcessingInfo
  readonly documentHash: string
}

export interface ProcessingJobRecord {
  readonly version: 1
  readonly baseId: string
  readonly documentId: string
  readonly sourceHash: string
  readonly fingerprint: string
  readonly state: 'running' | 'completed' | 'failed' | 'canceled'
  readonly progress: ProcessingProgress
  readonly updatedAt: number
  readonly artifact?: DocumentProcessingInfo
  readonly errorCode?: string
  /** Durable count incremented before each automatic startup parse attempt. */
  readonly startupAttempts?: number
}

/** Immutable artifacts scoped to one document. No downloaded paths are used as
 * filesystem names: asset ids select bounded blobs through a manifest. */
export class ArtifactRepository {
  private readonly memory = new Map<string, { manifest: Manifest; output: ProcessingOutput }>()
  private readonly memoryJobs = new Map<string, ProcessingJobRecord>()
  private readonly jobWrites = new Map<string, Promise<void>>()
  private readonly deleted = new Set<string>()
  private readonly saves = new Map<string, Set<Promise<unknown>>>()
  constructor(private readonly root?: string) {}

  private key(baseId: string, documentId: string, revision?: string): string {
    return [component(baseId), component(documentId), ...(revision !== undefined ? [component(revision)] : [])].join('/')
  }

  private path(key: string): string {
    if (this.root === undefined) throw new Error('artifact storage is in memory')
    const root = resolve(this.root)
    const target = resolve(root, key)
    const rel = relative(root, target)
    if (rel === '' || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) throw new Error('unsafe artifact path')
    return target
  }

  async save(baseId: string, documentId: string, output: ProcessingOutput): Promise<DocumentProcessingInfo> {
    const key = this.key(baseId, documentId)
    if (this.deleted.has(key) || this.deleted.has(baseId)) return Promise.reject(new Error('artifact target deleted'))
    const operation = this.saveRevision(baseId, documentId, output)
    const active = this.saves.get(key) ?? new Set<Promise<unknown>>()
    active.add(operation)
    this.saves.set(key, active)
    void operation.finally(() => { active.delete(operation); if (!active.size) this.saves.delete(key) }).catch(() => {})
    return operation
  }

  private async saveRevision(baseId: string, documentId: string, output: ProcessingOutput): Promise<DocumentProcessingInfo> {
    const revision = randomUUID()
    const key = this.key(baseId, documentId, revision)
    const parsed = JSON.stringify(output.document)
    if (Buffer.byteLength(parsed) > MAX_MANIFEST_BYTES) throw new Error('parsed document exceeds artifact limit')
    const info: DocumentProcessingInfo = {
      revision, artifactId: key, sourceHash: output.document.sourceHash,
      provider: output.document.provider, processorVersion: output.document.processorVersion,
      optionsFingerprint: output.document.optionsFingerprint, parsedAt: Date.now(),
      completeness: output.document.completeness, pageCount: output.document.pageCount,
      processedPages: output.document.processedPages, warnings: output.document.warnings,
    }
    const manifest: Manifest = { version: 1, baseId, documentId, info, documentHash: digest(parsed) }
    const assets = new Map(output.assets.map(asset => [component(asset.id), asset.bytes]))
    if (assets.size !== output.assets.length || assets.size !== output.document.assets.length) throw new Error('artifact asset count mismatch')
    for (const asset of output.document.assets) {
      const bytes = assets.get(component(asset.id))
      if (bytes === undefined || bytes.byteLength !== asset.byteLength || bytes.byteLength > MAX_ASSET_BYTES || digest(bytes) !== asset.sha256) throw new Error('artifact asset integrity mismatch')
    }
    if ((output.originalResult?.byteLength ?? 0) > MAX_RESULT_BYTES) throw new Error('processor result exceeds archive limit')
    if (this.root === undefined) {
      this.memory.set(key, { manifest, output: structuredClone(output) })
      return info
    }
    const candidate = this.path(`${key}.pending`)
    const target = this.path(key)
    await mkdir(candidate, { recursive: true })
    try {
      await writeFile(join(candidate, 'document.json'), parsed, { flag: 'wx' })
      for (const [id, bytes] of assets) await writeFile(join(candidate, `${id}.blob`), bytes, { flag: 'wx' })
      if (output.originalResult !== undefined) await writeFile(join(candidate, 'upstream.zip'), output.originalResult, { flag: 'wx' })
      // Manifest last. A crashed candidate can never be mistaken for a ready revision.
      await writeFile(join(candidate, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' })
      await rename(candidate, target)
      return info
    } catch (error) {
      await rm(candidate, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  private async boundedRead(path: string, maxBytes: number): Promise<Buffer> {
    const size = (await stat(path)).size
    if (size > maxBytes) throw new Error('artifact exceeds read limit')
    const bytes = await readFile(path)
    if (bytes.byteLength > maxBytes) throw new Error('artifact exceeds read limit')
    return bytes
  }

  async load(baseId: string, documentId: string, info: DocumentProcessingInfo): Promise<ParsedDocument> {
    const key = this.key(baseId, documentId, info.revision)
    if (info.artifactId !== key) throw new Error('artifact does not belong to document')
    if (this.root === undefined) {
      const value = this.memory.get(key)
      if (value === undefined) throw new Error('processing artifact is missing; reparse the source')
      return structuredClone(value.output.document)
    }
    const dir = this.path(key)
    const manifest = JSON.parse((await this.boundedRead(join(dir, 'manifest.json'), 1024 * 1024)).toString()) as Manifest
    if (manifest.version !== 1 || manifest.baseId !== baseId || manifest.documentId !== documentId || manifest.info.revision !== info.revision) throw new Error('invalid artifact manifest')
    const bytes = await this.boundedRead(join(dir, 'document.json'), MAX_MANIFEST_BYTES)
    if (digest(bytes) !== manifest.documentHash) throw new Error('artifact checksum mismatch')
    const parsed = JSON.parse(bytes.toString()) as ParsedDocument
    if (parsed.schemaVersion !== 1 || parsed.sourceHash !== info.sourceHash || !Array.isArray(parsed.blocks) || typeof parsed.text !== 'string') throw new Error('invalid parsed document')
    return parsed
  }

  async readAsset(baseId: string, documentId: string, info: DocumentProcessingInfo, assetId: string): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    component(assetId)
    const parsed = await this.load(baseId, documentId, info)
    const asset = parsed.assets.find(value => value.id === assetId)
    if (asset === undefined) return undefined
    // Active content (SVG/HTML) must never execute in the app's origin.
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(asset.mimeType)) throw new Error('unsupported evidence asset type')
    const key = this.key(baseId, documentId, info.revision)
    const bytes = this.root === undefined
      ? this.memory.get(key)?.output.assets.find(value => value.id === assetId)?.bytes
      : await this.boundedRead(join(this.path(key), `${assetId}.blob`), MAX_ASSET_BYTES)
    if (bytes === undefined || bytes.byteLength !== asset.byteLength || digest(bytes) !== asset.sha256) throw new Error('artifact asset checksum mismatch')
    return { bytes, mimeType: asset.mimeType }
  }

  async getJob(baseId: string, documentId: string): Promise<ProcessingJobRecord | undefined> {
    const key = this.key(baseId, documentId)
    await this.jobWrites.get(key)
    if (this.root === undefined) return this.memoryJobs.get(key)
    try {
      const job = JSON.parse((await this.boundedRead(this.path(`${key}/job.json`), 1024 * 1024)).toString()) as ProcessingJobRecord
      if (job.version !== 1 || job.baseId !== baseId || job.documentId !== documentId) throw new Error('invalid processing job')
      return job
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  saveJob(job: ProcessingJobRecord): Promise<void> {
    const key = this.key(job.baseId, job.documentId)
    if (this.deleted.has(key) || this.deleted.has(job.baseId)) return Promise.reject(new Error('artifact target deleted'))
    const write = (this.jobWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (this.root === undefined) { this.memoryJobs.set(key, job); return }
      await mkdir(this.path(key), { recursive: true })
      const candidate = this.path(`${key}/job-${randomUUID()}.tmp`)
      await writeFile(candidate, JSON.stringify(job), { flag: 'wx' })
      await rename(candidate, this.path(`${key}/job.json`))
    })
    this.jobWrites.set(key, write)
    void write.finally(() => { if (this.jobWrites.get(key) === write) this.jobWrites.delete(key) }).catch(() => {})
    return write
  }

  async deleteDocument(baseId: string, documentId: string): Promise<void> {
    const key = this.key(baseId, documentId)
    this.deleted.add(key)
    await Promise.allSettled([...(this.saves.get(key) ?? [])])
    await this.jobWrites.get(key)?.catch(() => {})
    this.memoryJobs.delete(key)
    for (const entry of this.memory.keys()) if (entry.startsWith(`${key}/`)) this.memory.delete(entry)
    if (this.root !== undefined) await rm(this.path(key), { recursive: true, force: true })
  }

  /** Startup-only GC. Live, staged and recoverable job revisions are pinned;
   * recent candidates are retained for seven days. Never follow symlinks. */
  async collectDocument(baseId: string, documentId: string, pinned: readonly string[], now = Date.now()): Promise<number> {
    if (this.root === undefined) return 0
    const key = this.key(baseId, documentId)
    const protectedRevisions = new Set(pinned)
    const job = await this.getJob(baseId, documentId)
    if (job?.artifact !== undefined) protectedRevisions.add(job.artifact.revision)
    let entries
    try { entries = await readdir(this.path(key), { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
    let removed = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9_-]+(?:\.pending)?$/.test(entry.name) || protectedRevisions.has(entry.name)) continue
      const path = this.path(`${key}/${entry.name}`)
      if ((await stat(path)).mtimeMs > now - 7 * 24 * 3600_000) continue
      await rm(path, { recursive: true, force: true })
      removed++
    }
    return removed
  }

  async deleteBase(baseId: string): Promise<void> {
    const prefix = `${component(baseId)}/`
    this.deleted.add(baseId)
    await Promise.allSettled([...this.saves].filter(([key]) => key.startsWith(prefix)).flatMap(([, pending]) => [...pending]))
    for (const [key, pending] of this.jobWrites) if (key.startsWith(prefix)) await pending.catch(() => {})
    for (const key of this.memory.keys()) if (key.startsWith(prefix)) this.memory.delete(key)
    for (const key of this.memoryJobs.keys()) if (key.startsWith(prefix)) this.memoryJobs.delete(key)
    if (this.root !== undefined) await rm(this.path(component(baseId)), { recursive: true, force: true })
  }
}
