/** Expansion state for the document chunk-preview cards. */
export interface ChunkExpansionState {
  readonly allExpanded: boolean
  readonly expandedChunkIds: ReadonlySet<string>
}

/** Start (or reset) a document preview with every chunk collapsed. */
export function collapsedChunkExpansion(): ChunkExpansionState {
  return { allExpanded: false, expandedChunkIds: new Set() }
}

/** Expand every loaded chunk and any chunks loaded later. */
export function expandAllChunks(): ChunkExpansionState {
  return { allExpanded: true, expandedChunkIds: new Set() }
}

/** Collapse every chunk and stop auto-expanding chunks loaded later. */
export function collapseAllChunks(): ChunkExpansionState {
  return collapsedChunkExpansion()
}

export function isChunkExpanded(state: ChunkExpansionState, chunkId: string): boolean {
  return state.allExpanded || state.expandedChunkIds.has(chunkId)
}

/**
 * Toggle one chunk without surprising the rest of the list. When one card is
 * collapsed from all-expanded mode, every other currently loaded card remains
 * explicitly expanded and chunks loaded later start collapsed.
 */
export function toggleChunkExpansion(
  state: ChunkExpansionState,
  loadedChunkIds: readonly string[],
  chunkId: string,
): ChunkExpansionState {
  if (state.allExpanded) {
    const expandedChunkIds = new Set(loadedChunkIds)
    expandedChunkIds.delete(chunkId)
    return { allExpanded: false, expandedChunkIds }
  }

  const expandedChunkIds = new Set(state.expandedChunkIds)
  if (expandedChunkIds.has(chunkId)) expandedChunkIds.delete(chunkId)
  else expandedChunkIds.add(chunkId)
  return { allExpanded: false, expandedChunkIds }
}

/** A selector-safe, stable ID for aria-controls. */
export function chunkPreviewBodyId(documentId: string, chunkId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([documentId, chunkId]))
  const encoded = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `kb-chunk-body-${encoded}`
}
