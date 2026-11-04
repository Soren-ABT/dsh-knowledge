import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectorySyncScheduler } from '../src/knowledge/directory-sync-scheduler.js'

afterEach(() => vi.useRealTimers())

describe('scheduled directory sync', () => {
  it('waits for the configured interval and rearms only after completion', async () => {
    vi.useFakeTimers()
    let finish: () => void = () => {}
    const sync = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const scheduler = new DirectorySyncScheduler(sync, vi.fn())
    scheduler.configure('wiki', 5)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(sync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledExactlyOnceWith('wiki')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(sync).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(2)
    scheduler.dispose()
    finish()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('does not revive an in-flight source after it is disabled or removed', async () => {
    vi.useFakeTimers()
    let finish: () => void = () => {}
    const sync = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const scheduler = new DirectorySyncScheduler(sync, vi.fn())
    scheduler.configure('wiki', 5)
    await vi.advanceTimersByTimeAsync(300_000)
    scheduler.configure('wiki', 0)
    finish()
    await vi.advanceTimersByTimeAsync(900_000)
    expect(sync).toHaveBeenCalledTimes(1)
    scheduler.configure('wiki', 15)
    scheduler.remove('wiki')
    await vi.advanceTimersByTimeAsync(900_000)
    expect(sync).toHaveBeenCalledTimes(1)
    scheduler.dispose()
  })

  it('reports a failed run and retries at the next interval', async () => {
    vi.useFakeTimers()
    const error = new Error('source unavailable')
    const sync = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const onError = vi.fn()
    const scheduler = new DirectorySyncScheduler(sync, onError)
    scheduler.configure('wiki', 5)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(onError).toHaveBeenCalledExactlyOnceWith('wiki', error)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sync).toHaveBeenCalledTimes(2)
    scheduler.dispose()
  })
})
