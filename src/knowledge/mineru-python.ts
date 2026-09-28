import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import type { MineruPythonDiscovery, MineruPythonEnvironment } from './mineru-deployment-types.js'
import { DeploymentError } from './mineru-deployment-plan.js'

const PROBE = 'import sys,struct,platform,sysconfig,importlib.util,json; print(json.dumps(dict(version=list(sys.version_info[:3]),release=sys.version_info.releaselevel,implementation=platform.python_implementation(),architecture=platform.machine(),bits=struct.calcsize("P")*8,venv=importlib.util.find_spec("venv") is not None,ensurepip=importlib.util.find_spec("ensurepip") is not None,free_threaded=bool(sysconfig.get_config_var("Py_GIL_DISABLED")))))'
type CommandRunner = (file: string, args: string[], signal?: AbortSignal) => Promise<string>

const run: CommandRunner = (file, args, signal) => new Promise((resolveResult, reject) => {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key]
  execFile(file, args, { env, cwd: homedir(), windowsHide: true, shell: false, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, signal }, (error, stdout) => error ? reject(error) : resolveResult(stdout))
})

export function validatePythonExecutable(value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || /[\0\r\n]/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || !/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(value))) {
    throw new DeploymentError('invalid_python_path', 'Select an absolute local Python executable path, not a shell command or directory.')
  }
  if (process.platform === 'win32' && value.slice(2).includes(':')) throw new DeploymentError('invalid_python_path', 'Alternate data stream paths are not supported.')
  return resolve(value)
}

