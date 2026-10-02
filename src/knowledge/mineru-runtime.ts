import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { checkDeploymentPath, DeploymentError } from './mineru-deployment-plan.js'
import { MINERU_RUNTIME_VERSION } from './mineru-manifest.js'
import { extractWithMineruLocal, probeMineruLocal } from './mineru-local.js'
import { probePythonExecutable } from './mineru-python.js'
import type { MineruPythonEnvironment, MineruValidationSteps } from './mineru-deployment-types.js'

export function runtimeEnvironment(root: string, configPath = join(root, 'config.yaml')): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  // Do not inherit Python/PIP config, HF credentials, proxy credentials or remote VLM configuration.
  for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) if (process.env[name]) result[name] = process.env[name]
  return { ...result, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMPDIR: join(root, 'tmp'),
    PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', MINERU_HOME: join(root, 'home'),
    MINERU_CONFIG: configPath, MINERU_MODEL_SOURCE: 'local', MINERU_MODEL_SMALL_BACKEND: 'onnx',
    HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' }
}

/** Only owned child trees are terminated; never look up a PID by port. */
export async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false })
    await Promise.race([new Promise<void>(resolve => { killer.once('error', () => resolve()); killer.once('close', () => resolve()) }), delay(5000)])
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  }
  await Promise.race([closed, delay(3000)])
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    else child.kill('SIGKILL')
    await Promise.race([closed, delay(3000)])
  }
  if (child.exitCode === null && child.signalCode === null) throw new DeploymentError('shutdown_failed', 'The owned MinerU process did not exit; its installation remains locked.')
}

