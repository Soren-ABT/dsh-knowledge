import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeploymentPlan, DeploymentError } from '../src/knowledge/mineru-deployment-plan.js'
import { MineruDeployment } from '../src/knowledge/mineru-deployment.js'
import { downloadMineruModels } from '../src/knowledge/mineru-download.js'
import { MINERU_MODEL_DIRECTORY } from '../src/knowledge/mineru-manifest.js'
import { runManagedCommand, runtimeEnvironment, type ManagedService } from '../src/knowledge/mineru-runtime.js'
import type { MineruDeploymentPlan } from '../src/knowledge/mineru-deployment-types.js'

const directories: string[] = []
const managers: MineruDeployment[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()))
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})
const bytes = Buffer.from('verified fixture bytes')
const file = { path: 'Layout/model.onnx', bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), algorithm: 'sha256' as const }
async function fixture(): Promise<MineruDeploymentPlan> {
  const parent = await mkdtemp(join(tmpdir(), 'mineru-managed-')); directories.push(parent)
  return createDeploymentPlan({ root: join(parent, 'install') }, { files: [file] })
}
const modelPath = (plan: MineruDeploymentPlan) => join(plan.root, 'models', MINERU_MODEL_DIRECTORY, file.path)
const partialPath = (plan: MineruDeploymentPlan) => join(plan.root, 'staging', plan.modelRevision, `${file.path}.part`)

