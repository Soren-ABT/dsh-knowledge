/**
 * Resolve the native directory picker and path opener across the DSH
 * generations this client bundle can run on.
 *
 * DSH 0.2.0 moved the UI workspace helpers: `pickDirectory` now lives on the
 * `uiWorkspace` client service, and open/reveal goes through the Session Remote
 * (`remote.session.openWorkspacePath`). The `workspaces` service keeps its
 * name but now belongs to the API workspace controller, which has neither
 * method — so probing for the OBJECT is not enough (issue #42): every
 * capability is probed per method and falls back to the legacy shape.
 * Kept free of React/host imports so the resolution is unit-testable.
 * @module dsh-knowledge/client/workspace-bridge
 */

/** Legacy `workspaces` methods, present on DSH generations before 0.2.0. */
export interface LegacyWorkspaceMethods {
  pickDirectory?(): Promise<string | null>
  openPath?(path: string): Promise<void>
}

/** DSH 0.2.0+ client services carrying the same capabilities. */
export interface WorkspaceBridgeServices {
  uiWorkspace?: { pickDirectory?(): Promise<string | null> }
  remote?: {
    session?: {
      /** Only the `RemoteResult` discriminant is needed here. */
      openWorkspacePath?(request: { path: string; action?: 'open' | 'reveal' }): Promise<{ ok?: boolean } | null | undefined>
    }
  }
}

export interface WorkspaceBridgeSources extends WorkspaceBridgeServices {
  workspaces?: LegacyWorkspaceMethods
}

export interface WorkspaceBridge {
  /** Native directory picker, when any DSH generation provides one. */
  pickDirectory?: () => Promise<string | null>
  /** Open/reveal a host path; resolves false when the host refused it. */
  openPath?: (path: string) => Promise<boolean>
}

/** Prefer the 0.2.0 services and fall back to the legacy `workspaces` methods. */
export function resolveWorkspaceBridge(sources: WorkspaceBridgeSources): WorkspaceBridge {
  const bridge: WorkspaceBridge = {}

  const uiWorkspace = sources.uiWorkspace
  if (uiWorkspace !== undefined && typeof uiWorkspace.pickDirectory === 'function') {
    const pick = uiWorkspace.pickDirectory
    bridge.pickDirectory = () => pick.call(uiWorkspace)
  } else {
    const legacy = sources.workspaces
    if (legacy !== undefined && typeof legacy.pickDirectory === 'function') {
      const pick = legacy.pickDirectory
      bridge.pickDirectory = () => pick.call(legacy)
    }
  }

  const session = sources.remote?.session
  if (session !== undefined && typeof session.openWorkspacePath === 'function') {
    const open = session.openWorkspacePath
    bridge.openPath = async path => (await open.call(session, { path, action: 'reveal' }))?.ok === true
  } else {
    const legacy = sources.workspaces
    if (legacy !== undefined && typeof legacy.openPath === 'function') {
      const open = legacy.openPath
      bridge.openPath = path => open.call(legacy, path).then(() => true)
    }
  }

  return bridge
}