export async function runManagedCommand(executable: string, args: string[], root: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  signal.throwIfAborted()
  const child = spawn(executable, args, { cwd: root, env: runtimeEnvironment(root), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let diagnostic = ''
  child.stdout?.on('data', chunk => { if (output.length < 4096) output += String(chunk).slice(0, 4096 - output.length) })
  child.stderr?.on('data', chunk => { if (diagnostic.length < 4096) diagnostic += String(chunk).slice(0, 4096 - diagnostic.length) })
  const budget = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  let terminate = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    terminate = () => { void stopOwnedChild(child).then(() => reject(budget.reason), reject) }
    budget.addEventListener('abort', terminate, { once: true })
    if (budget.aborted) terminate()
  })
  try {
    const code = await Promise.race([new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }), interrupted])
    budget.throwIfAborted()
    if (code !== 0) {
      const detail = diagnostic.trim().split(/\r?\n/).slice(-3).join(' ')
        .replaceAll(root, '<install>')
        .replace(/\b[A-Z]:\\[^\s"'<>]*/g, '<path>')
        .replace(/\/(?:home|Users|tmp|var|opt)\/[^\s"'<>]*/g, '<path>')
        .replace(/(token|password|secret|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
        .replace(/https?:\/\/[^/\s@]+:[^@\s/]+@/gi, 'https://[redacted]@')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, 400)
      throw new DeploymentError('runtime_command_failed', `MinerU environment preparation failed${code === null ? '' : ` (exit ${code})`}.${detail ? ` ${detail}` : ''} Completed model files are preserved.`)
    }
    return output.trim()
  } catch (error) {
    if (signal.aborted) throw error
    if (budget.aborted) throw new DeploymentError('runtime_timeout', 'MinerU environment preparation exceeded its time limit. Verified files and resumable downloads were retained.')
    if (error instanceof DeploymentError) throw error
    throw new DeploymentError('runtime_launch_failed', 'MinerU could not launch the selected Python command. Recheck the interpreter and its permissions.')
  } finally { budget.removeEventListener('abort', terminate) }
}

export async function prepareRuntime(root: string, environmentId: string, signal: AbortSignal, selected?: MineruPythonEnvironment,
  onValidated?: (step: keyof MineruValidationSteps) => void, pythonIndexUrl = 'https://pypi.org/simple'): Promise<string> {
  if (!selected?.eligible || !selected.fingerprint) throw new DeploymentError('python_required', 'Select and verify a compatible Python interpreter first.')
  const current = await probePythonExecutable(selected.executable, signal)
  if (!current.eligible || current.fingerprint !== selected.fingerprint) throw new DeploymentError('python_changed', 'The selected Python changed or became unavailable. Run preflight again.')
  onValidated?.('interpreter')
  for (const name of ['home', 'tmp', 'uploads', 'envs']) await mkdir(await checkDeploymentPath(join(root, name)), { recursive: true })
  // JSON is a YAML subset, avoiding path escaping/injection in a generated config.
  if (!/^[a-f0-9-]{36}$/.test(environmentId)) throw new DeploymentError('invalid_environment', 'Invalid environment identifier.')
  const envRoot = await checkDeploymentPath(join(root, 'envs', environmentId))
  await runManagedCommand(selected.executable, ['-I', '-m', 'venv', '--copies', envRoot], root, signal, 120_000)
  const python = join(envRoot, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  await writeFile(await checkDeploymentPath(join(envRoot, 'config.yaml')), JSON.stringify({ model: { source: 'local', base_dir: join(root, 'models'), small_backend: 'onnx', vlm: { server_url: '' } }, llm_aided: { api_key: '' } }), { mode: 0o600 })
  await runManagedCommand(python, ['-I', '-c', 'import sys; assert sys.prefix != sys.base_prefix'], root, signal, 15_000)
  onValidated?.('environment')
  await runManagedCommand(python, ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-input', '--index-url', pythonIndexUrl, `mineru==${MINERU_RUNTIME_VERSION}`], root, signal, 30 * 60_000)
  await runManagedCommand(python, ['-I', '-m', 'pip', '--isolated', 'check'], root, signal, 60_000)
  await runManagedCommand(python, ['-I', '-c', `import importlib.metadata as m; assert m.version('mineru') == '${MINERU_RUNTIME_VERSION}'`], root, signal, 30_000)
  onValidated?.('dependencies')
  return envRoot
}

export interface ManagedService { child: ChildProcess; url: string; apiKey: string; stop(): Promise<void> }
export async function startManagedService(root: string, envRoot: string, port: number, signal: AbortSignal): Promise<ManagedService> {
  signal.throwIfAborted()
  const socket = createServer()
  await new Promise<void>((resolve, reject) => {
    socket.once('error', () => reject(new DeploymentError('port_in_use', 'MinerU port 18879 is occupied. No existing process was stopped.')))
    socket.listen(port, '127.0.0.1', () => socket.close(error => error ? reject(error) : resolve()))
  })
  // The upstream V1 server does not document CLI API-key authentication. Keep
  // it on loopback and use only the stable, documented startup arguments.
  const apiKey = ''
  const executable = await checkDeploymentPath(join(envRoot, process.platform === 'win32' ? 'Scripts/mineru-kit.exe' : 'bin/mineru-kit'))
  const environmentConfig = await checkDeploymentPath(join(envRoot, 'config.yaml'))
  const configPath = await access(environmentConfig).then(() => environmentConfig, async () => {
    // Deployments prepared by earlier builds stored this file at the root.
    const legacyConfig = await checkDeploymentPath(join(root, 'config.yaml'))
    await access(legacyConfig)
    return legacyConfig
  })
  const child = spawn(executable, ['api-server', '--host', '127.0.0.1', '--port', String(port), '--tier', 'basic'],
    { cwd: root, env: runtimeEnvironment(root, configPath), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' })
  let spawnError = false
  child.on('error', () => { spawnError = true })
  const service: ManagedService = { child, url: `http://127.0.0.1:${port}`, apiKey, stop: () => stopOwnedChild(child) }
  const budget = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  try {
    while (true) {
      budget.throwIfAborted()
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new DeploymentError('service_exited', 'The managed service failed to start. Check runtime compatibility or port conflicts.')
      try {
        const capability = await probeMineruLocal({ apiUrl: service.url, apiKey, timeoutMs: 2000 }, budget)
        if (capability.version !== MINERU_RUNTIME_VERSION || !capability.tiers.includes('basic')) throw new DeploymentError('unsupported_service', 'Unexpected MinerU service version or tier.')
        return service
      } catch (error) { if (error instanceof DeploymentError) throw error }
      await delay(500, undefined, { signal: budget })
    }
  } catch (error) { await service.stop(); throw error }
}

export function syntheticMineruPdf(): Uint8Array {
  const content = 'BT /F1 18 Tf 50 730 Td (Synthetic public evidence fixture) Tj 0 -36 Td /F1 12 Tf (Sample A has mass 42 kg.) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

export async function probeManagedService(service: ManagedService, signal: AbortSignal): Promise<void> {
  const output = await extractWithMineruLocal(syntheticMineruPdf(), 'synthetic-public-evidence.pdf', { apiUrl: service.url, apiKey: service.apiKey, tier: 'basic', timeoutMs: 10 * 60_000 }, { signal })
  if (!output.document.blocks.some(block => block.pageIndex === 0 && /42\s*kg/.test(block.text))) throw new DeploymentError('probe_failed', 'The synthetic PDF did not preserve its expected text and page evidence.')
}
