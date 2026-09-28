import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parsePythonProbe, parsePythonLauncherPaths, probePythonExecutable, validatePythonExecutable } from '../src/knowledge/mineru-python.js'

const valid = { version: [3, 13, 7], release: 'final', implementation: 'CPython', architecture: 'AMD64', bits: 64, venv: true, ensurepip: true, free_threaded: false }
const parse = (changes: Record<string, unknown> = {}) => parsePythonProbe('/python', 'fixture', JSON.stringify({ ...valid, ...changes }))
describe('Python interpreter eligibility (not inference readiness)', () => {
  it.each([10, 11, 12, 13, 14])('accepts stable CPython 3.%s with required standard modules', minor => {
    expect(parse({ version: [3, minor, 0] })).toMatchObject({ eligible: true })
  })
  it.each([
    [{ version: [3, 9, 0] }, 'version_unsupported'], [{ version: [3, 15, 0] }, 'version_unsupported'],
    [{ implementation: 'PyPy' }, 'implementation_unsupported'], [{ bits: 32 }, 'architecture_unsupported'],
    [{ release: 'candidate' }, 'prerelease'], [{ free_threaded: true }, 'free_threaded'],
    [{ venv: false }, 'venv_missing'], [{ ensurepip: false }, 'ensurepip_missing'],
  ])('reports an explicit rejection reason for %j', (changes, reason) => {
    expect(parse(changes as Record<string, unknown>)).toMatchObject({ eligible: false, reason })
  })
  it('rejects malformed output and command strings', () => {
    expect(() => parse({ version: ['3', 13, 0] })).toThrow()
    expect(() => parsePythonProbe('/python', 'fixture', 'not JSON')).toThrow()
    for (const path of ['python', 'python --version', '//server/python.exe', join(tmpdir(), 'cmd.exe')]) expect(() => validatePythonExecutable(path)).toThrow()
  })
  it('parses launcher paths including spaces', () => {
    expect(parsePythonLauncherPaths(' -V:3.13 * C:\\Program Files\\Python313\\python.exe\r\ninvalid')).toEqual(['C:\\Program Files\\Python313\\python.exe'])
  })
  it('uses isolated fixed arguments, fingerprints file changes, and handles failed or canceled probes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mineru-python-'))
    const path = join(root, 'python.exe')
    try {
      await writeFile(path, 'fixture')
      const runner = async (file: string, args: string[]) => { expect(file).toBe(path); expect(args.slice(0, 3)).toEqual(['-I', '-S', '-c']); return JSON.stringify(valid) }
      const first = await probePythonExecutable(path, undefined, runner)
      expect(first.eligible).toBe(true)
      await writeFile(path, 'changed fixture')
      expect((await probePythonExecutable(path, undefined, runner)).fingerprint).not.toBe(first.fingerprint)
      expect(await probePythonExecutable(path, undefined, async () => { throw new Error('timeout') })).toMatchObject({ eligible: false, reason: 'probe_failed' })
      await expect(probePythonExecutable(path, AbortSignal.abort(), runner)).rejects.toBeDefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
