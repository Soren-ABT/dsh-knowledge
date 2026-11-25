import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArtifactRepository } from '../src/knowledge/artifacts.js'
import { parsedTextDocument } from '../src/knowledge/parsed-document.js'
import { ProcessingQueue } from '../src/knowledge/processing-queue.js'
import { composeDocumentEvidence } from '../src/knowledge/evidence.js'
import type { KnowledgeDocument } from '../src/knowledge/types.js'
import { toolOutput } from '../src/tool-knowledge/tool-schemas.js'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const output = () => parsedTextDocument('hello evidence', new TextEncoder().encode('source'), 'builtin', 'options')

describe('processing lifecycle', () => {
  it('stores immutable revisions and rejects cross-document access and tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-')); dirs.push(root)
    const repository = new ArtifactRepository(root)
    const one = await repository.save('base', 'document', output())
    const two = await repository.save('base', 'document', output())
    expect(one.revision).not.toBe(two.revision)
    expect((await repository.load('base', 'document', one)).text).toBe('hello evidence')
    await expect(repository.load('base', 'other', one)).rejects.toThrow('belong')
    const path = join(root, one.artifactId, 'document.json')
    await writeFile(path, (await readFile(path, 'utf8')).replace('hello evidence', 'wrong evidence'))
    await expect(repository.load('base', 'document', one)).rejects.toThrow('checksum')
    expect((await repository.load('base', 'document', two)).text).toBe('hello evidence')
  })

  it('deletion waits for pending writes and rejects late resurrection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-artifacts-')); dirs.push(root)
    const repository = new ArtifactRepository(root)
    const save = repository.save('base', 'document', output())
    await repository.deleteDocument('base', 'document')
    const info = await save
    await expect(repository.load('base', 'document', info)).rejects.toThrow()
    await expect(repository.save('base', 'document', output())).rejects.toThrow('deleted')
    await expect(repository.save('../outside', 'document', output())).rejects.toThrow('identity')
  })

  it('bounds waiting work, independently cancels a waiter, and releases capacity after failure', async () => {
    const queue = new ProcessingQueue(1, 1)
    const signal = new AbortController().signal
    let finish!: () => void
    const active = queue.run(() => new Promise<void>(resolve => { finish = resolve }), signal)
    const canceled = new AbortController()
    let ran = false
    const waiting = queue.run(async () => { ran = true }, canceled.signal)
    await expect(queue.run(async () => 3, signal)).rejects.toMatchObject({ code: 'busy' })
    canceled.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    finish(); await active
    expect(ran).toBe(false)
    await expect(queue.run(async () => { throw new Error('failed task') }, signal)).rejects.toThrow('failed task')
    expect(await queue.run(async () => 7, signal)).toBe(7)
  })

  it('continues large evidence blocks without dropped or duplicated text', () => {
    const text = '测量结果为42kg。'.repeat(250)
    const parsed = parsedTextDocument(text, new Uint8Array([1]), 'builtin', 'options').document
    const doc: KnowledgeDocument = { id: 'document', baseId: 'base', title: 'Synthetic', sourceType: 'file', charCount: text.length, chunkCount: 1, createdAt: 1 }
    let options: { blockId?: string; blockOffset?: number; maxTokens: number } = { maxTokens: 128 }
    let combined = ''
    for (let i = 0; i < 100; i++) {
      const result = composeDocumentEvidence(doc, parsed, options)
      expect(result.estimatedTokens).toBeLessThanOrEqual(128)
      combined += result.blocks.map(block => block.text).join('')
      for (const block of result.blocks) expect(text.slice(block.textStart, block.textEnd)).toBe(block.text)
      if (!result.next) break
      expect(result.next.blockOffset).toBeGreaterThan(options.blockOffset ?? 0)
      options = { ...result.next, maxTokens: 128 }
    }
    expect(combined).toBe(text)
    expect(() => composeDocumentEvidence(doc, parsed, { blockId: 'missing' })).toThrow('not found')
  })

  it('omits undefined optional keys from saved processing info, evidence, and toolOutput', async () => {
    const repository = new ArtifactRepository()
    const saved = await repository.save('base', 'document', output())
    expect(Object.hasOwn(saved, 'processorVersion')).toBe(false)
    expect(Object.hasOwn(saved, 'pageCount')).toBe(false)
    expect(Object.hasOwn(saved, 'processedPages')).toBe(false)

    const parsed = output().document
    const docWithoutProcessing: KnowledgeDocument = {
      id: 'document',
      baseId: 'base',
      title: 'Legacy',
      sourceType: 'file',
      charCount: parsed.text.length,
      chunkCount: 1,
      createdAt: 1,
    }
    const evidence = composeDocumentEvidence(docWithoutProcessing, parsed)
    expect(Object.hasOwn(evidence, 'processing')).toBe(false)

    const source = { nested: { keep: 1, drop: undefined }, items: [{ ok: true, missing: undefined }] }
    const cleaned = toolOutput(source)
    expect(cleaned).toEqual({ nested: { keep: 1 }, items: [{ ok: true }] })
    expect(Object.hasOwn(cleaned.nested, 'drop')).toBe(false)
    expect(Object.hasOwn(cleaned.items[0], 'missing')).toBe(false)
    cleaned.nested.keep = 2
    expect(source.nested.keep).toBe(1)
  })
})
