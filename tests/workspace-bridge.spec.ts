/**
 * Local-model directory bridge across DSH generations (issue #42): DSH 0.2.0
 * moved `pickDirectory`/`openPath` off the `workspaces` service (`uiWorkspace`
 * + `remote.session.openWorkspacePath` now carry them), so the panel must probe
 * each METHOD and fall back instead of trusting the object's presence.
 */
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceBridge } from '../src/ui/client/workspace-bridge.js'

describe('workspace bridge (#42)', () => {
  it('uses the DSH 0.2.0 services and preserves their receiver', async () => {
    const uiWorkspace = {
      picked: '/cache/picked',
      async pickDirectory() { return this.picked },
    }
    const calls: Array<{ path: string; action?: string }> = []
    const session = {
      async openWorkspacePath(request: { path: string; action?: 'open' | 'reveal' }) {
        calls.push(request)
        return { ok: true }
      },
    }

    const bridge = resolveWorkspaceBridge({ uiWorkspace, remote: { session } })
    await expect(bridge.pickDirectory!()).resolves.toBe('/cache/picked')
    await expect(bridge.openPath!('/cache')).resolves.toBe(true)
    expect(calls).toEqual([{ path: '/cache', action: 'reveal' }])
  })

  it('falls back to the legacy workspaces methods when the new services are absent', async () => {
    const workspaces = {
      root: 'C:/legacy',
      opened: '',
      async pickDirectory() { return this.root },
      async openPath(path: string) { this.opened = path },
    }

    const bridge = resolveWorkspaceBridge({ workspaces })
    await expect(bridge.pickDirectory!()).resolves.toBe('C:/legacy')
    await expect(bridge.openPath!('C:/cache')).resolves.toBe(true)
    expect(workspaces.opened).toBe('C:/cache')
  })

  it('does not treat the DSH 0.2.0 workspace-controller object as a picker', () => {
    // The exact regression: `workspaces` exists but carries none of the methods.
    const bridge = resolveWorkspaceBridge({ workspaces: {} })
    expect(bridge.pickDirectory).toBeUndefined()
    expect(bridge.openPath).toBeUndefined()
  })

  it('reports a refused host hand-off instead of claiming success', async () => {
    const bridge = resolveWorkspaceBridge({
      remote: { session: { async openWorkspacePath() { return { ok: false } } } },
    })
    await expect(bridge.openPath!('/cache')).resolves.toBe(false)
  })

  it('prefers the 0.2.0 services when both generations are present', async () => {
    const used: string[] = []
    const bridge = resolveWorkspaceBridge({
      uiWorkspace: { async pickDirectory() { used.push('modern'); return null } },
      workspaces: { async pickDirectory() { used.push('legacy'); return null } },
    })
    await bridge.pickDirectory!()
    expect(used).toEqual(['modern'])
  })
})
