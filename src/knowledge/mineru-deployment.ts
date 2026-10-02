import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkDeploymentPath, checkOwnedRoot, createDeploymentPlan, DeploymentError, OWNERSHIP_MARKER, resolveHuggingFaceEndpoint, resolvePythonIndexUrl, sameDeploymentPath, verifyModelFile } from './mineru-deployment-plan.js'
import type { MineruDeploymentPlan, MineruDeploymentStatus } from './mineru-deployment-types.js'
import { MINERU_BASIC_FILES, MINERU_MODEL_DIRECTORY, MINERU_MODEL_REVISION, MINERU_RUNTIME_VERSION } from './mineru-manifest.js'
import { downloadMineruModels } from './mineru-download.js'
import { extractWithMineruLocal } from './mineru-local.js'
import { prepareRuntime, probeManagedService, startManagedService, syntheticMineruPdf, type ManagedService } from './mineru-runtime.js'
import { discoverPythonEnvironments, probePythonExecutable } from './mineru-python.js'

export { MINERU_MODEL_REVISION, MINERU_RUNTIME_VERSION }

const defaults = { plan: createDeploymentPlan, download: downloadMineruModels, prepare: prepareRuntime, start: startManagedService, probe: probeManagedService,
  inspectPython: probePythonExecutable,
  validate: async (root: string, signal: AbortSignal) => {
    for (const file of MINERU_BASIC_FILES) if (!await verifyModelFile(join(root, 'models', MINERU_MODEL_DIRECTORY), file, signal)) throw new DeploymentError('model_changed', 'A verified model file changed; prepare again.')
  },
}
type SavedState = { schemaVersion: 1; runtimeVersion: string; revision: string; environmentId?: string; status: MineruDeploymentStatus }

async function atomicJson(path: string, value: unknown): Promise<void> {
  await checkDeploymentPath(path)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temp, path)
}

/** Only server-issued plans authorize preparation. No browser-supplied commands. */
export class MineruDeployment {
  private checking = false
  private controller?: AbortController
  private plans = new Map<string, MineruDeploymentPlan>()
  private state: MineruDeploymentStatus = { phase: 'absent', service: 'stopped', active: false }
  private task?: Promise<void>
  private service?: ManagedService
  private environmentId?: string
  private releaseLock?: () => Promise<void>
  private initialization?: Promise<void>
  private disposed = false
  private readonly deps: typeof defaults
  constructor(private readonly pointerPath?: () => string, dependencies: Partial<typeof defaults> = {}, private readonly sourceSettings: () => { hfEndpoint?: string; pythonIndexUrl?: string } = () => ({})) { this.deps = { ...defaults, ...dependencies } }

  async status(): Promise<MineruDeploymentStatus> {
    if (!this.initialization) this.initialization = this.initialize()
    await this.initialization
    return structuredClone(this.state)
  }

