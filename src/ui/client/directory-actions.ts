/** Optional directory capabilities normalized across DSH client versions. */
export interface DirectoryActions {
  pickDirectory?: () => Promise<string | null>
  openPath?: (path: string) => Promise<void>
  canOpenPath?: () => Promise<boolean>
}

interface DirectoryServices {
  nativePicker?: unknown
  uiWorkspace?: unknown
  remote?: unknown
  workspaces?: unknown
}

type Method = (...args: unknown[]) => unknown

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : undefined
}

function method(owner: unknown, name: string): Method | undefined {
  const value = record(owner)?.[name]
  return typeof value === 'function' ? (value as Method).bind(owner) : undefined
}

/** Read `.session` defensively: a gated Remote accessor throws instead of
 *  returning when the reading context did not inject `remote.session`
 *  (issue #47); a refused read means "no session namespace", not a crash. */
function sessionOf(remote: unknown): unknown {
  try {
    return record(remote)?.session
  } catch {
    return undefined
  }
}

/** DSH 0.2 RemoteResult uses ok/value/error directly, without a result wrapper. */
function remoteValue(response: unknown): unknown {
  const result = record(response)
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const message = record(result.error)?.message
    throw new Error(typeof message === 'string' ? message : typeof result.error === 'string' ? result.error : 'DSH directory operation failed')
  }
  throw new Error('DSH returned an invalid directory operation response')
}

/** Root slot props are cached by the DSH renderer. Keep capability reads and
 * retained callbacks (including the picker passed to MinerU) current without
 * invoking a service until the user actually performs the operation. */
function liveDirectoryActions(resolve: () => DirectoryServices): DirectoryActions {
  const current = () => createDirectoryActions(resolve())
  const pickDirectory = async (): Promise<string | null> => {
    const pick = current().pickDirectory
    if (pick === undefined) throw new Error('DSH directory picker is unavailable')
    return pick()
  }
  const openPath = async (path: string): Promise<void> => {
    const open = current().openPath
    if (open === undefined) throw new Error('DSH directory opener is unavailable')
    await open(path)
  }
  const canOpenPath = async (): Promise<boolean> => {
    const canOpen = current().canOpenPath
    return canOpen === undefined ? false : canOpen()
  }
  const actions: DirectoryActions = {}
  Object.defineProperties(actions, {
    pickDirectory: {
      enumerable: true,
      get: () => current().pickDirectory === undefined ? undefined : pickDirectory,
    },
    openPath: {
      enumerable: true,
      get: () => current().openPath === undefined ? undefined : openPath,
    },
    canOpenPath: {
      enumerable: true,
      get: () => current().canOpenPath === undefined ? undefined : canOpenPath,
    },
  })
  return actions
}

/** Preserve the desktop picker window owner and the receiving service's this.
 * A resolver additionally follows service registration and replacement after
 * slot props have been cached; static service snapshots retain their behavior. */
export function createDirectoryActions(services: DirectoryServices | (() => DirectoryServices)): DirectoryActions {
  if (typeof services === 'function') return liveDirectoryActions(services)
  const actions: DirectoryActions = {}
  const pick = method(services.nativePicker, 'pick')
    ?? method(services.uiWorkspace, 'pickDirectory')
    ?? method(services.workspaces, 'pickDirectory')
  if (pick !== undefined) {
    actions.pickDirectory = async () => {
      const path = await pick()
      if (path === null || path === '') return null
      if (typeof path === 'string') return path
      throw new Error('DSH directory picker returned an invalid path')
    }
  }

  const session = sessionOf(services.remote)
  const open = method(session, 'openWorkspacePath')
  if (open !== undefined) {
    const canOpen = method(session, 'canOpenWorkspacePath')
    actions.canOpenPath = async () => {
      if (canOpen === undefined) return true
      const available = remoteValue(await canOpen())
      if (typeof available !== 'boolean') throw new Error('DSH returned an invalid directory capability response')
      return available
    }
    actions.openPath = async (path) => {
      const result = record(remoteValue(await open({ path })))
      if (result?.opened !== true) throw new Error('DSH did not open the directory')
    }
  } else {
    const legacyOpen = method(services.workspaces, 'openPath')
    if (legacyOpen !== undefined) {
      actions.canOpenPath = async () => true
      actions.openPath = async path => { await legacyOpen(path) }
    }
  }
  return actions
}
