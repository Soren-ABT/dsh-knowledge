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

/** Leave the entire native titlebar above the panel, including left-side controls. */
export function getTitlebarInset(): number {
  try {
    const controls = overlay()
    if (controls === undefined || controls.visible === false) return 0
    const { y, height } = controls.getTitlebarAreaRect()
    if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return 0
    const viewport = globalThis.window?.innerHeight ?? Number.MAX_SAFE_INTEGER
    return Math.min(Math.max(0, viewport), Math.max(0, y + height))
  } catch {
    // Unsupported/temporarily unavailable API: CSS env() remains the fallback.
    return 0
  }
}

export function subscribeTitlebarInset(listener: () => void): () => void {
  const controls = overlay()
  controls?.addEventListener('geometrychange', listener)
  globalThis.window?.addEventListener('resize', listener)
  return () => {
    controls?.removeEventListener('geometrychange', listener)
    globalThis.window?.removeEventListener('resize', listener)
  }
}
