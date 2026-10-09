import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface ProcessDouble {
  readonly messages: unknown[]
  connected: boolean
  killed: boolean
}

type ProcessMode = 'success' | 'crash_once' | 'mismatch' | 'invalid_vectors' | 'hang_download' | 'runtime_error_once'
const processState = vi.hoisted(() => ({ instances: [] as ProcessDouble[], mode: 'success' as ProcessMode }))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeProcess extends EventEmitter implements ProcessDouble {
    readonly messages: unknown[] = []
    connected = true
    killed = false

    unref(): this { return this }

    send(message: unknown): boolean {
      this.messages.push(message)
      const request = message as { protocolVersion?: number; id?: number; operation?: string; cacheDir?: string; modelId?: string }
      if (request.id !== undefined && request.operation !== undefined) {
        if (request.operation === 'embed' && processState.mode === 'crash_once') {
          processState.mode = 'success'
          queueMicrotask(() => this.emit('exit', 1, 'SIGKILL'))
          return true
        }
        if (request.operation === 'embed' && processState.mode === 'runtime_error_once') {
          // A failure the child reports about itself (ONNX session, invalid
          // response) is process-local: the runtime must replace the child
          // rather than retry inside the same one.
          processState.mode = 'success'
          queueMicrotask(() => this.emit('message', {
            protocolVersion: request.protocolVersion,
            id: request.id,
            operation: request.operation,
            ok: false,
            error: { code: 'runtime_error', message: 'onnx failed', retryable: true },
          }))
          return true
        }
        if (request.operation === 'download' && processState.mode === 'hang_download') {
          queueMicrotask(() => this.emit('message', {
            type: 'progress', modelId: request.modelId, status: 'downloading', progress: 20, message: '',
          }))
          return true
        }
        if (request.operation === 'download' && request.cacheDir !== undefined && request.modelId !== undefined) {
          queueMicrotask(async () => {
            const root = join(request.cacheDir!, request.modelId!)
            await mkdir(join(root, 'onnx'), { recursive: true })
            await writeFile(join(root, 'config.json'), '{}')
            await writeFile(join(root, 'tokenizer.json'), '{}')
            await writeFile(join(root, 'onnx', 'model.onnx'), 'weights')
            this.emit('message', { protocolVersion: request.protocolVersion, id: request.id, operation: request.operation, ok: true })
          })
          return true
        }
        queueMicrotask(() => this.emit('message', {
          protocolVersion: request.protocolVersion,
          id: request.id,
          operation: processState.mode === 'mismatch' ? 'load' : request.operation,
          ok: true,
          ...(request.operation === 'embed'
            ? { vectors: processState.mode === 'invalid_vectors' ? [[Number.NaN]] : [[1, 0]] }
            : {}),
        }))
      }
      return true
    }

    kill(): boolean {
      this.killed = true
      this.connected = false
      queueMicrotask(() => this.emit('exit', 0, null))
      return true
    }
  }

  return {
    fork: () => {
      const child = new FakeProcess()
      processState.instances.push(child)
      return child
    },
  }
})

import {
  disposeLocalModelWorker,
  cancelLocalModel,
  embedTexts,
  getLocalModelStatus,
  loadLocalModel,
  setLocalModelCacheDir,
  setLocalWorkerIdleTimeoutMs,
} from '../src/knowledge/embed.js'

