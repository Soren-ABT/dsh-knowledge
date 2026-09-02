import { describe, expect, it } from 'vitest'
import { placePopover, placeSubmenu } from '../src/ui/client/popover-placement.js'

describe('popover placement', () => {
  const viewport = { width: 800, height: 600 }

  it('keeps a top-level menu inside the viewport and flips above the trigger', () => {
    expect(placePopover(
      { top: 560, right: 790, bottom: 584, left: 750 },
      { width: 180, height: 160 },
      viewport,
      'end',
    )).toEqual({ top: 396, left: 610 })
  })

  it('opens a submenu beside its parent and flips to the left near the right edge', () => {
    expect(placeSubmenu(
      { top: 120, right: 790, bottom: 156, left: 610 },
      { width: 180, height: 240 },
      viewport,
    )).toEqual({ top: 120, left: 426 })
  })

  it('clamps oversized placements to the viewport margin', () => {
    expect(placeSubmenu(
      { top: 580, right: 110, bottom: 616, left: 10 },
      { width: 900, height: 700 },
      viewport,
    )).toEqual({ top: 8, left: 8 })
  })
})
