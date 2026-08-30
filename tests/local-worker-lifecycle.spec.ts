import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface WorkerDouble {
  readonly messages: unknown[]
  terminated: boolean
}

const workerState = vi.hoisted(() => ({ instances: [] as WorkerDouble[] }))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeWorker extends EventEmitter implements WorkerDouble {
    readonly messages: unknown[] = []
    terminated = false

    constructor(_path: string) {
      super()
      workerState.instances.push(this)
    }

    unref(): this {
      return this
    }

    postMessage(message: unknown): void {
      this.messages.push(message)
      const request = message as { id?: number; type?: string }
      if (request.id !== undefined) {
        queueMicrotask(() => this.emit('message', { id: request.id, ok: true, vectors: [[1]] }))
      } else if (request.type === 'release-models') {
        queueMicrotask(() => this.emit('message', { type: 'released', modelId: '' }))
      }
    }

    async terminate(): Promise<number> {
      this.terminated = true
      return 0
    }
  }

  return { Worker: FakeWorker }
})

import {
  disposeLocalModelWorker,
  loadLocalModel,
  setLocalWorkerIdleTimeoutMs,
} from '../src/knowledge/embed.js'

describe('local embedding worker lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    workerState.instances.length = 0
  })

  afterEach(async () => {
    await disposeLocalModelWorker()
    setLocalWorkerIdleTimeoutMs(60_000)
    vi.useRealTimers()
  })

  it('unloads models after idle while keeping and reusing the same worker', async () => {
    setLocalWorkerIdleTimeoutMs(100)
    await loadLocalModel('test/model')

    const worker = workerState.instances[0]
    expect(worker).toBeDefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(worker.messages).toContainEqual({ type: 'release-models' })
    expect(worker.terminated).toBe(false)

    await loadLocalModel('test/model')
    expect(workerState.instances).toHaveLength(1)
    expect(worker.terminated).toBe(false)
  })

  it('rearms a live positive timeout and cancels it when set to zero', async () => {
    setLocalWorkerIdleTimeoutMs(1_000)
    await loadLocalModel('test/model')
    const worker = workerState.instances[0]

    await vi.advanceTimersByTimeAsync(500)
    setLocalWorkerIdleTimeoutMs(2_000)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(worker.messages).not.toContainEqual({ type: 'release-models' })
    await vi.advanceTimersByTimeAsync(1)
    expect(worker.messages).toContainEqual({ type: 'release-models' })

    const releases = worker.messages.filter(message => (message as { type?: string }).type === 'release-models').length
    setLocalWorkerIdleTimeoutMs(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(worker.messages.filter(message => (message as { type?: string }).type === 'release-models')).toHaveLength(releases)
  })
})
