/**
 * Open/close state for the knowledge panel, shared between the sidebar-foot
 * action and the frame-wide overlay. A tiny external store consumed through
 * React's useSyncExternalStore.
 * @module dsh-knowledge/client/panel-store
 */

export interface KnowledgePanelStore {
  getSnapshot(): boolean
  subscribe(listener: () => void): () => void
  open(): void
  close(): void
  toggle(): void
}

export function createKnowledgePanelStore(): KnowledgePanelStore {
  let open = false
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => open,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open() {
      open = true
      emit()
    },
    close() {
      open = false
      emit()
    },
    toggle() {
      open = !open
      emit()
    },
  }
}
