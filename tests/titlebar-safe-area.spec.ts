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
})
