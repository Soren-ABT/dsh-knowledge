import { describe, expect, it } from 'vitest'
import {
  chunkPreviewBodyId,
  collapseAllChunks,
  collapsedChunkExpansion,
  expandAllChunks,
  isChunkExpanded,
  toggleChunkExpansion,
} from '../src/ui/client/chunk-expansion.js'
import { en, zh } from '../src/ui/client/locales.js'

describe('chunk preview expansion', () => {
  it('expands and collapses one chunk without changing its siblings', () => {
    const initial = collapsedChunkExpansion()
    const expanded = toggleChunkExpansion(initial, ['a', 'b'], 'a')
    expect(isChunkExpanded(expanded, 'a')).toBe(true)
    expect(isChunkExpanded(expanded, 'b')).toBe(false)

    const collapsed = toggleChunkExpansion(expanded, ['a', 'b'], 'a')
    expect(isChunkExpanded(collapsed, 'a')).toBe(false)
    expect(collapsed.expandedChunkIds.size).toBe(0)
  })

  it('expands current and subsequently loaded chunks in all-expanded mode', () => {
    const expanded = expandAllChunks()
    expect(isChunkExpanded(expanded, 'already-loaded')).toBe(true)
    expect(isChunkExpanded(expanded, 'loaded-later')).toBe(true)
  })

  it('keeps other loaded chunks open when one is collapsed from all-expanded mode', () => {
    const state = toggleChunkExpansion(expandAllChunks(), ['a', 'b', 'c'], 'b')
    expect(state.allExpanded).toBe(false)
    expect(isChunkExpanded(state, 'a')).toBe(true)
    expect(isChunkExpanded(state, 'b')).toBe(false)
    expect(isChunkExpanded(state, 'c')).toBe(true)
    expect(isChunkExpanded(state, 'loaded-later')).toBe(false)
  })

  it('collapses every chunk and resets document-local state', () => {
    const reset = collapseAllChunks()
    expect(reset.allExpanded).toBe(false)
    expect(reset.expandedChunkIds.size).toBe(0)
    expect(isChunkExpanded(reset, 'a')).toBe(false)
  })

  it('builds a stable selector-safe body ID from opaque document and chunk IDs', () => {
    const id = chunkPreviewBodyId("doc / 中文!'()*", 'chunk:#1')
    expect(id).toBe(chunkPreviewBodyId("doc / 中文!'()*", 'chunk:#1'))
    expect(id).toMatch(/^kb-chunk-body-[a-f0-9]+$/)
    expect(id).not.toBe(chunkPreviewBodyId("doc / 中文!'()", '*chunk:#1'))
  })

  it('provides Chinese and English labels for every expansion action', () => {
    for (const locale of [zh, en]) {
      expect(locale.chunkExpand).toBeTruthy()
      expect(locale.chunkCollapse).toBeTruthy()
      expect(locale.chunksExpandAll).toBeTruthy()
      expect(locale.chunksCollapseAll).toBeTruthy()
    }
  })
})
