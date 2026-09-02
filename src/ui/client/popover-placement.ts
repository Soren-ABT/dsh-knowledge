/** Pure viewport placement helpers shared by the portal popover and tests. */

export interface ViewportSize {
  width: number
  height: number
}

export interface BoxSize {
  width: number
  height: number
}

export interface RectEdges {
  top: number
  right: number
  bottom: number
  left: number
}

export interface ViewportPosition {
  top: number
  left: number
}

const VIEWPORT_MARGIN = 8
const MENU_GAP = 4

/** Place a root menu below/above its trigger and clamp both axes. */
export function placePopover(
  trigger: RectEdges,
  menu: BoxSize,
  viewport: ViewportSize,
  align: 'start' | 'end' = 'start',
): ViewportPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN)
  const preferredLeft = align === 'end' ? trigger.right - menu.width : trigger.left
  const left = clamp(preferredLeft, VIEWPORT_MARGIN, maxLeft)

  const below = trigger.bottom + MENU_GAP
  const above = trigger.top - menu.height - MENU_GAP
  const fitsBelow = below + menu.height <= viewport.height - VIEWPORT_MARGIN
  const fitsAbove = above >= VIEWPORT_MARGIN
  const preferredTop = fitsBelow || !fitsAbove ? below : above
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - menu.height - VIEWPORT_MARGIN)
  return { top: clamp(preferredTop, VIEWPORT_MARGIN, maxTop), left }
}

/** Place a submenu beside its parent row, flipping left near the right edge. */
export function placeSubmenu(
  parent: RectEdges,
  menu: BoxSize,
  viewport: ViewportSize,
): ViewportPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - menu.width - VIEWPORT_MARGIN)
  const right = parent.right + MENU_GAP
  const left = parent.left - menu.width - MENU_GAP
  const preferredLeft = right + menu.width <= viewport.width - VIEWPORT_MARGIN
    ? right
    : left >= VIEWPORT_MARGIN
      ? left
      : right
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - menu.height - VIEWPORT_MARGIN)
  return {
    top: clamp(parent.top, VIEWPORT_MARGIN, maxTop),
    left: clamp(preferredLeft, VIEWPORT_MARGIN, maxLeft),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
