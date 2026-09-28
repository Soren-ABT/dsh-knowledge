#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const python = process.env.MINERU_PYTHON
if (!python) throw new Error('Set MINERU_PYTHON to an absolute CPython executable before running this real-install smoke.')
const packageRoot = process.env.MINERU_PACKAGE_ROOT
  ? resolve(process.env.MINERU_PACKAGE_ROOT)
  : resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageEntry = join(packageRoot, 'lib', 'knowledge', 'mineru-deployment.mjs')
const { MineruDeployment, probeManagedMineruParse, MINERU_MODEL_REVISION, MINERU_RUNTIME_VERSION } = await import(pathToFileURL(packageEntry).href)

const root = await mkdtemp(join(tmpdir(), 'dsh-managed-mineru-smoke-'))
const installRoot = join(root, 'managed-install')
const pythonIndexUrl = process.env.MINERU_PYTHON_INDEX_URL || 'https://pypi.org/simple'
const sourceSettings = () => ({ hfEndpoint: process.env.HF_ENDPOINT, pythonIndexUrl })
const pointer = join(root, 'active.json')
const manager = new MineruDeployment(() => pointer, {}, sourceSettings)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForOperation(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await manager.status()
    if (!status.active) return status
    await sleep(1000)
  }
  manager.cancel()
  throw new Error('Managed MinerU operation exceeded the smoke timeout.')
}

try {
  const plan = await manager.preflight({ root: installRoot, pythonExecutable: python, hfEndpoint: process.env.HF_ENDPOINT, pythonIndexUrl })
  if (plan.blockers.length) throw new Error(`Managed MinerU preflight blocked: ${plan.blockers.join(', ')}`)
  console.log(JSON.stringify({
    event: 'preflight_passed',
    os: `${process.platform}/${process.arch}`,
    node: process.version,
    python: plan.python?.version,
    mineru: MINERU_RUNTIME_VERSION,
    modelRevision: MINERU_MODEL_REVISION,
    modelBytes: plan.capacity.totalBytes,
    downloadBytes: plan.capacity.downloadBytes,
    modelSource: new URL(plan.modelEndpoint).origin,
    pythonSource: new URL(plan.pythonIndexUrl).origin,
  }))

  await manager.prepare(plan.id)
  let status = await waitForOperation(90 * 60_000)
  if (status.phase !== 'ready' || status.validation?.inference !== true) throw new Error(`Managed MinerU preparation failed: ${status.error?.code ?? status.phase}`)

  for (let iteration = 0; iteration < 2; iteration++) {
    await manager.start()
    status = await waitForOperation(3 * 60_000)
    if (status.service !== 'running') throw new Error(`Managed MinerU service failed to start: ${status.error?.code ?? status.service}`)
    await probeManagedMineruParse(manager.connection(), AbortSignal.timeout(10 * 60_000))
    await manager.stop()
    status = await manager.status()
    if (status.service !== 'stopped' || status.phase !== 'ready') throw new Error('Managed MinerU failed its stop and restart lifecycle check.')
  }

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const report = {
    result: 'passed',
    sourceCommit: process.env.GITHUB_SHA || 'local',
    packageVersion: packageJson.version,
    packageEntry,
    tarballSha256: process.env.DSH_KNOWLEDGE_TARBALL_SHA256 || null,
    os: `${process.platform}/${process.arch}`,
    node: process.version,
    python: status.python?.version,
    mineru: MINERU_RUNTIME_VERSION,
    modelRevision: MINERU_MODEL_REVISION,
    modelBytes: plan.capacity.totalBytes,
    checked: ['cold-install', 'dependency-install', 'model-integrity', 'synthetic-inference', 'repeated-parse', 'stop-restart'],
  }
  console.log(`managed MinerU smoke report: ${JSON.stringify(report)}`)
  if (process.env.MINERU_SMOKE_REPORT_PATH) {
    await mkdir(dirname(process.env.MINERU_SMOKE_REPORT_PATH), { recursive: true })
    await writeFile(process.env.MINERU_SMOKE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
} finally {
  await manager.dispose().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
