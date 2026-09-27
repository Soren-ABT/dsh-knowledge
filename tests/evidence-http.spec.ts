import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { knowledgeRoute } from '../src/knowledge/http.js'
import type { KnowledgeService } from '../src/knowledge/index.js'
import type { KnowledgeDocument } from '../src/knowledge/types.js'
import { composeDocumentEvidence } from '../src/knowledge/evidence.js'
import { parsedTextDocument } from '../src/knowledge/parsed-document.js'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

describe('evidence HTTP boundary', () => {
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
