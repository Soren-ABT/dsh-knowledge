import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { runSupervised, verifyUninstallOutcome } from '../scripts/smoke-packed-lifecycle.mjs'

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

  it.each([
    [{ dependencies: { 'dsh-knowledge': 'file:plugin.tgz' }, dsh: { profile: { bundles: [] } } }, 'profile package'],
    [{ dependencies: {}, dsh: { profile: { bundles: ['dsh-knowledge'] } } }, 'bundle stack'],
  ])('rejects a timeout when uninstall state remains (%s)', (manifest, message) => {
    expect(() => verifyUninstallOutcome({ kind: 'timed_out' }, manifest)).toThrow(message)
  })
})
