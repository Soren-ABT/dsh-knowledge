import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

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
})
