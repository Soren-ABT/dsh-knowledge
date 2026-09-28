import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { MineruDeploymentPlan, MineruModelFile } from './mineru-deployment-types.js'
import { MINERU_BASIC_FILES, MINERU_MODEL_DIRECTORY, MINERU_MODEL_METADATA_DATE, MINERU_MODEL_REPO, MINERU_MODEL_REVISION, MINERU_RUNTIME_VERSION } from './mineru-manifest.js'

export class DeploymentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'DeploymentError' }
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
export const OWNERSHIP_MARKER = '.dsh-mineru-managed.json'

export function sameDeploymentPath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US') : a === b
}

export function resolveHuggingFaceEndpoint(configured?: string): string {
  const value = configured?.trim() || process.env.HF_ENDPOINT?.trim() || 'https://huggingface.co'
  let url: URL
  try { url = new URL(value) } catch { throw new DeploymentError('invalid_download_source', 'The Hugging Face download source must be a valid HTTPS URL.') }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new DeploymentError('invalid_download_source', 'The Hugging Face download source must use HTTPS and cannot contain credentials, query parameters or fragments.')
  }
  return url.toString().replace(/\/+$/, '')
}

export function resolvePythonIndexUrl(configured?: string): string {
  const value = configured?.trim() || 'https://pypi.org/simple'
  let url: URL
  try { url = new URL(value) } catch { throw new DeploymentError('invalid_python_index', 'The Python package source must be a valid HTTPS URL.') }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new DeploymentError('invalid_python_index', 'The Python package source must use HTTPS and cannot contain credentials, query parameters or fragments.')
  }
  return url.toString().replace(/\/+$/, '')
}

/** Refuse drive roots, home roots, relative paths, UNC and symlink/junction ancestors.
 * This protects ordinary mistakes and planted links, not a hostile local OS user. */
export async function checkDeploymentPath(value: string): Promise<string> {
  if (!value || value.includes('\0') || !isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//')) {
    throw new DeploymentError('invalid_path', 'Choose an absolute local directory, not a network path.')
  }
  const target = resolve(value)
  const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (same(target, parse(target).root) || same(target, homedir()) || same(target, resolve(process.cwd()))) {
    throw new DeploymentError('unsafe_path', 'Choose a dedicated MinerU subdirectory, not a drive, home or workspace root.')
  }
  let current = target
  while (true) {
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new DeploymentError('unsafe_path', 'Symbolic links and junctions are not supported for managed paths.')
    } catch (e) { if (!missing(e)) throw e }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return target
}

export async function checkOwnedRoot(root: string): Promise<void> {
  await checkDeploymentPath(root)
  let names: string[]
  try { names = await readdir(root) } catch (e) { if (missing(e)) return; throw e }
  if (names.length === 0) return
  try {
    await checkDeploymentPath(join(root, OWNERSHIP_MARKER))
    const marker = JSON.parse(await readFile(join(root, OWNERSHIP_MARKER), 'utf8'))
    if (marker.owner === 'dsh-knowledge/mineru' && marker.schemaVersion === 1 && typeof marker.root === 'string' && sameDeploymentPath(marker.root, root)) return
  } catch { /* Existing unowned content must never be adopted implicitly. */ }
  throw new DeploymentError('unowned_directory', 'This nonempty directory is not managed by the plugin. Choose a new subdirectory; use existing models through the read-only model path.')
}

export async function verifyModelFile(root: string, file: MineruModelFile, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  if (file.path.includes(':') || file.path.includes('\0') || file.path.split(/[\\/]/).some(p => !p || p === '..' || p === '.') || isAbsolute(file.path)) throw new DeploymentError('invalid_manifest', 'Unsafe model manifest path.')
  const path = await checkDeploymentPath(join(root, file.path))
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size !== file.bytes) return false
  } catch (e) { if (missing(e)) return false; throw e }
  const hash = createHash(file.algorithm === 'git-sha1' ? 'sha1' : 'sha256')
  if (file.algorithm === 'git-sha1') hash.update(`blob ${file.bytes}\0`)
  for await (const piece of createReadStream(path, { signal })) { signal?.throwIfAborted(); hash.update(piece) }
  return hash.digest('hex') === file.digest
}

export async function availableBytes(root: string): Promise<number | null> {
  let path = root
  while (true) {
    try { const stat = await statfs(path, { bigint: true }); const bytes = stat.bavail * stat.bsize; return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null }
    catch (e) { if (!missing(e) || dirname(path) === path) return null; path = dirname(path) }
  }
}

export async function createDeploymentPlan(input: { root: string; existingModels?: string; hfEndpoint?: string; pythonIndexUrl?: string }, options: {
  files?: readonly MineruModelFile[]; signal?: AbortSignal
} = {}): Promise<MineruDeploymentPlan> {
  const root = await checkDeploymentPath(input.root.trim())
  await checkOwnedRoot(root)
  const externalModels = Boolean(input.existingModels?.trim())
  const modelRoot = await checkDeploymentPath(externalModels ? input.existingModels!.trim() : join(root, 'models', MINERU_MODEL_DIRECTORY))
  const files: MineruDeploymentPlan['files'] = []
  for (const file of options.files ?? MINERU_BASIC_FILES) files.push({ ...file, reusable: await verifyModelFile(modelRoot, file, options.signal) })
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0)
  const verifiedReusableBytes = files.reduce((n, f) => n + (f.reusable ? f.bytes : 0), 0)
  const downloadBytes = totalBytes - verifiedReusableBytes
  const freeBytes = await availableBytes(root)
  const blockers: string[] = []
  const modelPeakAdditionalBytes = externalModels ? totalBytes * 2 : downloadBytes * 2
  if (externalModels && downloadBytes > 0) blockers.push('external_models_incomplete')
  if (freeBytes !== null && freeBytes < modelPeakAdditionalBytes) blockers.push('insufficient_model_space')
  return {
    id: randomUUID(), expiresAt: Date.now() + 10 * 60_000, root, modelRoot, externalModels,
    tier: 'basic', backend: 'onnx', runtimeVersion: MINERU_RUNTIME_VERSION,
    modelRepo: MINERU_MODEL_REPO, modelEndpoint: resolveHuggingFaceEndpoint(input.hfEndpoint), pythonIndexUrl: resolvePythonIndexUrl(input.pythonIndexUrl), modelRevision: MINERU_MODEL_REVISION, metadataDate: MINERU_MODEL_METADATA_DATE,
    capacity: { totalBytes, verifiedReusableBytes, downloadBytes, modelPeakAdditionalBytes,
      runtimeDownloadBytes: null, runtimeInstalledBytes: null, freeBytes },
    files, blockers,
    warnings: ['runtime_size_unknown', 'real_inference_not_qualified', ...(freeBytes === null ? ['free_space_unknown'] : [])],
  }
}
