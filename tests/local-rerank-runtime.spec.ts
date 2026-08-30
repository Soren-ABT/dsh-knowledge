import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_RERANK_PROTOCOL_VERSION, type LocalRerankRequest } from '../src/knowledge/rerank-protocol.js'

type Mode = 'success' | 'hang' | 'mismatch' | 'runtime_error'
const state = vi.hoisted(() => ({ mode: 'success' as Mode, instances: [] as FakeChild[] }))

class FakeChild extends EventEmitter {
  killed = false
  readonly requests: LocalRerankRequest[] = []

  send(message: LocalRerankRequest): boolean {
    this.requests.push(message)
    if (state.mode === 'hang') return true
    queueMicrotask(() => {
      if (state.mode === 'mismatch') {
        this.emit('message', { protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION, id: message.id, operation: 'load', ok: true })
      } else if (state.mode === 'runtime_error') {
        this.emit('message', {
          protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION,
          id: message.id,
          operation: message.operation,
          ok: false,
          error: { code: 'runtime_error', message: 'onnx failed', retryable: true },
        })
      } else {
        this.emit('message', {
          protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION,
          id: message.id,
          operation: message.operation,
          ok: true,
          ...(message.operation === 'rerank' ? { scores: message.texts.map((_, index) => index / 10) } : {}),
        })
      }
    })
    return true
  }

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', 1, 'SIGKILL'))
    return true
  }
}

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => {
    const child = new FakeChild()
    state.instances.push(child)
    return child
  }),
}))

import {
  LocalRerankError,
  disposeLocalRerankProcess,
  localRerankRuntimeSnapshot,
  rerankInLocalProcess,
  setLocalRerankIdleTimeoutMs,
} from '../src/knowledge/local-rerank.js'

describe('local rerank child-process runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    state.mode = 'success'
    state.instances.length = 0
    setLocalRerankIdleTimeoutMs(0)
  })

  afterEach(async () => {
    await disposeLocalRerankProcess()
    setLocalRerankIdleTimeoutMs(60_000)
    vi.useRealTimers()
  })

  it('dispatches a strict score response from the isolated process', async () => {
    const scores = await rerankInLocalProcess('test/success', 'cache', undefined, 'q', ['a', 'b'], 1000)
    expect(scores).toEqual([0, 0.1])
    expect(state.instances).toHaveLength(1)
    expect(state.instances[0]?.requests[0]).toMatchObject({ operation: 'rerank', query: 'q', texts: ['a', 'b'] })
  })

  it('rejects operation mismatches as invalid responses', async () => {
    state.mode = 'mismatch'
    await expect(rerankInLocalProcess('test/mismatch', 'cache', undefined, 'q', ['a'], 1000))
      .rejects.toMatchObject({ code: 'invalid_response' })
    expect(state.instances[0]?.killed).toBe(true)
  })

  it('hard-kills a hung process and starts a clean process on the next request', async () => {
    state.mode = 'hang'
    const pending = rerankInLocalProcess('test/timeout-recovery', 'cache', undefined, 'q', ['a'], 50)
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await timedOut
    expect(state.instances[0]?.killed).toBe(true)

    state.mode = 'success'
    await expect(rerankInLocalProcess('test/timeout-recovery', 'cache', undefined, 'q', ['a'], 1000)).resolves.toEqual([0])
    expect(state.instances).toHaveLength(2)
  })

  it('opens after three consecutive runtime failures', async () => {
    state.mode = 'runtime_error'
    for (let index = 0; index < 3; index += 1) {
      await expect(rerankInLocalProcess('test/circuit', 'cache', undefined, 'q', ['a'], 1000))
        .rejects.toMatchObject({ code: 'runtime_error' })
    }
    const before = state.instances[0]?.requests.length
    await expect(rerankInLocalProcess('test/circuit', 'cache', undefined, 'q', ['a'], 1000))
      .rejects.toMatchObject({ code: 'circuit_open' })
    expect(state.instances[0]?.requests.length).toBe(before)
  })

  it('serializes requests instead of sending concurrent inference', async () => {
    state.mode = 'hang'
    const first = rerankInLocalProcess('test/queue', 'cache', undefined, 'q1', ['a'], 1000)
    const second = rerankInLocalProcess('test/queue', 'cache', undefined, 'q2', ['b'], 1000)
    expect(localRerankRuntimeSnapshot()).toEqual({ active: true, queued: 1, process: true })
    await disposeLocalRerankProcess()
    await expect(first).rejects.toBeInstanceOf(LocalRerankError)
    await expect(second).rejects.toBeInstanceOf(LocalRerankError)
  })

  it('bounds queue pressure and degrades the seventeenth concurrent request', async () => {
    state.mode = 'hang'
    const accepted = Array.from({ length: 16 }, (_, index) =>
      rerankInLocalProcess('test/pressure', 'cache', undefined, `q${index}`, ['a'], 10_000))
    const handled = accepted.map(promise => promise.catch(error => error))
    await expect(rerankInLocalProcess('test/pressure', 'cache', undefined, 'overflow', ['a'], 10_000))
      .rejects.toMatchObject({ code: 'busy' })
    expect(localRerankRuntimeSnapshot()).toEqual({ active: true, queued: 15, process: true })
    await disposeLocalRerankProcess()
    expect((await Promise.all(handled)).every(error => error instanceof LocalRerankError)).toBe(true)
  })

  it('allows only one half-open recovery probe after cooldown', async () => {
    state.mode = 'runtime_error'
    for (let index = 0; index < 3; index += 1) {
      await expect(rerankInLocalProcess('test/half-open', 'cache', undefined, 'q', ['a'], 1000)).rejects.toBeInstanceOf(LocalRerankError)
    }
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    state.mode = 'hang'
    const probe = rerankInLocalProcess('test/half-open', 'cache', undefined, 'probe', ['a'], 10_000)
    const handledProbe = probe.catch(error => error)
    await expect(rerankInLocalProcess('test/half-open', 'cache', undefined, 'second', ['a'], 1000))
      .rejects.toMatchObject({ code: 'circuit_open' })
    await disposeLocalRerankProcess()
    expect(await handledProbe).toBeInstanceOf(LocalRerankError)
  })
})