describe('pinned resumable model downloads', () => {
  it('downloads and verifies, then reuses without network access', async () => {
    const plan = await fixture()
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(bytes))
    const progress = vi.fn()
    await downloadMineruModels(plan, new AbortController().signal, progress, fetcher)
    expect(await readFile(modelPath(plan))).toEqual(bytes)
    await downloadMineruModels(plan, new AbortController().signal, progress, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenLastCalledWith({ completedBytes: bytes.length, totalBytes: bytes.length, file: file.path })
  })
  it('uses the endpoint frozen into the deployment plan', async () => {
    const plan = { ...await fixture(), modelEndpoint: 'https://hf-mirror.com' }
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response(bytes))
    await downloadMineruModels(plan, new AbortController().signal, () => {}, fetcher)
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://hf-mirror.com/${plan.modelRepo}/resolve/${plan.modelRevision}/Layout/model.onnx`)
  })
  it.each([true, false])('handles resume when server supports Range=%s', async supportsRange => {
    const plan = await fixture()
    await mkdir(join(plan.root, 'staging', plan.modelRevision, 'Layout'), { recursive: true })
    await writeFile(partialPath(plan), bytes.subarray(0, 5))
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Range: 'bytes=5-' })
      return supportsRange ? new Response(bytes.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` } }) : new Response(bytes)
    })
    await downloadMineruModels(plan, new AbortController().signal, () => {}, fetcher)
    expect(await readFile(modelPath(plan))).toEqual(bytes)
  })
  it('never publishes corrupt data and resets a fully corrupt partial for retry', async () => {
    const plan = await fixture()
    const fetcher = vi.fn(async () => new Response(Buffer.alloc(bytes.length)))
    await expect(downloadMineruModels(plan, new AbortController().signal, () => {}, fetcher)).rejects.toMatchObject({ code: 'checksum_mismatch' })
    expect((await stat(partialPath(plan))).size).toBe(0)
    await expect(stat(modelPath(plan))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('retains a truncated response for a later attempt', async () => {
    const plan = await fixture()
    await expect(downloadMineruModels(plan, new AbortController().signal, () => {}, async () => new Response(bytes.subarray(0, 5)))).rejects.toMatchObject({ code: 'checksum_mismatch' })
    expect(await readFile(partialPath(plan))).toEqual(bytes.subarray(0, 5))
  })
  it('rejects unexpected Content-Range without changing the partial', async () => {
    const plan = await fixture()
    await mkdir(join(plan.root, 'staging', plan.modelRevision, 'Layout'), { recursive: true })
    await writeFile(partialPath(plan), bytes.subarray(0, 5))
    await expect(downloadMineruModels(plan, new AbortController().signal, () => {}, async () => new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-10/11' } }))).rejects.toMatchObject({ code: 'invalid_download' })
    expect(await readFile(partialPath(plan))).toEqual(bytes.subarray(0, 5))
  })
  it('copies external models without writing metadata into the source', async () => {
    const plan = await fixture()
    const source = join(directories.at(-1)!, 'external')
    await mkdir(join(source, 'Layout'), { recursive: true }); await writeFile(join(source, file.path), bytes)
    const fetcher = vi.fn()
    await downloadMineruModels({ ...plan, modelRoot: source, externalModels: true }, new AbortController().signal, () => {}, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readFile(join(source, file.path))).toEqual(bytes)
    expect(await readFile(modelPath(plan))).toEqual(bytes)
  })
})

async function settled(manager: MineruDeployment) {
  for (let i = 0; i < 300; i++) { const state = await manager.status(); if (!state.active) return state; await delay(10) }
  throw new Error('task did not settle')
}
function fakeService(): ManagedService {
  return { child: new EventEmitter() as ManagedService['child'], url: 'http://127.0.0.1:18879', apiKey: 'not-persisted-test-secret', stop: vi.fn(async () => {}) }
}
async function managerFixture(overrides: ConstructorParameters<typeof MineruDeployment>[1] = {}) {
  const plan = await fixture()
  const pointer = join(directories.at(-1)!, 'pointer.json')
  plan.python = { executable: join(plan.root, 'python.exe'), source: 'fixture', version: '3.13.7', bits: 64, eligible: true, fingerprint: 'fixture' }
  const service = fakeService()
  const deps = { plan: async () => plan, inspectPython: vi.fn(async () => plan.python!), prepare: vi.fn(async (_root: string, environmentId: string) => join(plan.root, 'envs', environmentId)), download: vi.fn(async () => {}), start: vi.fn(async () => service), probe: vi.fn(async () => {}), validate: vi.fn(async () => {}), ...overrides }
  const manager = new MineruDeployment(() => pointer, deps); managers.push(manager)
  await manager.preflight({ root: plan.root })
  return { manager, plan, deps, pointer, service }
}

describe('durable preparation lifecycle', () => {
  it('rejects an interpreter changed after preflight without installing anything', async () => {
    const { manager, plan, deps } = await managerFixture({ inspectPython: async () => ({ executable: 'changed', source: 'fixture', eligible: true, fingerprint: 'changed' }) })
    await manager.prepare(plan.id)
    expect(await settled(manager)).toMatchObject({ phase: 'failed', error: { code: 'python_changed' } })
    expect(deps.prepare).not.toHaveBeenCalled()
    expect(deps.download).not.toHaveBeenCalled()
  })
  it('starts and stops only the prepared owned service; credentials stay out of status', async () => {
    const { manager, plan, deps, service } = await managerFixture()
    await manager.prepare(plan.id); await settled(manager)
    await manager.start()
    expect(await settled(manager)).toMatchObject({ phase: 'ready', service: 'running', endpoint: service.url })
    expect(deps.validate).toHaveBeenCalledOnce()
    expect(manager.connection()).toEqual({ mineruLocalUrl: service.url, mineruLocalApiKey: service.apiKey })
    expect(JSON.stringify(await manager.status())).not.toContain(service.apiKey)
    expect(await manager.stop()).toMatchObject({ phase: 'ready', service: 'stopped' })
    await expect(stat(join(plan.root, '.operation.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('invalidates readiness if model files change after preparation', async () => {
    const { manager, plan } = await managerFixture({ validate: async () => { throw new DeploymentError('model_changed', 'fixture changed') } })
    await manager.prepare(plan.id); await settled(manager)
    await manager.start()
    expect(await settled(manager)).toMatchObject({ phase: 'failed', service: 'error', error: { code: 'model_changed' } })
  })
  it('returns a background task, probes before ready, and restores without executing anything', async () => {
    const { manager, plan, deps, pointer } = await managerFixture()
    expect((await manager.prepare(plan.id)).active).toBe(true)
    expect((await settled(manager)).phase).toBe('ready')
    expect(deps.probe).toHaveBeenCalledTimes(1)
    const disk = await readFile(join(plan.root, 'deployment.json'), 'utf8')
    expect(disk).not.toContain('not-persisted-test-secret')
    const restored = new MineruDeployment(() => pointer, deps); managers.push(restored)
    expect(await restored.status()).toMatchObject({ phase: 'ready', service: 'stopped', active: false })
    expect(deps.prepare).toHaveBeenCalledTimes(1)
  })
  it('keeps a previously verified installation usable when re-preparation fails', async () => {
    const { manager, plan, deps } = await managerFixture()
    await manager.prepare(plan.id)
    const initial = await settled(manager)
    expect(initial.phase).toBe('ready')
    await manager.preflight({ root: plan.root })
    vi.mocked(deps.prepare).mockRejectedValueOnce(new DeploymentError('runtime_command_failed', 'candidate failed'))
    await manager.prepare(plan.id)
    expect(await settled(manager)).toMatchObject({ phase: 'ready', root: plan.root, service: 'stopped', error: { code: 'runtime_command_failed' } })
    await manager.start()
    expect(await settled(manager)).toMatchObject({ phase: 'ready', service: 'running' })
  })
  it('does not move the saved pointer until a different candidate passes inference', async () => {
    const { manager, plan, deps, pointer } = await managerFixture()
    await manager.prepare(plan.id); await settled(manager)
    const candidateRoot = join(directories.at(-1)!, 'candidate-install')
    const candidate = { ...plan, id: 'candidate-plan', root: candidateRoot, modelRoot: join(candidateRoot, 'models'), files: plan.files }
    deps.plan = async () => candidate
    const candidatePlan = await manager.preflight({ root: candidateRoot })
    vi.mocked(deps.probe).mockRejectedValueOnce(new DeploymentError('probe_failed', 'candidate probe failed'))
    await manager.prepare(candidatePlan.id); await settled(manager)
    expect(JSON.parse(await readFile(pointer, 'utf8')).root).toBe(plan.root)
    expect(await manager.status()).toMatchObject({ phase: 'ready', root: plan.root })
  })
  it('invalidates a preflight plan when a download source changes before confirmation', async () => {
    const plan = await fixture()
    plan.python = { executable: 'python', source: 'fixture', eligible: true, fingerprint: 'fixture' }
    let hfEndpoint = 'https://hf-mirror.com'
    const prepare = vi.fn()
    const manager = new MineruDeployment(undefined, { plan: async input => ({ ...plan, modelEndpoint: input.hfEndpoint!, pythonIndexUrl: input.pythonIndexUrl! }), prepare }, () => ({ hfEndpoint, pythonIndexUrl: 'https://pypi.org/simple' }))
    managers.push(manager)
    const preparedPlan = await manager.preflight({ root: plan.root, hfEndpoint, pythonIndexUrl: 'https://pypi.org/simple' })
    hfEndpoint = 'https://huggingface.co'
    await expect(manager.prepare(preparedPlan.id)).rejects.toMatchObject({ code: 'plan_stale' })
    expect(prepare).not.toHaveBeenCalled()
  })
  it('probe failure cannot grant readiness and closes its temporary service', async () => {
    const { manager, plan, service } = await managerFixture({ probe: async () => { throw new DeploymentError('probe_failed', 'fixture failure') } })
    await manager.prepare(plan.id)
    expect(await settled(manager)).toMatchObject({ phase: 'failed', error: { code: 'probe_failed' } })
    expect(service.stop).toHaveBeenCalledOnce()
    await expect(manager.start()).rejects.toMatchObject({ code: 'not_ready' })
  })
  it('rejects double preparation and cancels only the active task', async () => {
    const { manager, plan } = await managerFixture({ prepare: async (_root, _id, signal) => { await delay(60_000, undefined, { signal }); return '' } })
    await manager.prepare(plan.id)
    await expect(manager.prepare(plan.id)).rejects.toMatchObject({ code: 'busy' })
    manager.cancel()
    expect((await settled(manager)).phase).toBe('canceled')
    await expect(stat(join(plan.root, '.operation.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects unknown plans without running commands', async () => {
    const { manager, deps } = await managerFixture()
    await expect(manager.prepare('tampered-plan')).rejects.toMatchObject({ code: 'plan_expired' })
    expect(deps.prepare).not.toHaveBeenCalled()
  })
  it('does not steal another process lock', async () => {
    const { manager, plan } = await managerFixture({ prepare: async (_root, _id, signal) => { await delay(60_000, undefined, { signal }); return '' } })
    await manager.prepare(plan.id)
    const other = new MineruDeployment(undefined, { plan: async () => ({ ...plan, id: 'other' }) }); managers.push(other)
    await other.preflight({ root: plan.root })
    await expect(other.prepare('other')).rejects.toMatchObject({ code: 'installation_locked' })
    expect(await stat(join(plan.root, '.operation.lock'))).toBeDefined()
    manager.cancel(); await settled(manager)
  })
})

describe('isolated command execution', () => {
  it('does not inherit remote model keys or Python injection configuration', () => {
    vi.stubEnv('MINERU_MODEL_VLM_API_KEY', 'secret'); vi.stubEnv('PYTHONPATH', 'untrusted'); vi.stubEnv('PIP_INDEX_URL', 'https://private.invalid')
    const env = runtimeEnvironment('dedicated')
    expect(env.MINERU_MODEL_VLM_API_KEY).toBeUndefined(); expect(env.PYTHONPATH).toBeUndefined(); expect(env.PIP_INDEX_URL).toBeUndefined()
    expect(env.MINERU_MODEL_SOURCE).toBe('local')
    expect(runtimeEnvironment('dedicated', 'dedicated/envs/verified/config.yaml').MINERU_CONFIG).toBe('dedicated/envs/verified/config.yaml')
  })
  it('runs a harmless fixture process and cancels a hanging owned process', async () => {
    const plan = await fixture(); await mkdir(plan.root)
    expect(await runManagedCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], plan.root, new AbortController().signal, 10_000)).toBe('ok')
    const controller = new AbortController()
    const result = runManagedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], plan.root, controller.signal, 10_000)
    setTimeout(() => controller.abort(), 100)
    await expect(result).rejects.toBeDefined()
  }, 30_000)
  it('returns bounded runtime diagnostics with common secrets and local paths redacted', async () => {
    const plan = await fixture(); await mkdir(plan.root)
    const source = `process.stderr.write('api_key=topsecret\\n${plan.root}\\n' + 'x'.repeat(5000)); process.exit(2)`
    const error = await runManagedCommand(process.execPath, ['-e', source], plan.root, new AbortController().signal, 10_000).then(() => null, reason => reason)
    expect(error).toMatchObject({ code: 'runtime_command_failed' })
    expect((error as Error).message).not.toContain('topsecret')
    expect((error as Error).message).not.toContain(plan.root)
    expect((error as Error).message.length).toBeLessThan(520)
  })
})
