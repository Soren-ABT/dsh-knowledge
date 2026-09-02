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

export function Toasts(props: { toasts: readonly Toast[]; onDismiss?: (id: number) => void }): JSX.Element | null {
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
          <span style={{ userSelect: 'text', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{toast.text}</span>
          <button style={style.toastClose} onClick={() => props.onDismiss?.(toast.id)} aria-label="close">
            <IconX size={12} color={C.muted} />
          </button>
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
        <button className="kb-danger-primary" style={style.primaryDanger} onClick={props.onConfirm} disabled={props.busy === true}>{props.confirmLabel}</button>
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
  const [submitting, setSubmitting] = useState(false)
  const submit = (): void => {
    if (submitting || value.trim().length === 0) return
    // Debounce repeat Enter/click: the parent closes the dialog on success,
    // but a double-firing onOk would otherwise run the action twice (e.g.
    // creating two bases).
    setSubmitting(true)
    props.onOk(value.trim())
  }
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
            if (e.key === 'Enter') submit()
          }}
        />
      </div>
      <div style={{ ...style.actionsRow, justifyContent: 'flex-end' }}>
        <button style={style.button} onClick={props.onClose}>✕</button>
        <button className="kb-primary" style={style.primary} disabled={submitting || value.trim().length === 0} onClick={submit}>OK</button>
      </div>
    </Modal>
  )
}

// ── restore / rebuild base ────────────────────────────────────────────────────

/** Cherry's note-create: a title + content text document added straight to the base. */
export function TextDocumentDialog(props: {
  t: Translate
  busy?: boolean
  onCreate: (title: string, content: string) => void
  onClose: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  return (
    <Modal title={props.t('tabText')} onClose={props.onClose} width={460}>
      <div style={style.field}>
        <label style={style.label}>{props.t('baseName')}</label>
        <input
          autoFocus
          style={style.input}
          value={title}
          placeholder={props.t('textTitlePlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div style={style.field}>
        <label style={style.label}>{props.t('textContentLabel')}</label>
        <textarea
          style={{ ...style.textarea, minHeight: 180 }}
          value={content}
          placeholder={props.t('textContentPlaceholder')}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div style={{ ...style.actionsRow, justifyContent: 'flex-end' }}>
        <button style={style.button} onClick={props.onClose}>{props.t('cancel')}</button>
        <button
          className="kb-primary" style={style.primary}
          disabled={props.busy === true || title.trim().length === 0 || content.trim().length === 0}
          onClick={() => props.onCreate(title.trim(), content)}
        >
          {props.t('tabText')}
        </button>
      </div>
    </Modal>
  )
}

/** Embedding configuration chosen for the rebuilt base (undefined = keep the source base's config). */
export interface RestoreEmbeddingConfig {
  provider: 'openai' | 'ollama' | 'local'
  baseUrl: string
  model: string
  apiKey: string
}

export function RestoreBaseDialog(props: {
  defaultName: string
  t: Translate
  busy?: boolean
  onRestore: (name: string, config?: RestoreEmbeddingConfig) => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(props.defaultName)
  // Cherry's restore dialog lets the rebuild switch embedding models (the
  // "换模型 → 重建" route); empty model = keep the source base's config.
  const [provider, setProvider] = useState<'none' | 'openai' | 'ollama' | 'local'>('none')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const modelChanged = provider !== 'none'
  return (
    <Modal title={props.t('rebuildBase')} onClose={props.onClose} width={460}>
      <p style={{ fontSize: 13, margin: '0 0 16px', lineHeight: 1.6 }}>{props.t('restoreHint')}</p>
      <div style={style.field}>
        <label style={style.label}>{props.t('baseName')}</label>
        <input autoFocus style={style.input} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div style={style.field}>
        <label style={style.label}>{props.t('embeddingModel')}</label>
        <select style={style.input} value={provider} onChange={(e) => {
          const next = e.target.value as typeof provider
          // Auto-fill the well-known local Ollama endpoint when the user
          // switches to Ollama, so the URL is not retyped by hand.
          if (next === 'ollama' && baseUrl.trim() === '') setBaseUrl('http://127.0.0.1:11434')
          setProvider(next)
        }}>
          <option value="none">{props.t('restoreKeepModel')}</option>
          <option value="openai">{props.t('providerOpenAI')}</option>
          <option value="ollama">Ollama</option>
          <option value="local">{props.t('providerLocal')}</option>
        </select>
      </div>
      {modelChanged && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <div style={style.field}>
            <label style={style.label}>{props.t('modelId')}</label>
            <input
              style={style.input}
              list="kb-restore-model-list"
              value={model}
              placeholder={provider === 'local' ? 'onnx-community/Qwen3-Embedding-0.6B-ONNX' : 'text-embedding-3-small'}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="kb-restore-model-list">
              {provider === 'local' && (
                <>
                  <option value="onnx-community/Qwen3-Embedding-0.6B-ONNX" />
                  <option value="Xenova/bge-small-zh-v1.5" />
                  <option value="Xenova/bge-small-en-v1.5" />
                  <option value="Xenova/gte-small" />
                </>
              )}
              {provider !== 'local' && (
                <>
                  <option value="text-embedding-3-small" />
                  <option value="text-embedding-3-large" />
                  <option value="bge-m3" />
                  <option value="bge-large-zh-v1.5" />
                </>
              )}
            </datalist>
          </div>
          <div style={style.field}>
            <label style={style.label}>{props.t('baseUrlLabel')}</label>
            <input
              style={style.input}
              value={baseUrl}
              placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          {provider === 'openai' && (
            <div style={style.field}>
              <label style={style.label}>{props.t('apiKeyLabel')}</label>
              <input style={style.input} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
          )}
        </div>
      )}
      <div style={{ ...style.actionsRow, justifyContent: 'flex-end' }}>
        <button style={style.button} onClick={props.onClose}>{props.t('cancel')}</button>
        <button
          className="kb-primary" style={style.primary}
          disabled={props.busy === true || name.trim().length === 0 || (modelChanged && model.trim().length === 0)}
          onClick={() => props.onRestore(
            name.trim(),
            modelChanged
              ? { provider, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() }
              : undefined,
          )}
        >
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
          className="kb-primary" style={style.primary}
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

const FILE_ACCEPT = '.txt,.md,.markdown,.mdx,.csv,.html,.htm,.json,.log,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.epub'
const MAX_FILES = 20
/**
 * Upload cap: the JSON upload API limits bodies to 32MB, so a base64 payload
 * leaves ~24MB for the file itself. Pre-checked client-side with headroom
 * (22MB) so oversized files fail with a clear message, not a server 500.
 */
const MAX_UPLOAD_BYTES = 22 * 1024 * 1024
export { FILE_ACCEPT, MAX_FILES, MAX_UPLOAD_BYTES }

/** Extension set shared by the directory import filter (Cherry's directory scan skips others). */
export const SUPPORTED_IMPORT_EXTENSIONS = new Set(FILE_ACCEPT.split(',').map(ext => ext.slice(1)))

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