export function parsePythonProbe(executable: string, source: string, output: string): MineruPythonEnvironment {
  const data = JSON.parse(output)
  if (!data || !Array.isArray(data.version) || data.version.length !== 3 || !data.version.every((v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0) || typeof data.release !== 'string' || typeof data.implementation !== 'string' || typeof data.architecture !== 'string' || ![32, 64].includes(data.bits) || typeof data.venv !== 'boolean' || typeof data.ensurepip !== 'boolean' || typeof data.free_threaded !== 'boolean') throw new Error('Invalid Python probe')
  const result: MineruPythonEnvironment = { executable, source, version: data.version.join('.'), implementation: data.implementation, architecture: data.architecture, bits: data.bits, venv: data.venv, ensurepip: data.ensurepip, eligible: false }
  if (data.implementation !== 'CPython') result.reason = 'implementation_unsupported'
  else if (data.version[0] !== 3 || data.version[1] < 10 || data.version[1] >= 15) result.reason = 'version_unsupported'
  else if (data.bits !== 64) result.reason = 'architecture_unsupported'
  else if (data.release !== 'final') result.reason = 'prerelease'
  else if (data.free_threaded) result.reason = 'free_threaded'
  else if (!data.venv) result.reason = 'venv_missing'
  else if (!data.ensurepip) result.reason = 'ensurepip_missing'
  else result.eligible = true
  result.fingerprint = createHash('sha256').update(JSON.stringify([executable, result.version, data.implementation, data.architecture, data.bits, data.release, data.free_threaded, data.venv, data.ensurepip])).digest('hex')
  return result
}

export async function probePythonExecutable(value: string, signal?: AbortSignal, runner: CommandRunner = run, source = 'manual'): Promise<MineruPythonEnvironment> {
  const executable = validatePythonExecutable(value)
  signal?.throwIfAborted()
  try {
    const info = await stat(executable)
    if (!info.isFile()) throw new Error('Not a file')
    const result = parsePythonProbe(executable, source, await runner(executable, ['-I', '-S', '-c', PROBE], signal))
    result.fingerprint = createHash('sha256').update(JSON.stringify([result.fingerprint, await realpath(executable), info.size, info.mtimeMs])).digest('hex')
    return result
  } catch { signal?.throwIfAborted(); return { executable, source, eligible: false, reason: 'probe_failed' } }
}

export function parsePythonLauncherPaths(output: string): string[] {
  return output.split(/\r?\n/).flatMap(line => { const match = line.match(/([a-zA-Z]:\\.*\\python(?:\d+(?:\.\d+)*)?\.exe)\s*$/i); return match ? [match[1]] : [] })
}

export async function discoverPythonEnvironments(signal?: AbortSignal): Promise<MineruPythonDiscovery> {
  const budget = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)])
  const candidates = new Map<string, string>()
  let truncated = false
  const add = (path: string, source: string) => {
    try { const normalized = validatePythonExecutable(path); if (!candidates.has(normalized)) candidates.set(normalized, source) } catch { /* not an executable candidate */ }
  }
  const names = process.platform === 'win32' ? ['python.exe', 'python3.exe', ...[10, 11, 12, 13, 14].map(v => `python3.${v}.exe`)] : ['python3', 'python', ...[10, 11, 12, 13, 14].map(v => `python3.${v}`)]
  for (const path of (process.env.PATH ?? process.env.Path ?? '').split(delimiter).slice(0, 128)) {
    if (!path || !isAbsolute(path) || /[\\/]WindowsApps(?:[\\/]|$)/i.test(path)) continue // avoid Store launch aliases
    for (const name of names) add(join(path, name), 'PATH')
  }
  if (process.platform === 'win32') {
    try { for (const path of parsePythonLauncherPaths(await run('py.exe', ['-0p'], budget))) add(path, 'Python launcher') } catch { signal?.throwIfAborted() }
  }
  const home = homedir()
  try {
    const registry = join(home, '.conda', 'environments.txt')
    if ((await stat(registry)).size <= 64 * 1024) for (const prefix of (await readFile(registry, 'utf8')).split(/\r?\n/).slice(0, 128)) {
      if (isAbsolute(prefix.trim())) add(join(prefix.trim(), process.platform === 'win32' ? 'python.exe' : 'bin/python'), 'Conda registry')
    }
  } catch { /* missing registry is normal */ }
  if (process.env.CONDA_PREFIX) add(join(process.env.CONDA_PREFIX, process.platform === 'win32' ? 'python.exe' : 'bin/python'), 'Active Conda')
  const roots = process.platform === 'win32'
    ? [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python'), join(home, '.conda', 'envs'), join(home, 'miniconda3', 'envs'), join(home, 'anaconda3', 'envs'), join(home, '.pyenv', 'pyenv-win', 'versions')]
    : [join(home, '.pyenv', 'versions'), join(home, '.local', 'share', 'uv', 'python'), join(home, 'miniconda3', 'envs'), join(home, 'anaconda3', 'envs'), '/Library/Frameworks/Python.framework/Versions']
  for (const root of roots) if (root) {
    try {
      const children = await readdir(root, { withFileTypes: true })
      if (children.length > 64) truncated = true
      for (const child of children.slice(0, 64)) if (child.isDirectory()) {
        add(join(root, child.name, process.platform === 'win32' ? 'python.exe' : 'bin/python3'), 'Common location')
        if (process.platform !== 'win32') add(join(root, child.name, 'bin/python'), 'Common location')
      }
    } catch { /* location absent or inaccessible */ }
  }
  const existing: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const [path, source] of candidates) {
    budget.throwIfAborted()
    try {
      if (!(await stat(path)).isFile()) continue
      const canonical = await realpath(path)
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
      if (seen.has(key)) continue
      seen.add(key); existing.push([path, source])
      if (existing.length === 32) { truncated = true; break }
    } catch { /* missing candidate */ }
  }
  const environments: MineruPythonEnvironment[] = []
  // Bounded concurrency; each process has an independent timeout/output limit.
  for (let index = 0; index < existing.length; index += 4) {
    budget.throwIfAborted()
    environments.push(...await Promise.all(existing.slice(index, index + 4).map(([path, source]) => probePythonExecutable(path, budget, run, source))))
  }
  environments.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.executable.localeCompare(b.executable))
  return { environments, truncated }
}
