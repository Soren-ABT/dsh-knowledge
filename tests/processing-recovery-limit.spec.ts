import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactRepository } from '../src/knowledge/artifacts.js'
import { processDocumentFile, processorFingerprint } from '../src/knowledge/document-processing.js'
import type { KnowledgeConfig } from '../src/knowledge/types.js'

const parse = vi.hoisted(() => vi.fn())
vi.mock('../src/knowledge/parse.js', () => ({
  extensionOf: (name: string) => name.split('.').at(-1), parseDocumentBuffer: parse,
}))
const config = { documentProcessorProvider: 'builtin', imageCaptionProvider: 'off' } as KnowledgeConfig
const bytes = new TextEncoder().encode('local source')
beforeEach(() => { parse.mockReset().mockResolvedValue('complete local text') })

async function interrupted(startupAttempts: number) {
  const artifacts = new ArtifactRepository()
  await artifacts.saveJob({
    version: 1, baseId: 'base', documentId: 'document', state: 'running',
    sourceHash: createHash('sha256').update(bytes).digest('hex'), fingerprint: processorFingerprint(config),
    progress: { stage: 'parsing' }, updatedAt: 1, startupAttempts,
  })
  return { artifacts, baseId: 'base', documentId: 'document', fileName: 'scan.pdf', bytes, config }
}

describe('bounded automatic startup recovery (#37)', () => {
  it('stops after three interrupted startup attempts without starting the parser', async () => {
    const input = await interrupted(3)
    await expect(processDocumentFile({ ...input, resume: true })).rejects.toMatchObject({ code: 'recovery_limit_reached' })
    expect(parse).not.toHaveBeenCalled()
    expect(await input.artifacts.getJob('base', 'document')).toMatchObject({ state: 'failed', startupAttempts: 3, errorCode: 'recovery_limit_reached' })
    await expect(processDocumentFile({ ...input, resume: true })).rejects.toMatchObject({ code: 'recovery_limit_reached' })
    expect(parse).not.toHaveBeenCalled()
  })

  it('persists the next attempt before invoking a potentially crashing parser', async () => {
    const input = await interrupted(2)
    parse.mockImplementationOnce(async () => {
      expect(await input.artifacts.getJob('base', 'document')).toMatchObject({ state: 'running', startupAttempts: 3 })
      throw Object.assign(new Error('OCR child died'), { code: 'ocr_process_crash' })
    })
    await expect(processDocumentFile({ ...input, resume: true })).rejects.toMatchObject({ code: 'ocr_process_crash' })
    expect(await input.artifacts.getJob('base', 'document')).toMatchObject({ state: 'failed', startupAttempts: 3 })
  })

  it('lets a manual rebuild reset the recovery breaker and retain a complete artifact', async () => {
    const input = await interrupted(3)
    const result = await processDocumentFile(input)
    expect(result.text).toBe('complete local text')
    expect(await input.artifacts.getJob('base', 'document')).toMatchObject({ state: 'completed', startupAttempts: 0 })
  })

  it('does not carry old failure counts to a changed source', async () => {
    const input = await interrupted(3)
    const result = await processDocumentFile({ ...input, bytes: new TextEncoder().encode('replacement source'), resume: true })
    expect(result.text).toBe('complete local text')
    expect(await input.artifacts.getJob('base', 'document')).toMatchObject({ state: 'completed', startupAttempts: 1 })
  })
})
