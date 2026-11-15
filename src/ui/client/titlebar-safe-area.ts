/** Standard Window Controls Overlay geometry, independent of the host shell. */
interface TitlebarOverlay {
  readonly visible?: boolean
  getTitlebarAreaRect(): { y: number; height: number }
  addEventListener(type: 'geometrychange', listener: () => void): void
  removeEventListener(type: 'geometrychange', listener: () => void): void
}

function overlay(): TitlebarOverlay | undefined {
  return (globalThis.navigator as Navigator & { windowControlsOverlay?: TitlebarOverlay } | undefined)?.windowControlsOverlay
}

function isFullscreen(): boolean {
  const doc = globalThis.document
  const flag = doc?.documentElement?.dataset.fullscreen
  return Boolean(doc?.fullscreenElement) || flag === 'true' || flag === '1'
}

function shellInset(): number {
  const root = globalThis.document?.documentElement
  if (root !== undefined && typeof globalThis.getComputedStyle === 'function') {
    const css = getComputedStyle(root)
    for (const name of ['--host-titlebar-inset', '--dsh-windows-titlebar-height']) {
      const value = css.getPropertyValue(name).trim()
      // An explicit zero is meaningful. Reject unresolved calc()/env() values.
      if (/^\d+(?:\.\d+)?(?:px)?$/.test(value)) return Number.parseFloat(value)
    }
  }
  const nav = globalThis.navigator
  const desktop = globalThis.window as (Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }) | undefined
  if (!/\bElectron\//i.test(nav?.userAgent ?? '') && desktop?.__TAURI_INTERNALS__ === undefined && desktop?.__TAURI__ === undefined) return 0
  const platform = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`
  if (/Mac|darwin/i.test(platform)) return 38
  if (/Win/i.test(platform)) return 40
  return 0
}

function overlayInset(): number {
  try {
    const controls = overlay()
    if (controls === undefined || controls.visible === false) return 0
    const { y, height } = controls.getTitlebarAreaRect()
    if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return 0
    return Math.max(0, y + height)
  } catch {
    // A temporarily unavailable overlay must not suppress the shell fallback.
    return 0
  }
}

/** Keep all panel actions below native controls, including desktop shells. */
export function getTitlebarInset(): number {
  if (isFullscreen()) return 0
  const viewport = globalThis.window?.innerHeight ?? Number.MAX_SAFE_INTEGER
  return Math.min(Math.max(0, viewport), Math.max(overlayInset(), shellInset()))
}

export function subscribeTitlebarInset(listener: () => void): () => void {
  const controls = overlay()
  controls?.addEventListener('geometrychange', listener)
  globalThis.window?.addEventListener('resize', listener)
  globalThis.document?.addEventListener('fullscreenchange', listener)
  const root = globalThis.document?.documentElement
  const observer = root !== undefined && typeof MutationObserver !== 'undefined' ? new MutationObserver(listener) : undefined
  if (root !== undefined) observer?.observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-fullscreen'] })
  return () => {
    controls?.removeEventListener('geometrychange', listener)
    globalThis.window?.removeEventListener('resize', listener)
    globalThis.document?.removeEventListener('fullscreenchange', listener)
    observer?.disconnect()
  }
}
