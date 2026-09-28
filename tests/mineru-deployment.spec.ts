import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDeploymentPath, checkOwnedRoot, createDeploymentPlan, OWNERSHIP_MARKER, resolveHuggingFaceEndpoint, resolvePythonIndexUrl, sameDeploymentPath, verifyModelFile } from '../src/knowledge/mineru-deployment-plan.js'
import { requireLocalManagement } from '../src/knowledge/mineru-management-security.js'
import { MINERU_BASIC_FILES } from '../src/knowledge/mineru-manifest.js'

const temporary: string[] = []
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'mineru-plan-')); temporary.push(root); return root }
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const bytes = Buffer.from('fixture')
const file = { path: 'Layout/model.onnx', bytes: bytes.length, algorithm: 'sha256' as const, digest: createHash('sha256').update(bytes).digest('hex') }

describe('managed MinerU preflight', () => {
  it('computes capacity without creating directories or downloading anything', async () => {
    const parent = await fixture()
    const plan = await createDeploymentPlan({ root: join(parent, 'new') }, { files: [file] })
    expect(plan.capacity).toMatchObject({ totalBytes: 7, downloadBytes: 7, verifiedReusableBytes: 0, runtimeDownloadBytes: null })
    expect(await readdir(parent)).toEqual([])
  })
  it('resolves the configured Hugging Face mirror into the immutable plan', async () => {
    const parent = await fixture()
    const plan = await createDeploymentPlan({ root: join(parent, 'new'), hfEndpoint: 'https://hf-mirror.com/' }, { files: [file] })
    expect(plan.modelEndpoint).toBe('https://hf-mirror.com')
    expect(resolveHuggingFaceEndpoint('')).toMatch(/^https?:\/\//)
  })
  it.each(['http://mirror.example', 'https://user:pass@mirror.example', 'https://mirror.example/?token=x'])('rejects unsafe or credential-bearing model sources: %s', value => {
    expect(() => resolveHuggingFaceEndpoint(value)).toThrow()
  })
  it('validates and freezes the isolated Python package source', async () => {
    const parent = await fixture()
    const plan = await createDeploymentPlan({ root: join(parent, 'new'), pythonIndexUrl: 'https://pypi.mirror.example/simple/' }, { files: [file] })
    expect(plan.pythonIndexUrl).toBe('https://pypi.mirror.example/simple')
    expect(resolvePythonIndexUrl()).toBe('https://pypi.org/simple')
    expect(() => resolvePythonIndexUrl('https://user:secret@pypi.example/simple')).toThrow()
  })
  it('only counts fully verified external files as reusable and leaves them untouched', async () => {
    const parent = await fixture()
    const external = join(parent, 'external')
    await mkdir(join(external, 'Layout'), { recursive: true })
    await writeFile(join(external, file.path), bytes)
    const input = { root: join(parent, 'managed'), existingModels: external }
    expect((await createDeploymentPlan(input, { files: [file] })).capacity.downloadBytes).toBe(0)
    await writeFile(join(external, file.path), 'corrupt')
    expect((await createDeploymentPlan(input, { files: [file] })).blockers).toContain('external_models_incomplete')
    expect(await readdir(parent)).toEqual(['external'])
  })
  it('supports Git blob fingerprints for small upstream config files', async () => {
    const root = await fixture()
    await writeFile(join(root, 'config.yml'), bytes)
    const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    expect(await verifyModelFile(root, { path: 'config.yml', bytes: bytes.length, algorithm: 'git-sha1', digest })).toBe(true)
  })
  it('rejects unowned content, traversal, root paths and canceled checks', async () => {
    const root = await fixture()
    await writeFile(join(root, 'keep.txt'), 'keep')
    await expect(checkOwnedRoot(root)).rejects.toMatchObject({ code: 'unowned_directory' })
    await expect(verifyModelFile(root, { ...file, path: '../escape' })).rejects.toMatchObject({ code: 'invalid_manifest' })
    await expect(checkDeploymentPath(parse(root).root)).rejects.toMatchObject({ code: 'unsafe_path' })
    await expect(checkDeploymentPath('relative')).rejects.toMatchObject({ code: 'invalid_path' })
    await expect(verifyModelFile(root, file, AbortSignal.abort())).rejects.toBeDefined()
    await writeFile(join(root, OWNERSHIP_MARKER), JSON.stringify({ owner: 'dsh-knowledge/mineru', schemaVersion: 1, root }))
    await expect(checkOwnedRoot(root)).resolves.toBeUndefined()
  })
  it('rejects linked ancestor directories', async () => {
    const root = await fixture()
    await mkdir(join(root, 'real'))
    await symlink(join(root, 'real'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(checkDeploymentPath(join(root, 'linked', 'nested'))).rejects.toMatchObject({ code: 'unsafe_path' })
  })
  it('compares Windows deployment path identity without case sensitivity', () => {
    if (process.platform === 'win32') expect(sameDeploymentPath('C:\\MinerU\\Root', 'c:\\mineru\\root')).toBe(true)
    else expect(sameDeploymentPath('/tmp/MinerU', '/tmp/mineru')).toBe(false)
  })
  it('pins unique complete file metadata', () => {
    expect(new Set(MINERU_BASIC_FILES.map(item => item.path)).size).toBe(13)
    for (const item of MINERU_BASIC_FILES) {
      expect(item.bytes).toBeGreaterThan(0)
      expect(item.digest).toMatch(item.algorithm === 'sha256' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}$/)
    }
  })
})

describe('MinerU management access', () => {
  function request(headers = {}, peer = '127.0.0.1') {
    return { method: 'POST', socket: { remoteAddress: peer }, headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', 'x-dsh-mineru-management': '1', ...headers } } as unknown as IncomingMessage
  }
  it('accepts same-origin local JSON requests', () => { expect(() => requireLocalManagement(request(), '127.0.0.1')).not.toThrow() })
  it.each([
    [{ origin: 'https://attacker.example' }, '127.0.0.1'],
    [{ host: 'attacker.example' }, '127.0.0.1'],
    [{ 'x-dsh-mineru-management': undefined }, '127.0.0.1'],
    [{ 'sec-fetch-site': 'cross-site' }, '127.0.0.1'],
    [{ 'content-type': 'text/plain' }, '127.0.0.1'],
    [{}, '192.168.1.20'],
  ])('rejects untrusted management requests', (headers, peer) => {
    expect(() => requireLocalManagement(request(headers, peer), '127.0.0.1')).toThrow()
  })
  it('rejects all-interface hosts even for a local connection', () => {
    expect(() => requireLocalManagement(request(), '0.0.0.0')).toThrow()
  })
})