  private async initialize(): Promise<void> {
      try {
        const pointer = this.pointerPath?.()
        if (pointer) {
          await checkDeploymentPath(pointer)
          const { root } = JSON.parse(await readFile(pointer, 'utf8'))
          if (typeof root === 'string') await this.restore(root)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.state.error = { code: 'state_unavailable', message: 'Saved deployment could not be verified. Select its directory and run preflight.' }
      }
  }

  private async restore(root: string): Promise<void> {
    await checkOwnedRoot(root)
    const path = await checkDeploymentPath(join(root, 'deployment.json'))
    const saved = JSON.parse(await readFile(path, 'utf8')) as SavedState
    if (saved.schemaVersion !== 1 || saved.runtimeVersion !== MINERU_RUNTIME_VERSION || saved.revision !== MINERU_MODEL_REVISION || typeof saved.status.root !== 'string' || !sameDeploymentPath(saved.status.root, root) || (saved.environmentId !== undefined && !/^[a-f0-9-]{36}$/.test(saved.environmentId))) throw new DeploymentError('invalid_state', 'Incompatible deployment state.')
    this.environmentId = saved.environmentId
    const lockPath = await checkDeploymentPath(join(root, '.operation.lock'))
    const lockExists = await readFile(lockPath).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })
    this.state = { root, phase: lockExists ? 'interrupted' : saved.status.phase === 'ready' ? 'ready' : 'interrupted', verifiedAt: saved.status.verifiedAt, active: false, service: 'stopped' }
    const validation = saved.status.validation
    if (validation && ['interpreter', 'environment', 'dependencies', 'inference'].every(key => typeof validation[key as keyof typeof validation] === 'boolean')) {
      this.state.validation = { interpreter: validation.interpreter, environment: validation.environment, dependencies: validation.dependencies, inference: validation.inference }
    }
    if (lockExists || saved.status.active || saved.status.service !== 'stopped') this.state.error = { code: 'reconciliation_required', message: 'Previous operation may have been interrupted. Its process lock must be reconciled before another operation; no process was killed automatically.' }
  }

  private async persist(inactive = false): Promise<void> {
    if (!this.state.root) return
    await atomicJson(join(this.state.root, 'deployment.json'), { schemaVersion: 1, runtimeVersion: MINERU_RUNTIME_VERSION, revision: MINERU_MODEL_REVISION, environmentId: this.environmentId, status: { ...this.state, active: inactive ? false : this.state.active, endpoint: undefined } } satisfies SavedState)
  }

  async pythonEnvironments(executable?: string) {
    this.assertIdle(); this.checking = true
    const controller = this.controller = new AbortController()
    try {
      return executable ? { environments: [await this.deps.inspectPython(executable, controller.signal)], truncated: false } : await discoverPythonEnvironments(controller.signal)
    } finally { this.checking = false; this.controller = undefined }
  }

  async preflight(input: { root: string; existingModels?: string; pythonExecutable?: string; hfEndpoint?: string; pythonIndexUrl?: string }): Promise<MineruDeploymentPlan> {
    await this.status(); this.assertIdle()
    if (this.service || this.releaseLock) throw new DeploymentError('service_running', 'Stop the managed service before changing deployment paths.', 409)
    this.checking = true
    const controller = this.controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); timeout.unref()
    try {
      const plan = await this.deps.plan(input, { signal: controller.signal })
      if (input.pythonExecutable) plan.python = await this.deps.inspectPython(input.pythonExecutable, controller.signal)
      if (!plan.python?.eligible) plan.blockers.push(plan.python ? `python_${plan.python.reason}` : 'python_required')
      this.plans.clear(); this.plans.set(plan.id, plan)
      return structuredClone(plan)
    } finally { clearTimeout(timeout); this.controller = undefined; this.checking = false }
  }

  private assertIdle(): void {
    if (this.disposed) throw new DeploymentError('disposed', 'Deployment management is closing.', 409)
    if (this.checking || this.state.active) throw new DeploymentError('busy', 'A MinerU operation is already running.', 409)
  }

  private async unlock(): Promise<void> { await this.releaseLock?.() }

  private async lock(root: string): Promise<void> {
    if (this.releaseLock) throw new DeploymentError('installation_locked', 'The owned process lock has not been released.', 409)
    await checkOwnedRoot(root); await mkdir(root, { recursive: true })
    const markerPath = await checkDeploymentPath(join(root, OWNERSHIP_MARKER))
    try {
      const handle = await open(markerPath, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify({ owner: 'dsh-knowledge/mineru', schemaVersion: 1, root })) } finally { await handle.close() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const lockPath = await checkDeploymentPath(join(root, '.operation.lock'))
    let handle
    try { handle = await open(lockPath, 'wx', 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DeploymentError('installation_locked', 'Another process or interrupted operation owns this installation. Do not delete its lock until its processes have been checked.', 409); throw error }
    this.releaseLock = async () => { await handle.close(); await unlink(lockPath); this.releaseLock = undefined }
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
  }

  async prepare(planId: string): Promise<MineruDeploymentStatus> {
    this.assertIdle()
    if (this.releaseLock) throw new DeploymentError('installation_locked', 'The previous process requires reconciliation.', 409)
    if (this.service) throw new DeploymentError('service_running', 'Stop MinerU before preparation.', 409)
    const plan = this.plans.get(planId)
    if (!plan || plan.expiresAt < Date.now()) throw new DeploymentError('plan_expired', 'Run preflight again before preparing.', 409)
    if (plan.blockers.length) throw new DeploymentError('plan_blocked', 'Resolve the preflight blockers first.', 409)
    const sources = this.sourceSettings()
    if (resolveHuggingFaceEndpoint(sources.hfEndpoint) !== plan.modelEndpoint || resolvePythonIndexUrl(sources.pythonIndexUrl) !== plan.pythonIndexUrl) {
      this.plans.delete(planId)
      throw new DeploymentError('plan_stale', 'A download source changed after preflight. Run preflight again to review the active sources.', 409)
    }
    const previousState = structuredClone(this.state)
    const previousEnvironmentId = this.environmentId
    this.state = { root: plan.root, phase: 'preparing_environment', service: 'stopped', active: true, operationId: randomUUID(), python: plan.python,
      validation: { interpreter: false, environment: false, dependencies: false, inference: false } }
    this.controller = new AbortController()
    const signal = this.controller.signal
    try { await this.lock(plan.root); signal.throwIfAborted() }
    catch (error) {
      this.failure(error, signal)
      // Do not overwrite another process's state when lock acquisition failed.
      if (this.releaseLock) {
        try {
          if (previousState.phase === 'ready' && previousState.root && previousEnvironmentId) {
            const operationError = this.state.error
            this.state = { ...previousState, active: true, service: 'stopped', error: operationError }
            this.environmentId = previousEnvironmentId
            if (sameDeploymentPath(previousState.root, plan.root)) await this.persist(true)
          } else await this.persist(true)
          await this.unlock()
        }
        catch {
          this.state.phase = 'failed'
          this.state.error = { code: 'state_write_failed', message: 'Deployment setup could not be saved or safely unlocked. Its installation remains locked for reconciliation.' }
        }
      } else if (error instanceof DeploymentError && error.code === 'installation_locked') {
        if (previousState.phase === 'ready' && previousState.root && previousEnvironmentId) {
          this.state = { ...previousState, active: true, service: 'stopped', error: this.state.error }
          this.environmentId = previousEnvironmentId
        } else this.state.phase = 'interrupted'
      }
      this.state.active = false; this.controller = undefined
      throw error
    }
    this.plans.delete(planId)
    this.task = this.performPrepare(plan, this.controller.signal, previousState, previousEnvironmentId)
    return structuredClone(this.state)
  }

  private async performPrepare(plan: MineruDeploymentPlan, signal: AbortSignal, previousState: MineruDeploymentStatus, previousEnvironmentId?: string): Promise<void> {
    let probeService: ManagedService | undefined
    let committed = false
    try {
      const environmentId = randomUUID()
      if (!plan.python?.eligible) throw new DeploymentError('python_required', 'Select a compatible Python interpreter.')
      const current = await this.deps.inspectPython(plan.python.executable, signal)
      if (!current.eligible || current.fingerprint !== plan.python.fingerprint) throw new DeploymentError('python_changed', 'Selected interpreter changed. Run preflight again; no alternate Python was selected.')
      this.state.validation!.interpreter = true
      const environment = await this.deps.prepare(plan.root, environmentId, signal, plan.python, step => { this.state.validation![step] = true }, plan.pythonIndexUrl)
      signal.throwIfAborted()
      this.state.phase = 'downloading'
      await this.deps.download(plan, signal, progress => { Object.assign(this.state, progress) })
      this.state.phase = 'probing'
      probeService = await this.deps.start(plan.root, environment, 18879, signal)
      await this.deps.probe(probeService, signal)
      this.state.validation!.inference = true
      await probeService.stop(); probeService = undefined
      signal.throwIfAborted()
      this.environmentId = environmentId
      this.state.phase = 'ready'; this.state.verifiedAt = Date.now(); this.state.error = undefined
      await this.persist(true)
      if (this.pointerPath) await atomicJson(this.pointerPath(), { root: plan.root })
      committed = true
    } catch (error) { this.failure(error, signal) }
    finally {
      let stopped = this.state.error?.code !== 'shutdown_failed'
      try { await probeService?.stop() } catch { stopped = false; this.state.error = { code: 'shutdown_failed', message: 'Owned process may still be running; installation remains locked.' } }
      if (!committed && previousState.phase === 'ready' && previousState.root && previousEnvironmentId) {
        const operationError = this.state.error ?? { code: 'preparation_failed', message: 'Preparation failed; the previously verified installation remains available.' }
        // Restoring the usable candidate does not finish the operation: keep
        // callers busy until its state is saved and the owned lock is released.
        this.state = { ...previousState, phase: stopped ? 'ready' : 'interrupted', active: true, service: 'stopped', endpoint: undefined, error: operationError }
        this.environmentId = previousEnvironmentId
        if (sameDeploymentPath(previousState.root, plan.root)) {
          try { await this.persist(true) } catch { this.state.error = { code: 'state_write_failed', message: 'The prior verified installation remains in memory, but its saved state could not be refreshed.' } }
        }
      } else if (!committed) {
        try { await this.persist(true) } catch { this.state.phase = 'failed'; this.state.error = { code: 'state_write_failed', message: 'Deployment state could not be saved. Run preflight before retrying.' } }
      }
      if (stopped) await this.releaseLock?.().catch(() => {})
      this.state.active = false; this.controller = undefined
    }
  }

  private failure(error: unknown, signal: AbortSignal): void {
    this.state.phase = signal.aborted ? 'canceled' : 'failed'
    this.state.error = error instanceof DeploymentError ? { code: error.code, message: error.message } : { code: signal.aborted ? 'canceled' : 'preparation_failed', message: signal.aborted ? 'Canceled. Verified models and partial downloads were retained.' : 'Preparation failed. Verified models and partial downloads were retained; run preflight before retrying.' }
  }

  cancel(): MineruDeploymentStatus { this.controller?.abort(); return structuredClone(this.state) }

  async start(): Promise<MineruDeploymentStatus> {
    await this.status(); this.assertIdle()
    if (this.service) return structuredClone(this.state)
    if (this.releaseLock) throw new DeploymentError('installation_locked', 'The previous process requires reconciliation.', 409)
    if (this.state.phase !== 'ready' || !this.state.root || !this.environmentId) throw new DeploymentError('not_ready', 'Prepare and validate this installation first.', 409)
    const root = this.state.root
    this.state.active = true; this.state.service = 'starting'; this.controller = new AbortController()
    const signal = this.controller.signal
    try { await this.lock(root); await this.persist() } catch (error) {
      this.state.active = false; this.state.service = 'error'; this.failure(error, signal)
      if (this.releaseLock) await this.unlock().catch(() => {})
      else if (error instanceof DeploymentError && error.code === 'installation_locked') this.state.phase = 'interrupted'
      this.controller = undefined
      throw error
    }
    this.task = (async () => {
      try {
        await this.deps.validate(root, signal)
        const environment = await checkDeploymentPath(join(root, 'envs', this.environmentId!))
        const service = await this.deps.start(root, environment, 18879, signal)
        this.service = service; this.state.service = 'running'; this.state.endpoint = service.url; this.state.error = undefined
        service.child.once('exit', () => {
          if (this.service !== service || this.state.service === 'stopping') return
          this.service = undefined; this.state.service = 'error'; this.state.endpoint = undefined
          this.state.error = { code: 'service_exited', message: 'The managed service exited unexpectedly; its process lock is retained for reconciliation.' }
          void this.persist().catch(() => {})
        })
      } catch (error) {
        this.failure(error, signal)
        if (this.state.error?.code !== 'model_changed') this.state.phase = 'ready'
        this.state.service = 'error'
        if (this.state.error?.code !== 'shutdown_failed') await this.releaseLock?.().catch(() => {})
      }
      finally { this.state.active = false; this.controller = undefined; await this.persist().catch(() => {}) }
    })()
    return structuredClone(this.state)
  }

  async stop(): Promise<MineruDeploymentStatus> {
    this.controller?.abort(); await this.task
    const service = this.service
    if (service) {
      this.state.service = 'stopping'; this.state.active = true
      try { await service.stop(); this.service = undefined; this.state.service = 'stopped'; this.state.endpoint = undefined; await this.releaseLock?.() }
      finally { this.state.active = false; await this.persist() }
    }
    return structuredClone(this.state)
  }

  connection(): { mineruLocalUrl: string; mineruLocalApiKey: string } {
    if (!this.service || this.state.service !== 'running') throw new DeploymentError('service_not_running', 'Start the managed service first.', 409)
    return { mineruLocalUrl: this.service.url, mineruLocalApiKey: this.service.apiKey }
  }

  async dispose(): Promise<void> { this.disposed = true; this.controller?.abort(); await this.stop(); this.plans.clear() }
}

/** Exercise the same upload/parse contract used by local document processing. */
export async function probeManagedMineruParse(connection: { mineruLocalUrl: string; mineruLocalApiKey: string }, signal: AbortSignal): Promise<void> {
  const output = await extractWithMineruLocal(
    syntheticMineruPdf(),
    'managed-smoke-fixture.pdf',
    { apiUrl: connection.mineruLocalUrl, apiKey: connection.mineruLocalApiKey, tier: 'basic', timeoutMs: 10 * 60_000 },
    { signal },
  )
  if (!output.document.blocks.some(block => block.pageIndex === 0 && /42\s*kg/.test(block.text))) throw new DeploymentError('probe_failed', 'MinerU did not preserve the expected text and page evidence in the managed smoke fixture.')
}
