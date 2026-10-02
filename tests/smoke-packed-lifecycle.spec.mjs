import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  formatUninstallWarning,
  runSupervised,
  verifyUninstallOutcome,
} from '../scripts/smoke-packed-lifecycle.mjs'
import { waitForKnowledge } from '../scripts/smoke-packed-install.mjs'

class FakeChild extends EventEmitter {
  pid = 4321
  exitCode = null
  kill = vi.fn()
}

const removedManifest = {
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}

describe('packed smoke process lifecycle', () => {
  it('rejects a host that exits just after serving a successful route', async () => {
    const child = new FakeChild()
    const fetchImpl = vi.fn(async () => {
      child.exitCode = 1
      return { ok: true, text: async () => '{"ok":true,"value":[]}' }
    })
    await expect(waitForKnowledge(31879, child, () => 'HMR failed', { fetchImpl }))
      .rejects.toThrow('DSH exited during startup (1)\n\nHMR failed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('requires a continuous healthy interval while the host remains alive', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '{"ok":true,"value":[]}' }))
      let settled = false
      const result = waitForKnowledge(31879, child, () => '', {
        fetchImpl, stableMs: 1_000, pollMs: 250,
      }).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(750)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(250)
      await result
      expect(fetchImpl).toHaveBeenCalledTimes(5)
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the healthy interval when a later request fails', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => '{"ok":true,"value":[]}' }))
      fetchImpl.mockRejectedValueOnce(new Error('not listening'))
      fetchImpl.mockResolvedValueOnce({ ok: true, text: async () => '{"ok":true,"value":[]}' })
      fetchImpl.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'starting' })
      let settled = false
      const result = waitForKnowledge(31879, child, () => '', {
        fetchImpl, stableMs: 1_000, pollMs: 250,
      }).then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(1_500)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(250)
      await result
      expect(fetchImpl).toHaveBeenCalledTimes(8)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports spawn failures promptly with the captured logs', async () => {
    const child = new FakeChild()
    const fetchImpl = vi.fn(async () => {
      child.emit('error', new Error('ENOENT'))
      throw new Error('not listening')
    })
    await expect(waitForKnowledge(31879, child, () => 'spawn error', { fetchImpl }))
      .rejects.toThrow('DSH could not start: ENOENT\n\nspawn error')
    expect(child.listenerCount('error')).toBe(0)
  })

  it('reports a clean zero exit', async () => {
    const child = new FakeChild()
    const outcomePromise = runSupervised('dsh', ['plugin', 'remove'], {
      timeoutMs: 100,
      spawnImpl: () => child,
    })
    child.exitCode = 0
    child.emit('exit', 0, null)
    await expect(outcomePromise).resolves.toEqual({ kind: 'exited', code: 0, signal: null })
    expect(verifyUninstallOutcome(await outcomePromise, removedManifest)).toBeUndefined()
  })

  it('rejects a non-zero normal exit even when the manifest is clean', () => {
    expect(() => verifyUninstallOutcome({ kind: 'exited', code: 1, signal: null }, removedManifest))
      .toThrow('exited unsuccessfully')
  })

  it('propagates a spawn failure', async () => {
    const child = new FakeChild()
    const failure = new Error('spawn failed')
    const outcomePromise = runSupervised('dsh', [], { timeoutMs: 100, spawnImpl: () => child })
    child.emit('error', failure)
    const outcome = await outcomePromise
    expect(outcome).toEqual({ kind: 'spawn_error', error: failure })
    expect(() => verifyUninstallOutcome(outcome, removedManifest)).toThrow(failure)
  })

  it('accepts a reclaimed timeout only when the manifest is clean', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeChild()
      const terminateTree = vi.fn(async () => {
        child.exitCode = null
        child.emit('exit', null, 'SIGKILL')
      })
      const outcomePromise = runSupervised('dsh', [], {
        timeoutMs: 25,
        terminationGraceMs: 10,
        spawnImpl: () => child,
        terminateTree,
      })
      await vi.advanceTimersByTimeAsync(25)
      const outcome = await outcomePromise
      expect(outcome).toEqual({ kind: 'timed_out' })
      expect(terminateTree).toHaveBeenCalledTimes(1)
      expect(terminateTree).toHaveBeenCalledWith(child, 10)
      expect(verifyUninstallOutcome(outcome, removedManifest)).toContain('on-disk uninstall state was verified')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a timeout when the package dependency remains', () => {
    const manifest = {
      dependencies: { 'dsh-knowledge': 'file:plugin.tgz' },
      dsh: { profile: { bundles: [] } },
    }
    expect(() => verifyUninstallOutcome({ kind: 'timed_out' }, manifest)).toThrow('profile package')
  })

  it('warns by default when a timeout leaves only the upstream bundle reconciliation pending', () => {
    const manifest = {
      dependencies: {},
      dsh: { profile: { bundles: ['dsh-knowledge'] } },
    }
    expect(verifyUninstallOutcome({ kind: 'timed_out' }, manifest)).toContain('known upstream DSH CLI cleanup issue')
  })

  it('rejects a partial timeout in strict uninstall mode', () => {
    const manifest = {
      dependencies: {},
      dsh: { profile: { bundles: ['dsh-knowledge'] } },
    }
    expect(() => verifyUninstallOutcome(
      { kind: 'timed_out' },
      manifest,
      { strictBundleCleanup: true },
    )).toThrow('bundle stack')
  })

  it('rejects a zero exit that leaves the bundle stack inconsistent', () => {
    const manifest = {
      dependencies: {},
      dsh: { profile: { bundles: ['dsh-knowledge'] } },
    }
    expect(() => verifyUninstallOutcome({ kind: 'exited', code: 0, signal: null }, manifest))
      .toThrow('bundle stack')
  })

  it('formats a sanitized native warning for GitHub Actions', () => {
    expect(formatUninstallWarning('cleanup stalled\nprofile is temporary', { githubActions: true }))
      .toBe('::warning title=DSH uninstall reconciliation::cleanup stalled profile is temporary')
    expect(formatUninstallWarning('progress: 50%', { githubActions: true }))
      .toContain('50%25')
  })

  it('keeps local warnings concise without workflow command syntax', () => {
    expect(formatUninstallWarning('cleanup stalled\r\nprofile is temporary'))
      .toBe('cleanup stalled profile is temporary')
  })
})
