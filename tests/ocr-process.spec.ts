import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { OcrProcessClient } from '../src/knowledge/ocr-process-client.js'

const fixture = fileURLToPath(new URL('./fixtures/ocr-process.mjs', import.meta.url))
const clients: OcrProcessClient[] = []
function client(timeoutMs = 3000) {
  const value = new OcrProcessClient(fixture, timeoutMs)
  clients.push(value)
  return value
}
afterEach(async () => { await Promise.all(clients.splice(0).map(value => value.dispose())) })

describe('isolated OCR inference (#37)', () => {
  it('round-trips binary PNG bytes without JSON Buffer corruption', async () => {
    const value = client()
    const replies = await Promise.all([
      value.recognize(Buffer.from([0, 128, 255]), 'ready'),
      value.recognize(Buffer.from([1, 2]), 'ready'),
    ])
    expect(replies[0]).toMatch(/\d+:buffer:0080ff$/)
    expect(replies[1]).toMatch(/\d+:buffer:0102$/)
    expect(replies[0].split(':')[0]).toBe(replies[1].split(':')[0])
    expect(Number(replies[0].split(':')[0])).not.toBe(process.pid)
  })

  it('fails all pending work on a child crash and permits a later explicit retry', async () => {
    const value = client()
    const results = await Promise.allSettled([
      value.recognize(Buffer.from([1]), 'crash'),
      value.recognize(Buffer.from([2]), 'hang'),
    ])
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason.code).toBe('ocr_process_crash')
    }
    expect(await value.recognize(Buffer.from([3]), 'ready')).toMatch(/:buffer:03$/)
  })

  it('detects a lost IPC channel without waiting for the request deadline', async () => {
    await expect(client().recognize(Buffer.from([1]), 'disconnect')).rejects.toMatchObject({ code: 'ocr_process_crash' })
  })

  it('settles existing work when a later IPC payload cannot be serialized', async () => {
    const value = client()
    const first = value.recognize(Buffer.from([1]), 'hang')
    const invalidPayload = (() => {}) as unknown as string
    const results = await Promise.allSettled([first, value.recognize(Buffer.from([2]), invalidPayload)])
    expect(results.every(result => result.status === 'rejected'
      && result.reason.code === 'ocr_process_crash')).toBe(true)
    expect(await value.recognize(Buffer.from([3]), 'ready')).toMatch(/:buffer:03$/)
  })

  it('terminates a hung child and does not leave requests stuck behind it', async () => {
    const value = client(1000)
    await expect(value.recognize(Buffer.from([1]), 'hang')).rejects.toMatchObject({ code: 'ocr_timeout' })
    expect(await value.recognize(Buffer.from([4]), 'ready')).toMatch(/:buffer:04$/)
  })

  it('awaits teardown, rejects active work, and can start a fresh child', async () => {
    const value = client()
    const rejected = expect(value.recognize(Buffer.from([1]), 'hang')).rejects.toThrow('disposed')
    await Promise.all([value.dispose(), value.dispose()])
    await rejected
    expect(await value.recognize(Buffer.from([5]), 'ready')).toMatch(/:buffer:05$/)
  })

  it('bounds queued work and settles every waiter on disposal', async () => {
    const value = client()
    const pending = Promise.allSettled(Array.from({ length: 16 }, () => value.recognize(Buffer.from([1]), 'hang')))
    await expect(value.recognize(Buffer.from([1]), 'hang')).rejects.toMatchObject({ code: 'ocr_busy' })
    await value.dispose()
    expect((await pending).every(result => result.status === 'rejected')).toBe(true)
  })

  it('rejects malformed replies without poisoning the next request', async () => {
    const value = client()
    await expect(value.recognize(Buffer.from([1]), 'invalid')).rejects.toMatchObject({ code: 'ocr_failed' })
    expect(await value.recognize(Buffer.from([6]), 'ready')).toMatch(/:buffer:06$/)
  })
})
