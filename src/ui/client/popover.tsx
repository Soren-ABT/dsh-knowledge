/**
 * Minimal popover menu (Cherry Studio's row "⋯" / toolbar menus). A click
 * toggle with outside-click dismissal; entries may be separators, danger
 * items, or submenus (hover or click to open).
 * @module dsh-knowledge/client/popover
 */

import { useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    if (!open) return
    const onDocumentClick = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocumentClick)
    return () => document.removeEventListener('mousedown', onDocumentClick)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        style={{ display: 'inline-flex' }}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
      >
        {props.trigger}
      </span>
      {open && (
        <div
          style={{ ...style.menu, top: 'calc(100% + 4px)', ...(props.align === 'end' ? { right: 0 } : { left: 0 }) }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItems entries={props.entries} onCloseAll={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

function MenuItems(props: { entries: readonly MenuEntry[]; onCloseAll: () => void }): JSX.Element {
  const [openSub, setOpenSub] = useState<string | null>(null)
  return (
    <>
      {props.entries.map(entry =>
        entry.label === undefined
          ? <div key={entry.key} style={style.menuSeparator} />
          : (
              <div key={entry.key} style={{ position: 'relative' }}
                onMouseEnter={() => entry.children !== undefined && setOpenSub(entry.key)}
                onMouseLeave={() => { if (openSub === entry.key) setOpenSub(null) }}
              >
                <button
                  className="kb-row"
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
                  <div style={{ ...style.menu, top: -4, left: 'calc(100% + 4px)', position: 'absolute' }}>
                    <MenuItems
                      entries={entry.children}
                      onCloseAll={() => { setOpenSub(null); props.onCloseAll() }}
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
