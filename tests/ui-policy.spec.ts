import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { KnowledgeApi } from '../src/ui/client/api.js'

async function source(path: string): Promise<string> {
  return readFile(new URL(`../src/ui/client/${path}`, import.meta.url), 'utf8')
}

describe('knowledge UI policy', () => {
  it('keeps Ollama model browsing separate from embedding configuration', async () => {
    const models = await source('LocalModelsSection.tsx')

    // This page still has explicit save controls for the cache, mirror, and
    // worker timeout. It must not persist embedding selection as a side effect
    // of listing or pulling Ollama models.
    expect(models).not.toContain('persistOllamaDefault')
    expect(models).not.toMatch(/embeddingProvider\s*:/)
    expect(models).not.toMatch(/embeddingBaseUrl\s*:/)
    expect(models).not.toMatch(/embeddingModel\s*:/)
  })

  it('wires toast dismissal into panel state', async () => {
    const panel = await source('KnowledgeSection.tsx')

    expect(panel).toContain('<Toasts toasts={toasts} onDismiss={dismissToast} />')
    expect(panel).toMatch(/setToasts\(prev => prev\.filter\(toast => toast\.id !== id\)\)/)
  })

  it('previews the real impact and confirms a cascading directory delete', async () => {
    const panel = await source('KnowledgeSection.tsx')

    // Deleting a directory removes its whole subtree on the host, so the panel
    // must read the host-reported impact and require a second confirmation
    // instead of issuing the destructive call straight from the row menu.
    expect(panel).toContain('getDeleteImpact(')
    expect(panel).toMatch(/impact\.requiresRecursive/)
    expect(panel).toMatch(/kind: 'confirmCascadeDelete'/)
    expect(panel).toMatch(/kind: 'confirmCascadeBulkDelete'/)
    expect(panel).toMatch(/api\.deleteDocument\(doc\.id, recursive\)/)
    expect(panel).toMatch(/api\.deleteDocuments\(ids, recursive\)/)
  })

  it('never sets the recursive delete flag implicitly', async () => {
    // Behavioural, not a source grep: production runs the esbuild bundle
    // lib/client.js, so asserting on api.ts's text would pass even if a call site
    // started passing `true` unconditionally. This inspects the requests the
    // client actually issues.
    const calls: Array<{ url: string; method: string; body: string | undefined }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? 'GET'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return new Response(JSON.stringify({ ok: true, value: { deleted: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    try {
      const api = new KnowledgeApi()
      await api.deleteDocument('doc-1')
      await api.deleteDocuments(['a', 'b'], true)
      await api.getDeleteImpact('doc-1')

      expect(calls[0]?.method).toBe('DELETE')
      expect(calls[0]?.url).toContain('/documents/doc-1')
      // A plain delete must NOT claim recursive confirmation.
      expect(calls[0]?.url).not.toContain('recursive')
      // The batch flag travels in the body, exactly as the host reads it.
      expect(calls[1]?.url).toBe('/knowledge/documents')
      expect(JSON.parse(calls[1]?.body ?? '{}')).toEqual({ ids: ['a', 'b'], recursive: true })
      expect(calls[2]?.url).toContain('/delete-impact')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('gives synchronous URL indexing the same request budget as a file rebuild', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', async () => Response.json({ ok: true, value: {} }))
    try {
      const api = new KnowledgeApi()
      await api.reindexDocument('id')
      await api.addUrlDocument('base', 'https://example.com/wiki.md')
      await api.refreshUrlDocument('id')
      const budgets = timeout.mock.calls.map(([duration]) => duration)
      expect(budgets[0]).toBeGreaterThan(60_000)
      expect(budgets).toEqual([budgets[0], budgets[0], budgets[0]])
    } finally {
      timeout.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
