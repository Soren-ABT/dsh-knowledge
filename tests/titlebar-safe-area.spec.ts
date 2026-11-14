import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTitlebarInset, subscribeTitlebarInset } from '../src/ui/client/titlebar-safe-area.js'

afterEach(() => vi.unstubAllGlobals())

class Overlay extends EventTarget {
  visible = true
  y = 0
  height = 40
  getTitlebarAreaRect() { return { y: this.y, height: this.height } }
}
class Viewport extends EventTarget { innerHeight = 800 }

class Page extends EventTarget {
  fullscreenElement: object | null = null
  documentElement = { dataset: {} as Record<string, string> }
}

function desktop(platform: string, css: Record<string, string> = {}) {
  const page = new Page()
  vi.stubGlobal('document', page)
  vi.stubGlobal('navigator', { platform, userAgent: `Mozilla/5.0 (${platform}) Electron/40.0` })
  vi.stubGlobal('window', new Viewport())
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => css[name] ?? '' }))
  return page
}

function setup() {
  const controls = new Overlay()
  const viewport = new Viewport()
  vi.stubGlobal('navigator', { windowControlsOverlay: controls })
  vi.stubGlobal('window', viewport)
  return { controls, viewport }
}

describe('native titlebar safe area (#35)', () => {
  it('keeps ordinary browser panels flush with the viewport', () => {
    vi.stubGlobal('navigator', {})
    expect(getTitlebarInset()).toBe(0)
    const unsubscribe = subscribeTitlebarInset(() => {})
    unsubscribe()
  })

  it('moves all panel actions below the overlay instead of assuming Windows dimensions', () => {
    const { controls } = setup()
    expect(getTitlebarInset()).toBe(40)
    controls.y = 8
    controls.height = 52
    expect(getTitlebarInset()).toBe(60)
    controls.visible = false
    expect(getTitlebarInset()).toBe(0)
  })

  it('observes geometry/visibility/viewport changes and removes both subscriptions', () => {
    const { controls, viewport } = setup()
    const snapshots: number[] = []
    const unsubscribe = subscribeTitlebarInset(() => snapshots.push(getTitlebarInset()))
    controls.height = 64
    controls.dispatchEvent(new Event('geometrychange'))
    controls.visible = false
    controls.dispatchEvent(new Event('geometrychange'))
    controls.visible = true
    viewport.innerHeight = 32
    viewport.dispatchEvent(new Event('resize'))
    expect(snapshots).toEqual([64, 0, 32])
    unsubscribe()
    controls.dispatchEvent(new Event('geometrychange'))
    viewport.dispatchEvent(new Event('resize'))
    expect(snapshots).toHaveLength(3)
  })

  it('rejects invalid geometry and tolerates a temporarily unavailable API', () => {
    const { controls } = setup()
    controls.height = Number.NaN
    expect(getTitlebarInset()).toBe(0)
    controls.height = -1
    expect(getTitlebarInset()).toBe(0)
    controls.getTitlebarAreaRect = () => { throw new Error('unavailable') }
    expect(getTitlebarInset()).toBe(0)
  })

  it.each([['MacIntel', 38], ['Win32', 40], ['Linux x86_64', 0]])('reserves a native shell band on %s', (platform, expected) => {
    desktop(platform)
    expect(getTitlebarInset()).toBe(expected)
  })

  it('never infers a shell from an ordinary browser platform alone', () => {
    desktop('MacIntel')
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 Chrome/130 Safari/537.36' })
    expect(getTitlebarInset()).toBe(0)
  })

  it('recognizes shell platform from the user agent and Tauri bridge', () => {
    desktop('MacIntel')
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Electron/40.0' })
    expect(getTitlebarInset()).toBe(40)
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mozilla/5.0' })
    vi.stubGlobal('window', Object.assign(new Viewport(), { __TAURI_INTERNALS__: {} }))
    expect(getTitlebarInset()).toBe(38)
  })

  it('honors host variables in order, including explicit zero, and rejects invalid values', () => {
    const css = { '--host-titlebar-inset': '56px', '--dsh-windows-titlebar-height': '48px' }
    desktop('Win32', css)
    expect(getTitlebarInset()).toBe(56)
    css['--host-titlebar-inset'] = '0px'
    expect(getTitlebarInset()).toBe(0)
    css['--host-titlebar-inset'] = 'calc(20px + 30px)'
    expect(getTitlebarInset()).toBe(48)
    css['--dsh-windows-titlebar-height'] = '-5px'
    expect(getTitlebarInset()).toBe(40)
  })

  it('uses the larger overlay or shell inset and keeps shell fallback after an overlay error', () => {
    desktop('MacIntel')
    const controls = new Overlay()
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Electron/40.0', windowControlsOverlay: controls })
    expect(getTitlebarInset()).toBe(40)
    controls.height = 20
    expect(getTitlebarInset()).toBe(38)
    controls.getTitlebarAreaRect = () => { throw new Error('unavailable') }
    expect(getTitlebarInset()).toBe(38)
  })

  it('removes the band in native/DOM fullscreen and restores it on exit', () => {
    const page = desktop('Win32')
    page.documentElement.dataset.fullscreen = 'true'
    expect(getTitlebarInset()).toBe(0)
    page.documentElement.dataset.fullscreen = 'false'
    expect(getTitlebarInset()).toBe(40)
    page.fullscreenElement = {}
    expect(getTitlebarInset()).toBe(0)
    page.fullscreenElement = null
    expect(getTitlebarInset()).toBe(40)
  })

  it('observes host attributes and fullscreen events and disconnects on unmount', () => {
    const page = desktop('Win32')
    const listener = vi.fn()
    const observe = vi.fn()
    const disconnect = vi.fn()
    let mutation!: MutationCallback
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: MutationCallback) { mutation = callback }
      observe = observe
      disconnect = disconnect
    })
    const unsubscribe = subscribeTitlebarInset(listener)
    expect(observe).toHaveBeenCalledWith(page.documentElement, expect.objectContaining({ attributes: true }))
    page.dispatchEvent(new Event('fullscreenchange'))
    mutation([], {} as MutationObserver)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    expect(disconnect).toHaveBeenCalledOnce()
    page.dispatchEvent(new Event('fullscreenchange'))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
