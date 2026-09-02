/**
 * Minimal popover menu (Cherry Studio's row "⋯" / toolbar menus). A click
 * toggle with outside-click dismissal; entries may be separators, danger
 * items, or submenus (hover or click to open).
 * @module dsh-knowledge/client/popover
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { placePopover, placeSubmenu } from './popover-placement.js'
import type { ViewportPosition } from './popover-placement.js'
import { style } from './theme.js'

const MENU_WIDTH = 220

export interface MenuEntry {
  key: string
  /** Omit the label to render a separator. */
  label?: string
  icon?: JSX.Element
  danger?: boolean
  onSelect?: () => void
  children?: readonly MenuEntry[]
}

export function PopoverMenu(props: {
  trigger: ReactNode
  entries: readonly MenuEntry[]
  align?: 'start' | 'end'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // The menu renders in a body-level portal, OUTSIDE ref — track it too so
  // clicks on menu items are not treated as outside-clicks (otherwise the
  // mousedown dismissal unmounts the menu before the item's click fires and
  // every menu action silently dies).
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<ViewportPosition | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (ref.current !== null && ref.current.contains(target)) return
      if (menuRef.current !== null && menuRef.current.contains(target)) return
      setOpen(false)
    }
    const onScroll = (): void => setOpen(false)
    const onResize = (): void => setOpen(false)
    document.addEventListener('mousedown', onDocumentClick)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDocumentClick)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  // Correct the initial estimate with the rendered menu's actual dimensions.
  useLayoutEffect(() => {
    if (!open || ref.current === null || menuRef.current === null) return
    const trigger = ref.current.getBoundingClientRect()
    const menu = menuRef.current.getBoundingClientRect()
    const next = placePopover(
      trigger,
      { width: menu.width, height: menu.height },
      { width: window.innerWidth, height: window.innerHeight },
      props.align,
    )
    setPos(current => current?.top === next.top && current.left === next.left ? current : next)
  }, [open, props.align, props.entries])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && ref.current !== null) {
      const rect = ref.current.getBoundingClientRect()
      setPos(placePopover(
        rect,
        { width: MENU_WIDTH, height: estimateMenuHeight(props.entries) },
        { width: window.innerWidth, height: window.innerHeight },
        props.align,
      ))
    }
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        style={{ display: 'inline-flex' }}
        onClick={(e) => { e.stopPropagation(); toggle() }}
      >
        {props.trigger}
      </span>
      {open && pos !== null && createPortal(
        <div
          ref={menuRef}
          style={{
            ...style.menu,
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: MENU_WIDTH,
            maxWidth: 'calc(100vw - 16px)',
            // Body-level portal: sit above the whole panel (zIndex 300) so the
            // menu can never be buried by list rows or clipped by a scrollable
            // sidebar's overflow.
            zIndex: 1000,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItems entries={props.entries} onCloseAll={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </div>
  )
}

/** Rough menu height for deciding whether to open below vs above the trigger. */
function estimateMenuHeight(entries: readonly MenuEntry[]): number {
  let h = 8 // menu vertical padding
  for (const e of entries) h += e.label === undefined ? 9 : 36 // separator vs item
  return h
}

function MenuItems(props: { entries: readonly MenuEntry[]; onCloseAll: () => void }): JSX.Element {
  const [openSub, setOpenSub] = useState<{ key: string; position: ViewportPosition } | null>(null)
  const closeTimer = useRef<number | null>(null)
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpenSub(null), 150)
  }
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])
  const openChildren = (entry: MenuEntry, element: HTMLElement): void => {
    if (entry.children === undefined) return
    const rect = element.getBoundingClientRect()
    setOpenSub({
      key: entry.key,
      position: placeSubmenu(
        rect,
        { width: MENU_WIDTH, height: estimateMenuHeight(entry.children) },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    })
  }
  return (
    <>
      {props.entries.map(entry =>
        entry.label === undefined
          ? <div key={entry.key} style={style.menuSeparator} />
          : (
              <div key={entry.key} style={{ position: 'relative' }}
                onMouseEnter={(event) => { if (entry.children !== undefined) { cancelClose(); openChildren(entry, event.currentTarget) } }}
                onMouseLeave={() => { if (openSub?.key === entry.key) scheduleClose() }}
              >
                <button
                  className="kb-row kb-menuitem"
                  style={{ ...style.menuItem, ...(entry.danger === true ? style.menuItemDanger : {}) }}
                  onClick={(event) => {
                    if (entry.children !== undefined) {
                      if (openSub?.key === entry.key) setOpenSub(null)
                      else openChildren(entry, event.currentTarget.parentElement ?? event.currentTarget)
                      return
                    }
                    props.onCloseAll()
                    entry.onSelect?.()
                  }}
                >
                  <span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {entry.icon ?? null}
                    {entry.label}
                  </span>
                  {entry.children !== undefined && <span style={{ color: 'inherit', opacity: 0.55, fontSize: 10 }}>▸</span>}
                </button>
                {entry.children !== undefined && openSub?.key === entry.key && (
                  <div style={{
                    ...style.menu,
                    position: 'fixed',
                    top: openSub.position.top,
                    left: openSub.position.left,
                    width: MENU_WIDTH,
                    maxWidth: 'calc(100vw - 16px)',
                    zIndex: 1001,
                  }}
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                  >
                    <MenuItems
                      entries={entry.children}
                      onCloseAll={() => { cancelClose(); setOpenSub(null); props.onCloseAll() }}
                    />
                  </div>
                )}
              </div>
            )
      )}
    </>
  )
}

/** Fixed-position context menu (right-click), sharing the same entry shape. */
export function ContextMenu(props: {
  x: number
  y: number
  entries: readonly MenuEntry[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) props.onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    const onScroll = (): void => props.onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [props.onClose])
  return (
    <div ref={ref} style={{ ...style.menu, position: 'fixed', left: props.x, top: props.y, zIndex: 300 }}>
      <MenuItems entries={props.entries} onCloseAll={props.onClose} />
    </div>
  )
}