describe('local embedding process lifecycle', () => {
  let root = ''

  beforeEach(async () => {
    vi.useFakeTimers()
    processState.instances.length = 0
    processState.mode = 'success'
    root = await mkdtemp(join(tmpdir(), 'dsh-local-embed-'))
    const model = join(root, 'test', 'model')
    await mkdir(join(model, 'onnx'), { recursive: true })
    await writeFile(join(model, 'config.json'), '{}')
    await writeFile(join(model, 'tokenizer.json'), '{}')
    await writeFile(join(model, 'onnx', 'model.onnx'), 'weights')
    setLocalModelCacheDir(root)
  })

  afterEach(async () => {
    await disposeLocalModelWorker()
    setLocalWorkerIdleTimeoutMs(60_000)
    setLocalModelCacheDir(undefined)
    await rm(root, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('releases an idle model without restarting the embedding process', async () => {
    setLocalWorkerIdleTimeoutMs(100)
    await loadLocalModel('test/model')

    const child = processState.instances[0]
    expect(child).toBeDefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(child.messages).toContainEqual(expect.objectContaining({ operation: 'release', modelId: 'test/model' }))
    expect(child.killed).toBe(false)

    await loadLocalModel('test/model')
    expect(processState.instances).toHaveLength(1)
    expect(child.killed).toBe(false)
  })

  it('repairs malformed text before passing it to the local embedding process', async () => {
    const texts = Object.freeze(['before\uD83Dafter📝\uDCDDtail'])
    await expect(embedTexts('local', '', 'test/model', '', texts)).resolves.toEqual([[1, 0]])
    expect(processState.instances[0]?.messages).toContainEqual(expect.objectContaining({
      operation: 'embed', modelId: 'test/model', texts: ['before\uFFFDafter📝\uFFFDtail'],
    }))
    expect(texts).toEqual(['before\uD83Dafter📝\uDCDDtail'])
  })

  it('rearms a live positive timeout and cancels it when set to zero', async () => {
    setLocalWorkerIdleTimeoutMs(1_000)
    await loadLocalModel('test/model')
    const child = processState.instances[0]

    await vi.advanceTimersByTimeAsync(500)
    setLocalWorkerIdleTimeoutMs(2_000)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(child.messages.filter(message => (message as { operation?: string }).operation === 'release')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.messages.filter(message => (message as { operation?: string }).operation === 'release')).toHaveLength(1)

    setLocalWorkerIdleTimeoutMs(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(child.messages.filter(message => (message as { operation?: string }).operation === 'release')).toHaveLength(1)
  })

  it('rejects mismatched or malformed process responses instead of accepting weakly typed data', async () => {
    processState.mode = 'mismatch'
    await expect(embedTexts('local', '', 'test/model', '', ['evidence'])).rejects.toThrow(/invalid response operation/)

    await disposeLocalModelWorker()
    processState.mode = 'invalid_vectors'
    await expect(embedTexts('local', '', 'test/model', '', ['evidence'])).rejects.toThrow(/invalid vector/)
  })

  it('recovers once from a crashed embedding child without restarting the host', async () => {
    processState.mode = 'crash_once'
    await expect(embedTexts('local', '', 'test/model', '', ['evidence'])).resolves.toEqual([[1, 0]])
    expect(processState.instances).toHaveLength(2)
    expect(processState.instances[0]?.killed).toBe(false)
  })

  it('replaces the child when it reports a runtime error, so the retry is a real restart', async () => {
    processState.mode = 'runtime_error_once'
    await expect(embedTexts('local', '', 'test/model', '', ['evidence'])).resolves.toEqual([[1, 0]])
    // Retrying inside the SAME child cannot heal an ONNX failure — the binding
    // that failed to register stays failed for the life of that process — so the
    // runtime must replace it for the single retry to mean anything (issue #17c).
    expect(processState.instances).toHaveLength(2)
    expect(processState.instances[0]?.killed).toBe(true)
  })

  it('promotes a fully probed staging download without overwriting the final cache mid-download', async () => {
    await loadLocalModel('new/model')
    await expect(stat(join(root, 'new', 'model', 'onnx', 'model.onnx'))).resolves.toBeDefined()
    await expect(stat(join(root, '.staging', 'new', 'model'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cancels only the staging download and leaves a ready final model untouched', async () => {
    processState.mode = 'hang_download'
    const loading = loadLocalModel('cancel/model').catch(error => error)
    // The status flips only after the real "is this model already cached?"
    // filesystem probe settles, so wait on a wall-clock deadline rather than a
    // fixed iteration budget: a contended CI runner can need far more
    // event-loop turns than any small constant allows, and this assertion used
    // to fail intermittently with 'idle' on the Node 24 quality job. hrtime is
    // never faked by the timer mock, and advanceTimersByTimeAsync still yields
    // to the real event loop so the pending fs callbacks can complete.
    const deadline = process.hrtime.bigint() + 5_000_000_000n
    while (getLocalModelStatus('cancel/model').status !== 'downloading' && process.hrtime.bigint() < deadline) {
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(getLocalModelStatus('cancel/model').status).toBe('downloading')
    await cancelLocalModel('cancel/model')
    expect(getLocalModelStatus('cancel/model').status).toBe('idle')
    await expect(stat(join(root, 'cancel', 'model'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await loading).toBeInstanceOf(Error)
  })
})
