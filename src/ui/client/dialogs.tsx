/**
 * Dialog system for the knowledge panel: modal shell, create/edit-base,
 * confirm, single-prompt (rename), and the Cherry Studio-style add-document
 * dialog with 文本/文件/网页 tabs, multi-file upload and drag-drop.
 * @module dsh-knowledge/client/dialogs
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SearchMode } from './api.js'
import { C, style } from './theme.js'
import { IconCheck, IconX } from './icons.js'
import type { Translate } from './locales.js'

// ── toasts ───────────────────────────────────────────────────────────────────

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info' | 'warning'
  text: string
}

export function Toasts(props: { toasts: readonly Toast[] }): JSX.Element | null {
  if (props.toasts.length === 0) return null
  return (
    <div style={style.toastStack}>
      {props.toasts.map(toast => (
        <div key={toast.id} style={style.toast}>
          {toast.kind === 'success'
            ? <IconCheck size={14} color={C.success} />
            : toast.kind === 'error'
              ? <IconX size={14} color={C.danger} />
              : toast.kind === 'warning'
                ? <IconX size={14} color="#f5a524" />
                : null}
          <span>{toast.text}</span>
        </div>
      ))}
    </div>
  )
}

// ── modal shell ──────────────────────────────────────────────────────────────

export function Modal(props: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: number
}): JSX.Element {
  return (
    <div style={style.modalBackdrop} onClick={props.onClose}>
      <div
        style={{ ...style.modal, ...(props.width !== undefined ? { width: props.width } : {}) }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={style.modalHeader}>
          <strong style={{ fontSize: 14 }}>{props.title}</strong>
          <button style={style.closeButton} onClick={props.onClose}><IconX size={14} /></button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

export function ConfirmDialog(props: {
  title: string
  message: string
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <Modal title={props.title} onClose={props.onClose} width={400}>
      <p style={{ fontSize: 13, margin: '0 0 16px', lineHeight: 1.6 }}>{props.message}</p>
      <div style={{ ...style.actionsRow, justifyContent: 'flex-end' }}>
        <button style={style.button} onClick={props.onClose}>✕</button>
        <button style={style.primaryDanger} onClick={props.onConfirm} disabled={props.busy === true}>{props.confirmLabel}</button>
      </div>
    </Modal>
  )
}

export function PromptDialog(props: {
  title: string
  label: string
  initial: string
  onOk: (value: string) => void
  onClose: () => void
}): JSX.Element {
  const [value, setValue] = useState(props.initial)
  return (
    <Modal title={props.title} onClose={props.onClose} width={400}>
      <div style={style.field}>
        <label style={style.label}>{props.label}</label>
        <input
          autoFocus
          style={style.input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim().length > 0) props.onOk(value.trim())
          }}
        />
      </div>
      <div style={{ ...style.actionsRow, justifyContent: 'flex-end' }}>
        <button style={style.button} onClick={props.onClose}>✕</button>
        <button style={style.primary} onClick={() => { if (value.trim().length > 0) props.onOk(value.trim()) }}>OK</button>
      </div>
    </Modal>
  )
}

// ── restore / rebuild base ────────────────────────────────────────────────────

export function RestoreBaseDialog(props: {
  defaultName: string
  t: Translate
  busy?: boolean
  onRestore: (name: string) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(props.defaultName)
  return (
    <Modal title={props.t('rebuildBase')} onClose={props.onClose} width={440}>
      <p style={{ fontSize: 13, margin: '0 0 16px', lineHeight: 1.6 }}>{props.t('restoreHint')}</p>
      <div style={style.field}>
        <label style={style.label}>{props.t('baseName')}</label>
        <input autoFocus style={style.input} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div style={{ ...style.actionsRow, justifyContent: 'flex-end' }}>
        <button style={style.button} onClick={props.onClose}>{props.t('cancel')}</button>
        <button style={style.primary} disabled={props.busy === true || name.trim().length === 0} onClick={() => props.onRestore(name.trim())}>
          {props.t('rebuildBase')}
        </button>
      </div>
    </Modal>
  )
}

// ── create base ──────────────────────────────────────────────────────────────

export function CreateBaseDialog(props: {
  t: Translate
  groups: readonly string[]
  initialGroup?: string
  busy?: boolean
  onCreate: (name: string, description: string, group?: string) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [group, setGroup] = useState(
    props.initialGroup !== undefined && props.groups.includes(props.initialGroup) ? props.initialGroup : ''
  )
  return (
    <Modal title={props.t('newBase')} onClose={props.onClose} width={440}>
      <div style={style.field}>
        <label style={style.label}>{props.t('baseName')}</label>
        <input autoFocus style={style.input} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div style={style.field}>
        <label style={style.label}>{props.t('baseDescription')}</label>
        <textarea style={{ ...style.textarea, minHeight: 60 }} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div style={style.field}>
        <label style={style.label}>{props.t('groupName')}</label>
        <select style={style.input} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">{props.t('ungrouped')}</option>
          {props.groups.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>
      <div style={{ ...style.actionsRow, justifyContent: 'flex-end' }}>
        <button style={style.button} onClick={props.onClose}>{props.t('cancel')}</button>
        <button
          style={style.primary}
          disabled={props.busy === true || name.trim().length === 0}
          onClick={() => props.onCreate(name.trim(), description.trim(), group.trim() === '' ? undefined : group.trim())}
        >
          {props.t('create')}
        </button>
      </div>
    </Modal>
  )
}

// ── add data source (Cherry Studio style: file → OS picker, dir/url → dialogs) ──

const FILE_ACCEPT = '.txt,.md,.markdown,.csv,.html,.htm,.json,.log,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.epub'
const MAX_FILES = 20
export { FILE_ACCEPT, MAX_FILES }

// ── helpers ──────────────────────────────────────────────────────────────────

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(new Error('failed to read file'))
    reader.readAsDataURL(file)
  })
}

/** Re-exported for type consumers of the client dictionary surface. */
export type { SearchMode }
