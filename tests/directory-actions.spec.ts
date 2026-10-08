import { describe, expect, it, vi } from 'vitest'
import { createDirectoryActions } from '../src/ui/client/directory-actions.js'

describe('host directory actions (#42)', () => {
  it('uses the native picker before the new or legacy services and preserves its receiver', async () => {
    const nativePicker = { path: 'C:\\native', pick: vi.fn(async function (this: { path: string }) { return this.path }) }
    const uiWorkspace = { pickDirectory: vi.fn(async () => 'C:\\ui') }
    const workspaces = { pickDirectory: vi.fn(async () => 'C:\\legacy') }
    const actions = createDirectoryActions({ nativePicker, uiWorkspace, workspaces })

    await expect(actions.pickDirectory?.()).resolves.toBe('C:\\native')
    expect(nativePicker.pick).toHaveBeenCalledOnce()
    expect(uiWorkspace.pickDirectory).not.toHaveBeenCalled()
    expect(workspaces.pickDirectory).not.toHaveBeenCalled()
  })

  it('uses uiWorkspace on DSH 0.2 even when workspaces is a pure controller', async () => {
    const uiWorkspace = { path: 'D:\\models', pickDirectory: vi.fn(async function (this: { path: string }) { return this.path }) }
    const actions = createDirectoryActions({ nativePicker: { pick: true }, uiWorkspace, workspaces: { list: () => [] } })

    await expect(actions.pickDirectory?.()).resolves.toBe('D:\\models')
    expect(actions.openPath).toBeUndefined()
    expect(actions.canOpenPath).toBeUndefined()
  })

  it.each([null, ''])('keeps a canceled picker result (%j) and does not invoke another picker', async value => {
    const nativePicker = { pick: vi.fn(async () => value) }
    const uiWorkspace = { pickDirectory: vi.fn(async () => 'C:\\unexpected') }
    const actions = createDirectoryActions({ nativePicker, uiWorkspace })

    await expect(actions.pickDirectory?.()).resolves.toBeNull()
    expect(uiWorkspace.pickDirectory).not.toHaveBeenCalled()
  })

  it('propagates picker errors without retrying a lower priority service', async () => {
    const uiWorkspace = { pickDirectory: vi.fn(async () => { throw new Error('native dialog failed') }) }
    const workspaces = { pickDirectory: vi.fn(async () => 'C:\\unexpected') }
    const actions = createDirectoryActions({ uiWorkspace, workspaces })

    await expect(actions.pickDirectory?.()).rejects.toThrow('native dialog failed')
    expect(workspaces.pickDirectory).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, [], 42, true])('rejects an invalid picker response: %j', async value => {
    const actions = createDirectoryActions({ uiWorkspace: { pickDirectory: async () => value } })

    await expect(actions.pickDirectory?.()).rejects.toThrow(/directory|picker|path|目录/i)
  })

  it('opens paths through the new remote session contract and preserves its receiver', async () => {
    const session = {
      available: true,
      requests: [] as Array<{ path: string }>,
      async canOpenWorkspacePath(this: { available: boolean }) { return { ok: true, value: this.available } },
      async openWorkspacePath(this: { requests: Array<{ path: string }> }, request: { path: string }) {
        this.requests.push(request)
        return { ok: true, value: { opened: true } }
      },
    }
    const legacyOpen = vi.fn()
    const actions = createDirectoryActions({ remote: { session }, workspaces: { openPath: legacyOpen } })

    await expect(actions.canOpenPath?.()).resolves.toBe(true)
    await expect(actions.openPath?.('E:\\cache with spaces')).resolves.toBeUndefined()
    expect(session.requests).toEqual([{ path: 'E:\\cache with spaces' }])
    session.available = false
    await expect(actions.canOpenPath?.()).resolves.toBe(false)
    expect(legacyOpen).not.toHaveBeenCalled()
  })

  it('reports host errors from the actual envelope without silently trying the old opener', async () => {
    const workspaces = { openPath: vi.fn() }
    const actions = createDirectoryActions({
      remote: { session: {
        openWorkspacePath: async () => ({ ok: false, error: { code: 'permission_denied', message: 'directory is not accessible' } }),
        canOpenWorkspacePath: async () => ({ ok: false, error: { code: 'unavailable', message: 'shell is unavailable' } }),
      } },
      workspaces,
    })

    await expect(actions.openPath?.('C:\\cache')).rejects.toThrow('directory is not accessible')
    await expect(actions.canOpenPath?.()).rejects.toThrow('shell is unavailable')
    expect(workspaces.openPath).not.toHaveBeenCalled()
  })

  it('binds the legacy picker and opener independently when new capabilities are missing', async () => {
    const workspaces = {
      path: 'C:\\legacy',
      opened: [] as string[],
      async pickDirectory(this: { path: string }) { return this.path },
      async openPath(this: { opened: string[] }, path: string) { this.opened.push(path) },
    }
    const actions = createDirectoryActions({ nativePicker: null, uiWorkspace: {}, remote: { session: {} }, workspaces })

    await expect(actions.pickDirectory?.()).resolves.toBe('C:\\legacy')
    await expect(actions.canOpenPath?.()).resolves.toBe(true)
    await actions.openPath?.('D:\\target')
    expect(workspaces.opened).toEqual(['D:\\target'])
  })

  it.each([{}, { workspaces: {} }, { workspaces: { pickDirectory: 'not callable', openPath: false } }, { nativePicker: [], uiWorkspace: null, remote: { session: null } }])('does not expose nonexistent methods for incomplete services: %j', services => {
    const actions = createDirectoryActions(services)

    expect(actions.pickDirectory).toBeUndefined()
    expect(actions.openPath).toBeUndefined()
    expect(actions.canOpenPath).toBeUndefined()
  })

  it('keeps picker-only and opener-only environments usable independently', async () => {
    const pickOnly = createDirectoryActions({ workspaces: { pickDirectory: async () => 'C:\\picked' } })
    const openOnly = createDirectoryActions({ remote: { session: { openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) } } })

    await expect(pickOnly.pickDirectory?.()).resolves.toBe('C:\\picked')
    expect(pickOnly.openPath).toBeUndefined()
    expect(openOnly.pickDirectory).toBeUndefined()
    await expect(openOnly.canOpenPath?.()).resolves.toBe(true)
    await expect(openOnly.openPath?.('C:\\cache')).resolves.toBeUndefined()
  })

  it('discovers later capabilities on the same actions object supplied by a service resolver', async () => {
    const services: Record<string, unknown> = {}
    const actions = createDirectoryActions(() => services)
    expect(actions.pickDirectory).toBeUndefined()
    expect(actions.openPath).toBeUndefined()
    expect(actions.canOpenPath).toBeUndefined()

    services.uiWorkspace = { pickDirectory: async () => 'D:\\late-models' }
    services.remote = { session: {
      canOpenWorkspacePath: async () => ({ ok: true, value: true }),
      openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })),
    } }
    await expect(actions.pickDirectory?.()).resolves.toBe('D:\\late-models')
    await expect(actions.canOpenPath?.()).resolves.toBe(true)
    await expect(actions.openPath?.('D:\\late-cache')).resolves.toBeUndefined()
  })

  it('keeps retained picker callbacks current across withdrawal, replacement and cancellation', async () => {
    const firstPicker = { pickDirectory: vi.fn(async () => 'C:\\first') }
    const legacyPicker = { pickDirectory: vi.fn(async () => 'C:\\legacy') }
    const services: Record<string, unknown> = { uiWorkspace: firstPicker, workspaces: legacyPicker }
    const actions = createDirectoryActions(() => services)
    const retainedPicker = actions.pickDirectory!
    expect(actions.pickDirectory).toBe(retainedPicker)
    await expect(retainedPicker()).resolves.toBe('C:\\first')

    const replacement = { pickDirectory: vi.fn(async (): Promise<string | null> => null) }
    services.uiWorkspace = replacement
    await expect(retainedPicker()).resolves.toBeNull()
    expect(firstPicker.pickDirectory).toHaveBeenCalledOnce()
    expect(legacyPicker.pickDirectory).not.toHaveBeenCalled()

    replacement.pickDirectory.mockRejectedValueOnce(new Error('current picker failed'))
    await expect(retainedPicker()).rejects.toThrow('current picker failed')
    expect(legacyPicker.pickDirectory).not.toHaveBeenCalled()
    delete services.uiWorkspace
    await expect(retainedPicker()).resolves.toBe('C:\\legacy')
    delete services.workspaces
    expect(actions.pickDirectory).toBeUndefined()
    await expect(retainedPicker()).rejects.toThrow(/picker.*unavailable/i)
  })

  it('updates retained opener callbacks without retrying a failed current Remote operation', async () => {
    const oldSession = { openWorkspacePath: vi.fn(async () => ({ ok: true, value: { opened: true } })) }
    const legacyOpen = vi.fn(async () => {})
    const services: Record<string, unknown> = { remote: { session: oldSession }, workspaces: { openPath: legacyOpen } }
    const actions = createDirectoryActions(() => services)
    const retainedOpen = actions.openPath!
    const retainedCanOpen = actions.canOpenPath!
    expect(actions.openPath).toBe(retainedOpen)
    expect(actions.canOpenPath).toBe(retainedCanOpen)

    const replacement = {
      canOpenWorkspacePath: vi.fn(async () => ({ ok: true, value: false })),
      openWorkspacePath: vi.fn(async () => ({ ok: false, error: { message: 'current host refused the path' } })),
    }
    services.remote = { session: replacement }
    await expect(retainedCanOpen()).resolves.toBe(false)
    await expect(retainedOpen('D:\\cache')).rejects.toThrow('current host refused the path')
    expect(oldSession.openWorkspacePath).not.toHaveBeenCalled()
    expect(legacyOpen).not.toHaveBeenCalled()

    delete services.remote
    await expect(retainedOpen('C:\\legacy-cache')).resolves.toBeUndefined()
    expect(legacyOpen).toHaveBeenCalledExactlyOnceWith('C:\\legacy-cache')
    delete services.workspaces
    expect(actions.openPath).toBeUndefined()
    expect(actions.canOpenPath).toBeUndefined()
    await expect(retainedCanOpen()).resolves.toBe(false)
    await expect(retainedOpen('C:\\gone')).rejects.toThrow(/opener.*unavailable/i)
  })

  it('treats a gated remote accessor as "no session" instead of crashing (#47)', async () => {
    // The real failure shape: reading `.session` on the Remote service throws
    // when the reading context did not inject `remote.session`.
    const guarded = Object.defineProperty({}, 'session', {
      get() { throw new Error('cannot get property "remote.session" without inject') },
    })
    const opened: string[] = []
    const legacyOpen = async (path: string): Promise<void> => { opened.push(path) }
    const withLegacy = createDirectoryActions({ remote: guarded, workspaces: { openPath: legacyOpen } })
    await expect(withLegacy.canOpenPath?.()).resolves.toBe(true)
    await withLegacy.openPath?.('C:\\cache')
    expect(opened).toEqual(['C:\\cache'])

    const alone = createDirectoryActions({ remote: guarded })
    expect(alone.openPath).toBeUndefined()
    expect(alone.canOpenPath).toBeUndefined()
  })

  it('does not accept a wrapped result, malformed capability, or an unopened path as success', async () => {
    const session = {
      openWorkspacePath: vi.fn(async (): Promise<unknown> => ({ result: { ok: true, value: { opened: true } } })),
      canOpenWorkspacePath: vi.fn(async (): Promise<unknown> => ({ ok: true, value: 'true' })),
    }
    const actions = createDirectoryActions({ remote: { session } })
    await expect(actions.openPath?.('C:\\cache')).rejects.toThrow(/invalid.*response/i)
    await expect(actions.canOpenPath?.()).rejects.toThrow(/invalid.*capability/i)
    session.openWorkspacePath.mockResolvedValueOnce({ ok: true, value: { opened: false } })
    await expect(actions.openPath?.('C:\\cache')).rejects.toThrow(/did not open/i)
  })
})
