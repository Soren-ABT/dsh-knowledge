import { copyFile, mkdir, open, rename, stat, truncate } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MineruDeploymentPlan, MineruModelFile } from './mineru-deployment-types.js'
import { availableBytes, checkDeploymentPath, DeploymentError, verifyModelFile } from './mineru-deployment-plan.js'
import { MINERU_MODEL_DIRECTORY } from './mineru-manifest.js'

export interface ModelDownloadProgress { completedBytes: number; totalBytes: number; file: string }

/** Fixed revision, no credentials, no untrusted browser URLs. Partial files are
 * retained, but never exposed to inference before full content verification. */
export async function downloadMineruModels(plan: MineruDeploymentPlan, signal: AbortSignal,
  progress: (value: ModelDownloadProgress) => void, fetcher: typeof fetch = fetch): Promise<void> {
  const targetRoot = join(plan.root, 'models', MINERU_MODEL_DIRECTORY)
  const totalBytes = plan.files.reduce((sum, file) => sum + file.bytes, 0)
  let verified = 0
  for (const file of plan.files) {
    signal.throwIfAborted()
    // Verify before trusting either a completed file or an external source.
    if (await verifyModelFile(targetRoot, file, signal)) {
      verified += file.bytes; progress({ completedBytes: verified, totalBytes, file: file.path }); continue
    }
    const destination = await checkDeploymentPath(join(targetRoot, file.path))
    const partRoot = join(plan.root, 'staging', plan.modelRevision)
    const partFile: MineruModelFile = { ...file, path: `${file.path}.part` }
    const partial = await checkDeploymentPath(join(partRoot, partFile.path))
    await mkdir(dirname(partial), { recursive: true })
    await mkdir(dirname(destination), { recursive: true })
    const free = await availableBytes(plan.root)
    if (free !== null && free < file.bytes) throw new DeploymentError('insufficient_space', 'Not enough space to stage this model file.')
    if (plan.externalModels) {
      if (!await verifyModelFile(plan.modelRoot, file, signal)) throw new DeploymentError('external_models_changed', 'An external model changed after preflight. Run preflight again.')
      await copyFile(join(plan.modelRoot, file.path), partial)
    } else {
      let offset = await stat(partial).then(value => value.size).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return 0; throw error })
      if (offset > file.bytes) { await truncate(partial, 0); offset = 0 }
      if (offset < file.bytes) {
        const url = `${plan.modelEndpoint}/${plan.modelRepo.split('/').map(encodeURIComponent).join('/')}/resolve/${plan.modelRevision}/${file.path.split('/').map(encodeURIComponent).join('/')}`
        const budget = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)])
        const response = await fetcher(url, { signal: budget, headers: offset ? { Range: `bytes=${offset}-` } : {} })
        try {
          if (!response.ok || !response.body) throw new DeploymentError('download_failed', `Model download returned HTTP ${response.status}. Retry preserves partial files.`)
          if (response.status === 206) {
            const range = response.headers.get('content-range')
            if (range !== `bytes ${offset}-${file.bytes - 1}/${file.bytes}`) throw new DeploymentError('invalid_download', 'Invalid resume range; retry after checking the download source.')
          } else if (response.status === 200) offset = 0
          else throw new DeploymentError('invalid_download', 'Unexpected model download response.')
          const handle = await open(partial, offset ? 'a' : 'w', 0o600)
          const reader = response.body.getReader()
          try {
            while (true) {
              const { done, value: chunk } = await reader.read()
              if (done) break
              budget.throwIfAborted()
              if (offset + chunk.length > file.bytes) throw new DeploymentError('invalid_download', 'Model data exceeds its pinned size.')
              await handle.writeFile(chunk)
              offset += chunk.length
              progress({ completedBytes: verified + offset, totalBytes, file: file.path })
            }
            await handle.sync()
          } finally { reader.releaseLock(); await handle.close() }
        } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}) }
      }
    }
    signal.throwIfAborted()
    if (!await verifyModelFile(partRoot, partFile, signal)) {
      // Retain truncated downloads for resume; discard only proven complete corruption.
      const size = await stat(partial).then(value => value.size)
      if (size >= file.bytes) await truncate(partial, 0)
      throw new DeploymentError('checksum_mismatch', 'Model download is incomplete or corrupt. No readiness was granted; retry is safe.')
    }
    await rename(partial, destination)
    verified += file.bytes
    progress({ completedBytes: verified, totalBytes, file: file.path })
  }
}
