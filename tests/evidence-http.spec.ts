import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { knowledgeRoute } from '../src/knowledge/http.js'
import type { KnowledgeService } from '../src/knowledge/index.js'
import type { KnowledgeDocument } from '../src/knowledge/types.js'
import { composeDocumentEvidence } from '../src/knowledge/evidence.js'
import { parsedTextDocument } from '../src/knowledge/parsed-document.js'
import { vi } from 'vitest'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

describe('evidence HTTP boundary', () => {
  it('protects managed preflight before invoking filesystem work', async () => {
    const preflight = vi.fn(async (input: unknown) => ({ id: 'plan', input }))
    const prepare = vi.fn(async () => ({ phase: 'preparing_environment', active: true }))
    const pythonEnvironments = vi.fn(async () => ({ environments: [], truncated: false }))
    const service = { whenReady: async () => {}, getConfig: () => ({ hfEndpoint: '', mineruPythonIndexUrl: 'https://pypi.org/simple' }), managementBindHost: '127.0.0.1', mineruDeployment: { preflight, prepare, pythonEnvironments } } as unknown as KnowledgeService
    const route = knowledgeRoute(service)
    if (route.kind !== 'prefix') throw new Error('expected prefix route')
    const server = createServer((req, res) => { void route.handler(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing address')
    const origin = `http://127.0.0.1:${address.port}`
    const url = `${origin}/knowledge/processors/managed/plan`
    const body = JSON.stringify({ root: 'chosen-directory' })
    const rejectedHeaders: Record<string, string>[] = [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', 'x-dsh-mineru-management': '1', origin: 'https://untrusted.example' },
    ]
    for (const headers of rejectedHeaders) {
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(403)
    }
    expect(preflight).not.toHaveBeenCalled()
    const headers = { 'content-type': 'application/json', 'x-dsh-mineru-management': '1', origin }
    const pythonUrl = `${origin}/knowledge/processors/managed/python`
    expect((await fetch(pythonUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect(pythonEnvironments).not.toHaveBeenCalled()
    expect((await fetch(pythonUrl, { method: 'POST', headers, body: '{"executable":42}' })).status).toBe(400)
    expect((await fetch(pythonUrl, { method: 'POST', headers, body: '{"executable":"selected-python"}' })).status).toBe(200)
    expect(pythonEnvironments).toHaveBeenCalledExactlyOnceWith('selected-python')
    expect((await fetch(url, { method: 'POST', headers, body: '{"root":42}' })).status).toBe(400)
    expect(preflight).not.toHaveBeenCalled()
    expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(200)
    expect(preflight).toHaveBeenCalledExactlyOnceWith({ root: 'chosen-directory', existingModels: undefined, pythonExecutable: undefined, hfEndpoint: '', pythonIndexUrl: 'https://pypi.org/simple' })
    const prepareUrl = `${origin}/knowledge/processors/managed/prepare`
    expect((await fetch(prepareUrl, { method: 'POST', headers, body: '{"planId":"plan"}' })).status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
    expect((await fetch(prepareUrl, { method: 'POST', headers, body: '{"planId":"plan","confirm":true}' })).status).toBe(200)
    expect(prepare).toHaveBeenCalledExactlyOnceWith('plan')
  })
  it('distinguishes malformed cursors, missing blocks, and genuine server failures', async () => {
    const doc: KnowledgeDocument = { id: 'doc', baseId: 'base', title: 'Fixture', sourceType: 'file', charCount: 5, chunkCount: 1, createdAt: 0 }
    const parsed = parsedTextDocument('hello', new Uint8Array([1]), 'builtin', 'options').document
    const service = {
      whenReady: async () => {},
      readDocumentEvidence: async (id: string, options: Parameters<typeof composeDocumentEvidence>[2]) => {
        if (id === 'broken') throw new Error('storage failure')
        return composeDocumentEvidence(doc, parsed, options)
      },
    } as unknown as KnowledgeService
    const route = knowledgeRoute(service)
    if (route.kind !== 'prefix') throw new Error('expected prefix route')
    const server = createServer((req, res) => { void route.handler(req, res) })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing server address')
    const base = `http://127.0.0.1:${address.port}/knowledge/documents`
    for (const [path, status, code] of [
      ['doc/evidence?blockId=missing', 404, 'not_found'],
      ['doc/evidence?blockOffset=1', 400, 'invalid_request'],
      ['doc/evidence?blockId=text%3A0&blockOffset=99', 400, 'invalid_request'],
      ['doc/evidence?pageIndex=-1', 400, 'invalid_request'],
      ['broken/evidence', 500, 'error'],
    ] as const) {
      const response = await fetch(`${base}/${path}`)
      expect(response.status, path).toBe(status)
      expect(await response.json()).toMatchObject({ ok: false, error: { code } })
    }
    const response = await fetch(`${base}/doc/evidence?blockId=text%3A0&blockOffset=2`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, value: { blocks: [{ text: 'llo', textStart: 2, textEnd: 5 }] } })
  })
})
