/**
 * Minimal popover menu (Cherry Studio's row "⋯" / toolbar menus). A click
 * toggle with outside-click dismissal; entries may be separators, danger
 * items, or submenus (hover or click to open).
 * @module dsh-knowledge/client/popover
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { style } from './theme.js'

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
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null)

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

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && ref.current !== null) {
      const rect = ref.current.getBoundingClientRect()
      // Open below the trigger; flip above when there isn't enough room below
      // (menu is rendered in a body-level portal so it must stay in the viewport).
      const est = estimateMenuHeight(props.entries)
      const below = window.innerHeight - rect.bottom - 8
      const above = rect.top - 8
      const top = (below >= est || below >= above) ? rect.bottom + 4 : Math.max(8, rect.top - est - 4)
      setPos({
        top,
        left: props.align === 'end' ? undefined : rect.left,
        right: props.align === 'end' ? window.innerWidth - rect.right : undefined,
      })
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
            right: pos.right,
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
  const [openSub, setOpenSub] = useState<string | null>(null)
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
  return (
    <>
      {props.entries.map(entry =>
        entry.label === undefined
          ? <div key={entry.key} style={style.menuSeparator} />
          : (
              <div key={entry.key} style={{ position: 'relative' }}
                onMouseEnter={() => { if (entry.children !== undefined) { cancelClose(); setOpenSub(entry.key) } }}
                onMouseLeave={() => { if (openSub === entry.key) scheduleClose() }}
              >
                <button
                  className="kb-row kb-menuitem"
                  style={{ ...style.menuItem, ...(entry.danger === true ? style.menuItemDanger : {}) }}
                  onClick={() => {
                    if (entry.children !== undefined) {
                      setOpenSub(openSub === entry.key ? null : entry.key)
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
                {entry.children !== undefined && openSub === entry.key && (
                  <div style={{ ...style.menu, top: 'calc(100% + 4px)', left: 0, position: 'absolute' }}
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
