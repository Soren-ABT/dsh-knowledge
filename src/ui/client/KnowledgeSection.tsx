/**
 * Cherry Studio-style knowledge base UI: a sidebar-foot nav action plus a
 * frame-wide floating panel. Left navigator holds search + base cards; the
 * detail side has Cherry Studio's three views — 资料 (data source list),
 * 召回测试 (recall test), and 设置 (per-base rag config with 文档处理 /
 * 嵌入模型 / 重排模型 / Top K / 高级设置) — switched by the detail header.
 * Row actions ride a hover-revealed "⋯" menu; feedback rides toasts.
 * @module dsh-knowledge/client/KnowledgeSection
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, DragEvent } from 'react'
import { KnowledgeApi } from './api.js'
import type {
  BaseStats,
  BaseSummary,
  ChunkView,
  DocumentSummary,
  KnowledgeConfig,
  SearchHit,
  SearchMode,
} from './api.js'
import { C, PANEL_CSS, avatarColor, formatRelativeTime, formatSize, style } from './theme.js'
import {
  IconBook,
  IconCheck,
  IconEye,
  IconFlask,
  IconMore,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSliders,
  IconTrash,
  IconFolder,
  IconFolderOpen,
  docIconStyle,
  fileVisual,
} from './icons.js'
import {
  ConfirmDialog,
  CreateBaseDialog,
  FILE_ACCEPT,
  MAX_FILES,
  MAX_UPLOAD_BYTES,
  PromptDialog,
  RestoreBaseDialog,
  SUPPORTED_IMPORT_EXTENSIONS,
  Toasts,
  readFileAsBase64,
} from './dialogs.js'
import type { Toast } from './dialogs.js'
import { ContextMenu, PopoverMenu } from './popover.js'
import type { MenuEntry } from './popover.js'
import { RagConfigPanel } from './rag-config.js'
import type { Translate } from './locales.js'
import type { KnowledgePanelStore } from './panel-store.js'

export type { Translate } from './locales.js'

// Shared styles (panel + sidebar-entry hover) must exist before the sidebar
// button first renders — the panel itself injects nothing until it opens.
if (typeof document !== 'undefined' && document.getElementById('kb-panel-styles') === null) {
  const el = document.createElement('style')
  el.id = 'kb-panel-styles'
  el.textContent = PANEL_CSS
  document.head.appendChild(el)
}

/** Cap the document-preview payload so huge files cannot wedge the panel. */
const PREVIEW_RAW_TEXT_LIMIT = 200_000
const PREVIEW_CHUNK_LIMIT = 500
/** Cherry's in-panel PDF viewer caps at 100 MB; above that we suggest the download. */
const PDF_PREVIEW_MAX_BYTES = 100 * 1024 * 1024

// ── sidebar action ───────────────────────────────────────────────────────────

/** The sidebar-foot entry beside Settings: opens the knowledge panel.
 *  Styled to match the shell's Settings trigger (same 34px row / 36px rail
 *  geometry and tokens) so the footer reads as one unit. */
export function SidebarKnowledgeAction(props: {
  store: KnowledgePanelStore
  t: Translate
  wide: boolean
}): JSX.Element {
  const open = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  return (
    <button
      className="kb-sidebar-action"
      style={{
        ...style.sidebarAction,
        ...(props.wide ? {} : style.sidebarActionRail),
        ...(open ? style.sidebarActionActive : {}),
      }}
      onClick={() => props.store.toggle()}
      title={props.t('nav')}
      aria-label={props.t('nav')}
    >
      <IconBook size={props.wide ? 16 : 18} />
      {props.wide ? <span>{props.t('nav')}</span> : null}
    </button>
  )
}

// ── the panel ────────────────────────────────────────────────────────────────

/** Frame-wide Cherry Studio-style knowledge base page. */
export function KnowledgePanel(props: {
  store: KnowledgePanelStore
  api: KnowledgeApi
  t: Translate
}): JSX.Element | null {
  const open = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
  if (!open) return null
  return <PanelBody api={props.api} t={props.t} onClose={() => props.store.close()} />
}

type DialogState =
  | { kind: 'createBase'; initialGroup?: string }
  | { kind: 'renameBase'; base: BaseSummary }
  | { kind: 'restoreBase' }
  | { kind: 'confirmDeleteBase'; base: BaseSummary }
  | { kind: 'confirmDeleteDoc'; doc: DocumentSummary }
  | { kind: 'confirmBulkDelete'; count: number }
  | { kind: 'renameDoc'; doc: DocumentSummary }
  | { kind: 'createGroup'; forBaseId?: string }
  | { kind: 'renameGroup'; group: string }
  | { kind: 'confirmDeleteGroup'; group: string }
  | { kind: 'addUrl' }
  | null

interface RecallEntry {
  id: number
  query: string
  time: number
}

function PanelBody(props: { api: KnowledgeApi; t: Translate; onClose: () => void }): JSX.Element {
  const { api, t, onClose } = props
  const [bases, setBases] = useState<BaseSummary[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null)
  const [ragOpen, setRagOpen] = useState(false)
  const [recallOpen, setRecallOpen] = useState(false)
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [chunks, setChunks] = useState<ChunkView[]>([])
  const [rawText, setRawText] = useState<string | null>(null)
  const [rawTextTruncated, setRawTextTruncated] = useState(false)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [currentDirectoryId, setCurrentDirectoryId] = useState<string | null>(null)
  const [detailMode, setDetailMode] = useState<'preview' | 'chunks'>('preview')
  const [checkedDocIds, setCheckedDocIds] = useState<Set<string>>(new Set())
  const [globalConfig, setGlobalConfig] = useState<KnowledgeConfig | null>(null)
  const [toggle, setToggle] = useState<{ enabled: boolean; enabledBaseIds: string[] } | null>(null)
  const [stats, setStats] = useState<BaseStats | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searchMeta, setSearchMeta] = useState<{ reranked: boolean; elapsedMs: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dialog, setDialog] = useState<DialogState>(null)
  const [recallHistory, setRecallHistory] = useState<RecallEntry[]>([])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; doc: DocumentSummary } | null>(null)
  // Optimistic processing marks: rows flip to 解析中 the moment a reindex is
  // requested, WITHOUT waiting for the poll — a fast reindex (small folder,
  // hash-reused embeddings) can finish before the first poll observes it,
  // while Cherry's asynchronous job keeps its preparing state visible. The
  // marks clear when the request settles.
  const [optimisticProcessing, setOptimisticProcessing] = useState<Set<string>>(new Set())
  // Cherry's empty-state guidance: when the global embedding provider is the
  // local model and it is not downloaded yet, the empty base explains what to
  // do instead of silently importing vectors-less content.
  const [localEmbeddingDownloaded, setLocalEmbeddingDownloaded] = useState<boolean | null>(null)
  const [docLimit, setDocLimit] = useState(100)
  const [navWidth, setNavWidth] = useState(272)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  // Relative timestamps (formatRelativeTime) recompute on render; with the
  // poll stopped while idle there is nothing forcing a re-render, so "3 分钟前"
  // would freeze. A minute tick keeps every relative time fresh.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(t => t + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const notify = useCallback((kind: Toast['kind'], text: string): void => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, kind, text }])
    window.setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id))
    }, 3200)
  }, [])

  const run = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [notify])

  const refreshBases = useCallback(async (): Promise<void> => {
    const [nextBases, nextConfig, nextGroups, nextToggle] = await Promise.all([
      api.listBases(),
      api.getConfig(),
      api.listGroups(),
      api.getKnowledgeToggle(),
    ])
    setBases(nextBases)
    setGlobalConfig(nextConfig)
    setGroups(nextGroups)
    setToggle(nextToggle)
  }, [api])

  useEffect(() => { void run(refreshBases) }, [run, refreshBases])

  const updateToggle = useCallback(async (patch: { enabled?: boolean; enabledBaseIds?: string[] }): Promise<void> => {
    const next = await api.setKnowledgeToggle(patch)
    setToggle(next)
    notify('success', t('save'))
  }, [api, notify, t])

  const onNavResizeStart = useCallback((event: React.MouseEvent): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = navWidth
    const onMove = (ev: MouseEvent): void => {
      setNavWidth(Math.min(360, Math.max(220, startWidth + (ev.clientX - startX))))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [navWidth])

  // Local embedding readiness, for the empty-state guidance.
  useEffect(() => {
    let cancelled = false
    void api.listLocalModels().then(list => {
      if (!cancelled) setLocalEmbeddingDownloaded(list.some(m => m.kind === 'embedding' && m.status === 'ready'))
    }).catch(() => { if (!cancelled) setLocalEmbeddingDownloaded(true) })
    return () => { cancelled = true }
  }, [api])

  const refreshStats = useCallback(async (baseId: string | null): Promise<void> => {
    setStats(await api.stats(baseId ?? undefined))
  }, [api])

  // Monotonic guard for base/document navigation: a slow response from a
  // previous selection must never overwrite the current one (rapid A→B
  // switching used to end up showing A's documents under B's selection).
  const navSeq = useRef(0)

  const selectBase = useCallback(async (id: string): Promise<void> => {
    const seq = ++navSeq.current
    setSelectedBaseId(id)
    setSelectedDocId(null)
    setCurrentDirectoryId(null)
    setCheckedDocIds(new Set())
    setChunks([])
    setRawText(null)
    setRawTextTruncated(false)
    setHits([])
    setSearchMeta(null)
    setRagOpen(false)
    setRecallOpen(false)
    setDocLimit(100)
    await run(async () => {
      const [docs, stats] = await Promise.all([api.listDocuments(id), api.stats(id)])
      if (seq !== navSeq.current) return
      setDocuments(docs)
      setStats(stats)
    })
  }, [api, run])

  const openDocument = useCallback(async (id: string, mode: 'preview' | 'chunks'): Promise<void> => {
    const seq = ++navSeq.current
    setSelectedDocId(id)
    setDetailMode(mode)
    setChunks([])
    setRawText(null)
    setRawTextTruncated(false)
    // PDFs preview through an embedded viewer (raw?inline=1), so their parsed
    // text does not need to be shipped to the panel (rawTextLimit 0 = skip).
    const known = documents.find(doc => doc.id === id)
    const pdfPreview = known?.sourceType === 'file' && (known.fileName ?? '').toLowerCase().endsWith('.pdf')
    await run(async () => {
      const [doc, chunkList] = await Promise.all([
        api.getDocument(id, { rawTextLimit: pdfPreview ? 0 : PREVIEW_RAW_TEXT_LIMIT }),
        api.listChunks(id, PREVIEW_CHUNK_LIMIT),
      ])
      if (seq !== navSeq.current) return
      setChunks(chunkList)
      setRawText(doc.rawText ?? null)
      setRawTextTruncated(doc.rawTextTruncated === true)
    })
  }, [api, run, documents])

  const loadMoreChunks = useCallback(async (): Promise<void> => {
    if (selectedDocId === null) return
    const seq = navSeq.current
    await run(async () => {
      const more = await api.listChunks(selectedDocId, chunks.length + PREVIEW_CHUNK_LIMIT)
      if (seq !== navSeq.current) return
      setChunks(more)
    })
  }, [api, run, selectedDocId, chunks.length])

  const drillIntoDirectory = useCallback((directoryId: string): void => {
    setSelectedDocId(null)
    setCurrentDirectoryId(directoryId)
    setCheckedDocIds(new Set())
    setDocLimit(100)
  }, [])

  const navigateUp = useCallback((): void => {
    const current = currentDirectoryId !== null ? documents.find(doc => doc.id === currentDirectoryId) : undefined
    setCurrentDirectoryId(current?.parentDirectoryId ?? null)
    setCheckedDocIds(new Set())
    setDocLimit(100)
  }, [currentDirectoryId, documents])

  const reloadDocuments = useCallback(async (): Promise<void> => {
    if (selectedBaseId === null) return
    const next = await api.listDocuments(selectedBaseId)
    setDocuments(next)
    await refreshStats(selectedBaseId)
    await refreshBases()
    // Cherry's data-driven polling: rows carry live status + progress from
    // listDocuments itself, so the poll only watches for state FLIPS (a
    // placeholder appearing, or processing rows settling). Kick the poll when
    // this refresh observed processing rows; it stops itself once idle.
    if (next.some(doc => doc.status === 'processing')) setPollKick(kick => kick + 1)
  }, [api, refreshBases, refreshStats, selectedBaseId])

  // Cherry's conditional polling: 800ms while anything is importing/embedding
  // (detects state flips and refreshes the list), STOPS when idle — a new
  // import re-kicks it via reloadDocuments (every user action refreshes).
  const [pollKick, setPollKick] = useState(0)
  useEffect(() => {
    if (selectedBaseId === null) return
    let disposed = false
    let timer: number | undefined
    const activeIdsRef: { current: Set<string> } = { current: new Set() }
    const poll = async (): Promise<void> => {
      let anyActive = false
      try {
        const entries = await api.getIndexingStatus()
        const activeIds = new Set<string>()
        for (const entry of entries) {
          if (entry.baseId === selectedBaseId) activeIds.add(entry.docId)
        }
        anyActive = activeIds.size > 0
        const changed = !sameSet(activeIdsRef.current, activeIds)
        activeIdsRef.current = activeIds
        if (!disposed && changed) void reloadDocuments()
      } catch {
        // polling is best-effort
      }
      // Continue only while active; otherwise stop and wait for the next
      // reloadDocuments kick (no more idle-timeout polling — the list is
      // always fresh right after any user action anyway).
      if (!disposed && anyActive) {
        timer = window.setTimeout(() => { void poll() }, 800)
      }
    }
    void poll()
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [api, selectedBaseId, reloadDocuments, pollKick])

  // ── base actions ────────────────────────────────────────────────────────

  const createBase = useCallback(async (name: string, description: string, group?: string): Promise<void> => {
    await run(async () => {
      const created = await api.createBase(name, description, group ?? '')
      notify('success', `${t('newBase')}: ${name}`)
      setDialog(null)
      await refreshBases()
      await selectBase(created.id)
    })
  }, [api, run, refreshBases, selectBase, notify, t])

  const renameBase = useCallback(async (base: BaseSummary, name: string): Promise<void> => {
    await run(async () => {
      await api.updateBase(base.id, { name, description: base.description })
      notify('success', t('save'))
      setDialog(null)
      await refreshBases()
    })
  }, [api, run, refreshBases, notify, t])

  // ── group actions ────────────────────────────────────────────────────────

  const createGroup = useCallback(async (name: string, forBaseId?: string): Promise<void> => {
    await run(async () => {
      const next = await api.createGroup(name)
      setGroups(next)
      if (forBaseId !== undefined) await api.updateBase(forBaseId, { group: name })
      notify('success', `${t('newGroup')}: ${name}`)
      setDialog(null)
      await refreshBases()
    })
  }, [api, run, refreshBases, notify, t])

  const renameGroup = useCallback(async (from: string, to: string): Promise<void> => {
    await run(async () => {
      setGroups(await api.renameGroup(from, to))
      notify('success', t('save'))
      setDialog(null)
      await refreshBases()
    })
  }, [api, run, refreshBases, notify, t])

  const deleteGroup = useCallback(async (name: string): Promise<void> => {
    await run(async () => {
      await api.deleteGroup(name)
      notify('success', `${t('delete')}: ${name}`)
      setDialog(null)
      await refreshBases()
    })
  }, [api, run, refreshBases, notify, t])

  const moveBase = useCallback(async (base: BaseSummary, group?: string): Promise<void> => {
    await run(async () => {
      // `group: ''` (not undefined) so the server clears the group: an
      // undefined field is dropped by JSON serialization and would leave a
      // base stuck in its old group when moving to 未分组.
      await api.updateBase(base.id, { group: group ?? '' })
      await refreshBases()
    })
  }, [api, run, refreshBases])

  const removeBase = useCallback(async (base: BaseSummary): Promise<void> => {
    await run(async () => {
      await api.deleteBase(base.id)
      notify('success', `${t('delete')}: ${base.name}`)
      if (selectedBaseId === base.id) {
        setSelectedBaseId(null)
        setDocuments([])
        setChunks([])
        setRawText(null)
        setHits([])
        setStats(null)
      }
      setDialog(null)
      await refreshBases()
    })
  }, [api, run, refreshBases, notify, selectedBaseId, t])

  const saveBaseConfig = useCallback(async (): Promise<void> => {
    notify('success', t('save'))
    await reloadDocuments()
    await refreshBases()
  }, [notify, reloadDocuments, refreshBases, t])

  // ── document actions ─────────────────────────────────────────────────────

  const onImported = useCallback((label: string): void => {
    notify('success', `${label} ${t('uploaded')}`)
    setDialog(null)
    void run(reloadDocuments)
  }, [notify, run, reloadDocuments, t])

  const promptForUrl = useCallback((): void => {
    if (selectedBaseId === null) return
    setDialog({ kind: 'addUrl' })
  }, [selectedBaseId])

  const addUrl = useCallback((url: string): void => {
    if (selectedBaseId === null) return
    const trimmed = url.trim()
    if (trimmed === '') return
    void run(async () => {
      try {
        await api.addUrlDocument(selectedBaseId, trimmed, currentDirectoryId ?? undefined)
        onImported(trimmed)
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err))
      }
    })
  }, [api, run, onImported, notify, selectedBaseId, currentDirectoryId])

  // Cherry Studio parity: every picked file becomes a row immediately (parsing
  // status) and the per-base worker pool processes them in the background; the
  // 800ms status poll keeps the list live. Failures stay visible in the list
  // as red failed rows (hover shows the reason), like Cherry's failed items.
  const runFileImport = useCallback(async (files: File[]): Promise<void> => {
    if (selectedBaseId === null || files.length === 0) return
    // The upload API caps the JSON body at 32MB (base64 → ~24MB of file).
    // Reject oversized files up front with a clear message instead of a
    // server-side 500.
    const oversized = files.filter(file => file.size > MAX_UPLOAD_BYTES)
    const accepted = files.filter(file => file.size <= MAX_UPLOAD_BYTES)
    for (const file of oversized) notify('warning', t('fileTooLarge').replace('{name}', file.name))
    if (accepted.length === 0) return
    notify('info', `${accepted.length} ${t('uploaded')}…`)
    // Per-file failure isolation: one bad file (e.g. a server-side reject)
    // must not abort the rest of the batch silently — failures are collected
    // and surfaced in a single error toast, successes counted separately.
    let failed = 0
    let firstError = ''
    for (const file of accepted) {
      try {
        const contentBase64 = await readFileAsBase64(file)
        // Files added while inside a directory land IN that directory
        // (Cherry disables adding inside directories; carrying the parent id
        // keeps the drill-down consistent instead of silently dropping the
        // file at the base root).
        await api.addFileDocument(selectedBaseId, file.webkitRelativePath || file.name, file.type || 'application/octet-stream', contentBase64, undefined, currentDirectoryId ?? undefined)
      } catch (err) {
        failed += 1
        if (firstError === '') firstError = err instanceof Error ? err.message : String(err)
      }
    }
    await reloadDocuments()
    if (failed === 0) {
      notify('success', `${accepted.length} ${t('uploaded')}`)
    } else {
      notify('warning', `${accepted.length - failed}/${accepted.length} ${t('uploaded')}`)
      notify('error', `${failed} ${t('importFailed')}: ${firstError}`)
    }
  }, [api, notify, reloadDocuments, selectedBaseId, currentDirectoryId, t])

  // ── drag & drop upload (Cherry Studio drops files onto the knowledge list) ──

  const dragCarriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')

  const handleDragEnter = useCallback((event: DragEvent): void => {
    if (!dragCarriesFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }, [])

  const handleDragOver = useCallback((event: DragEvent): void => {
    if (dragCarriesFiles(event)) event.preventDefault()
  }, [])

  const handleDragLeave = useCallback((): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }, [])

  const handleDrop = useCallback((event: DragEvent): void => {
    if (!dragCarriesFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length > 0) void runFileImport(files)
  }, [runFileImport])

  const runDirectoryImport = useCallback(async (files: File[]): Promise<void> => {
    if (selectedBaseId === null || files.length === 0) return
    // Cherry's directory scan only picks up supported files and skips hidden
    // entries — mirror that here so a folder of mixed content imports
    // cleanly instead of shipping unsupported binaries to the parser.
    const supported = files.filter(file => {
      const rel = file.webkitRelativePath || file.name
      if (rel.split('/').some(segment => segment.startsWith('.'))) return false
      const dot = file.name.lastIndexOf('.')
      const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
      return SUPPORTED_IMPORT_EXTENSIONS.has(ext)
    })
    const skippedCount = files.length - supported.length
    if (supported.length === 0) {
      notify('warning', t('noSupportedFiles'))
      return
    }
    const rel = (file: File): string => file.webkitRelativePath || file.name
    const segments = (file: File): string[] => rel(file).split('/')
    const rootName = segments(supported[0])[0] ?? 'folder'
    notify('info', `${t('tabDir')}: ${supported.length} ${t('uploaded')}…`)
    // Counters live OUTSIDE the try so the success toast below can read them
    // even when the per-file loop never ran (whole-batch failure).
    let oversizedCount = 0
    let submitted = 0
    let failed = 0
    let firstError = ''
    try {
      // 1. collect unique directory paths (excluding the root) sorted by depth
      const dirPaths = new Set<string>()
      for (const file of supported) {
        const parts = segments(file)
        for (let i = 1; i < parts.length - 1; i += 1) dirPaths.add(parts.slice(0, i + 1).join('/'))
      }
      const sortedDirs = [...dirPaths].sort((a, b) => a.split('/').length - b.split('/').length)
      // 2. create the root directory container, then nested directories
      const dirId = new Map<string, string>()
      const root = await api.createDirectory(selectedBaseId, rootName)
      dirId.set(rootName, root.id)
      for (const dirPath of sortedDirs) {
        const parts = dirPath.split('/')
        const parentPath = parts.slice(0, -1).join('/')
        const created = await api.createDirectory(selectedBaseId, parts[parts.length - 1], dirId.get(parentPath))
        dirId.set(dirPath, created.id)
      }
      // 3. submit every file under its directory — rows land immediately and
      //    the background pool processes them (Cherry: whole directory, no cap)
      for (const file of supported) {
        if (file.size > MAX_UPLOAD_BYTES) {
          oversizedCount += 1
          notify('warning', t('fileTooLarge').replace('{name}', file.name))
          continue
        }
        const parts = segments(file)
        const dirPath = parts.slice(0, -1).join('/')
        const parentId = dirPath === rootName || dirPath === '' ? root.id : dirId.get(dirPath)
        try {
          const contentBase64 = await readFileAsBase64(file)
          await api.addFileDocument(selectedBaseId, file.name, file.type || 'application/octet-stream', contentBase64, undefined, parentId)
          submitted += 1
        } catch (err) {
          // One bad file must not abort the whole directory import.
          failed += 1
          if (firstError === '') firstError = err instanceof Error ? err.message : String(err)
        }
      }
      if (oversizedCount > 0) {
        notify('warning', t('fileTooLarge').replace('{name}', `${oversizedCount} files`))
      }
      if (failed > 0) {
        notify('warning', `${submitted}/${supported.length - oversizedCount} ${t('uploaded')}`)
        notify('error', `${failed} ${t('importFailed')}: ${firstError}`)
      }
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    }
    await reloadDocuments()
    notify('success', `${submitted} ${t('uploaded')}`)
    if (skippedCount > 0) notify('info', t('skippedFiles').replace('{count}', String(skippedCount)))
  }, [api, notify, reloadDocuments, selectedBaseId, t])

  const renameDocument = useCallback(async (doc: DocumentSummary, title: string): Promise<void> => {
    await run(async () => {
      await api.renameDocument(doc.id, title)
      notify('success', t('save'))
      setDialog(null)
      await reloadDocuments()
    })
  }, [api, run, reloadDocuments, notify, t])

  const removeDocument = useCallback(async (doc: DocumentSummary): Promise<void> => {
    await run(async () => {
      await api.deleteDocument(doc.id)
      notify('success', `${t('delete')}: ${doc.title}`)
      if (selectedDocId === doc.id) { setChunks([]); setRawText(null); setRawTextTruncated(false); setSelectedDocId(null) }
      setDialog(null)
      await reloadDocuments()
    })
  }, [api, run, reloadDocuments, notify, selectedDocId, t])

  // All descendants of a directory row (every nesting level), for the
  // optimistic processing marks — a reindex touches the whole subtree.
  const collectSubtreeIds = useCallback((rootId: string): string[] => {
    const ids: string[] = []
    const walk = (parentId: string): void => {
      for (const doc of documents) {
        if (doc.parentDirectoryId === parentId) {
          ids.push(doc.id)
          walk(doc.id)
        }
      }
    }
    walk(rootId)
    return [rootId, ...ids]
  }, [documents])

  const reindexDoc = useCallback(async (doc: DocumentSummary): Promise<void> => {
    // Optimistic: mark the folder and its WHOLE subtree (all nesting levels)
    // as processing immediately — a fast reindex would otherwise finish
    // before any poll observes it, leaving deep folders/files on 'ready'.
    const optimisticIds = collectSubtreeIds(doc.id)
    setOptimisticProcessing(prev => new Set([...prev, ...optimisticIds]))
    // Kick the poll BEFORE the request: the host reindexes synchronously and
    // rows flip parsing → embedding NN% server-side while the request is in
    // flight — the poll must be running to surface that live state (Cherry's
    // reindex job reports progress continuously).
    setPollKick(kick => kick + 1)
    await run(async () => {
      await api.reindexDocument(doc.id)
      notify('success', `${t('reindexDone')}: ${doc.title}`)
      await reloadDocuments()
    })
    setOptimisticProcessing(prev => {
      const next = new Set(prev)
      for (const id of optimisticIds) next.delete(id)
      return next
    })
  }, [api, run, reloadDocuments, notify, t, collectSubtreeIds])

  const refreshUrlDoc = useCallback(async (doc: DocumentSummary): Promise<void> => {
    await run(async () => {
      const result = await api.refreshUrlDocument(doc.id)
      notify('success', result.changed
        ? `${t('urlRefreshed')}: ${doc.title}`
        : `${t('urlUnchanged')}: ${doc.title}`)
      if (selectedDocId === doc.id) { setChunks([]); setRawText(null); setRawTextTruncated(false); setSelectedDocId(null) }
      await reloadDocuments()
    })
  }, [api, run, reloadDocuments, notify, selectedDocId, t])

  // ── bulk selection ────────────────────────────────────────────────────────

  const checkedDocs = documents.filter(doc => checkedDocIds.has(doc.id))
  const allChecked = documents.length > 0 && checkedDocs.length === documents.length
  const someChecked = checkedDocs.length > 0 && !allChecked

  const toggleDoc = useCallback((id: string, next: boolean): void => {
    setCheckedDocIds(prev => {
      const nextSet = new Set(prev)
      if (next) nextSet.add(id)
      else nextSet.delete(id)
      return nextSet
    })
  }, [])

  const toggleAll = useCallback((): void => {
    setCheckedDocIds(allChecked ? new Set() : new Set(documents.map(doc => doc.id)))
  }, [allChecked, documents])

  const bulkReindex = useCallback(async (): Promise<void> => {
    // Skip rows still processing up front (Cherry's bulk gate: only
    // completed/failed items are reindexable) so the batch is never rejected.
    const reindexable = checkedDocs.filter(doc => doc.status !== 'processing')
    const skipped = checkedDocs.length - reindexable.length
    if (reindexable.length === 0) {
      notify('warning', t('bulkReindexNone'))
      return
    }
    const optimisticIds = reindexable.flatMap(doc => collectSubtreeIds(doc.id))
    setOptimisticProcessing(prev => new Set([...prev, ...optimisticIds]))
    setPollKick(kick => kick + 1)
    await run(async () => {
      const result = await api.reindexDocuments(reindexable.map(doc => doc.id))
      const totalSkipped = skipped + (result.skipped ?? 0)
      notify('success', `${t('reindexDone')} ${result.reindexed}${totalSkipped > 0 ? ` · ${t('bulkReindexSkipped')} ${totalSkipped}` : ''}`)
      setCheckedDocIds(new Set())
      await reloadDocuments()
    })
    setOptimisticProcessing(prev => {
      const next = new Set(prev)
      for (const id of optimisticIds) next.delete(id)
      return next
    })
  }, [api, run, reloadDocuments, notify, checkedDocs, t, collectSubtreeIds])

  const bulkDelete = useCallback(async (): Promise<void> => {
    await run(async () => {
      const result = await api.deleteDocuments(checkedDocs.map(doc => doc.id))
      notify('success', `${t('delete')}: ${result.deleted}`)
      setCheckedDocIds(new Set())
      await reloadDocuments()
    })
  }, [api, run, reloadDocuments, notify, checkedDocs, t])

  const restoreBase = useCallback(async (name: string): Promise<void> => {
    if (selectedBaseId === null) return
    await run(async () => {
      const created = await api.restoreBase(selectedBaseId, name)
      notify('success', `${t('rebuildBase')}: ${created.name}`)
      setDialog(null)
      await refreshBases()
      await selectBase(created.id)
    })
  }, [api, run, refreshBases, selectBase, notify, selectedBaseId, t])

  const docTypeLabel = useCallback((doc: DocumentSummary): string => {
    if (doc.sourceType === 'url') return t('tabUrl')
    if (doc.sourceType === 'text') return t('tabText')
    if (doc.sourceType === 'directory') return t('tabDir')
    const name = doc.fileName ?? ''
    const dot = name.lastIndexOf('.')
    if (dot < 0) return 'FILE'
    return name.slice(dot + 1).toUpperCase()
  }, [t])

  // ── recall test ───────────────────────────────────────────────────────────

  // Search results are guarded against out-of-order responses: typing a new
  // query (or switching base) while the previous search is still in flight
  // must not let the stale response overwrite the newer one.
  const searchSeq = useRef(0)
  const doSearch = useCallback(async (query: string): Promise<void> => {
    const trimmed = query.trim()
    if (trimmed === '') return
    const seq = ++searchSeq.current
    setSearchQuery(trimmed)
    await run(async () => {
      const result = await api.search({ query: trimmed, baseId: selectedBaseId ?? undefined })
      if (seq !== searchSeq.current) return
      setHits(result.hits)
      setSearchMeta({ reranked: result.reranked, elapsedMs: result.elapsedMs })
      setRecallHistory(prev => [{ id: Date.now(), query: trimmed, time: Date.now() }, ...prev].slice(0, 20))
    })
  }, [api, run, selectedBaseId])

  const removeRecallHistory = useCallback((id: number): void => {
    setRecallHistory(prev => prev.filter(entry => entry.id !== id))
  }, [])

  const clearRecallHistory = useCallback((): void => {
    setRecallHistory([])
  }, [])

  const selectedBase = bases.find(b => b.id === selectedBaseId) ?? null
  const selectedDoc = documents.find(doc => doc.id === selectedDocId) ?? null
  const visibleDocuments = documents.filter(doc => (doc.parentDirectoryId ?? null) === currentDirectoryId)
  const renderedDocuments = visibleDocuments.slice(0, docLimit)
  const hasMoreDocuments = visibleDocuments.length > docLimit
  // Folders show "importing" while any descendant file is still parsing/embedding.
  const parentOf = new Map<string, string | null>()
  for (const doc of documents) parentOf.set(doc.id, doc.parentDirectoryId ?? null)
  const processingDocIds = new Set<string>()
  for (const doc of documents) if (doc.status === 'processing') processingDocIds.add(doc.id)
  const importingFolderIds = new Set<string>()
  for (const id of processingDocIds) {
    let parent = parentOf.get(id) ?? null
    while (parent !== null) {
      importingFolderIds.add(parent)
      parent = parentOf.get(parent) ?? null
    }
  }
  const currentDirectoryTitle = currentDirectoryId !== null
    ? documents.find(doc => doc.id === currentDirectoryId)?.title ?? ''
    : ''
  const filterText = filter.trim().toLowerCase()
  const filteredBases = filterText === ''
    ? bases
    : bases.filter(base => base.name.toLowerCase().includes(filterText))

  // Group sections: 未分组 first, then each group in stored order. Empty
  // groups are shown only when not searching (Cherry Studio behaviour).
  const hasGroups = groups.length > 0
  const sectionOf = (base: BaseSummary): string => base.group ?? ''
  const sectionKeys: string[] = []
  if (hasGroups || filterText !== '') sectionKeys.push('')
  for (const group of groups) sectionKeys.push(group)
  const basesBySection = new Map<string, BaseSummary[]>()
  for (const base of filteredBases) {
    let key = hasGroups ? sectionOf(base) : ''
    if (hasGroups && key !== '' && !groups.includes(key)) key = '' // stale group → ungrouped
    const list = basesBySection.get(key)
    if (list !== undefined) list.push(base)
    else basesBySection.set(key, [base])
  }
  const toggleCollapse = (key: string): void => {
    setCollapsedGroups(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key])
  }

  const baseRowMenu = (base: BaseSummary): MenuEntry[] => [
    { key: 'rename', label: t('rename'), onSelect: () => setDialog({ kind: 'renameBase', base }) },
    {
      key: 'move',
      label: t('moveToGroup'),
      children: [
        { key: 'ungrouped', label: t('ungrouped'), onSelect: () => void moveBase(base) },
        ...groups.map(group => ({ key: group, label: group, onSelect: () => void moveBase(base, group) })),
      ],
    },
    { key: 'create-group', label: t('newGroup'), onSelect: () => setDialog({ kind: 'createGroup', forBaseId: base.id }) },
    { key: 'sep' },
    { key: 'delete', label: t('delete'), danger: true, onSelect: () => setDialog({ kind: 'confirmDeleteBase', base }) },
  ]

  const groupRowMenu = (group: string): MenuEntry[] => [
    { key: 'rename', label: t('rename'), onSelect: () => setDialog({ kind: 'renameGroup', group }) },
    { key: 'create-base', label: t('newBase'), onSelect: () => setDialog({ kind: 'createBase', initialGroup: group }) },
    { key: 'sep' },
    { key: 'delete', label: t('delete'), danger: true, onSelect: () => setDialog({ kind: 'confirmDeleteGroup', group }) },
  ]

  const renderBaseRow = (base: BaseSummary): JSX.Element => (
    <div
      key={base.id}
      className="kb-row kb-card"
      style={{ ...style.baseCard, ...(base.id === selectedBaseId ? style.baseCardActive : {}) }}
      onClick={() => void selectBase(base.id)}
    >
      <span style={{ ...style.baseAvatar, background: avatarColor(base.name) }}>
        {base.name.trim().charAt(0).toUpperCase() || '?'}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ ...style.baseName, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {base.name}
        </span>
        <span style={style.baseMeta}>
          {base.documentCount}{t('docCount')} · {formatSize(base.charCount)}
        </span>
      </span>
      <PopoverMenu
        align="end"
        trigger={<span className="kb-iconbtn" style={style.iconOnlyButton}><IconMore /></span>}
        entries={baseRowMenu(base)}
      />
    </div>
  )

  const addSourceMenu: MenuEntry[] = [
    { key: 'file', label: t('tabFile'), onSelect: () => fileInputRef.current?.click() },
    { key: 'dir', label: t('tabDir'), onSelect: () => dirInputRef.current?.click() },
    { key: 'url', label: t('tabUrl'), onSelect: () => promptForUrl() },
  ]

  const docRowMenu = (doc: DocumentSummary): MenuEntry[] => {
    if (doc.sourceType === 'directory') {
      // Cherry's directory row menu: drill into it, reindex its subtree,
      // delete it (Cherry also shows view-chunks on a completed directory;
      // dsh directories carry no chunks of their own, so that entry is N/A).
      return [
        { key: 'open', label: t('openFolder'), icon: <IconFolderOpen size={14} />, onSelect: () => drillIntoDirectory(doc.id) },
        { key: 'reindex', label: t('reindexButton'), icon: <IconRefresh size={14} />, onSelect: () => void reindexDoc(doc) },
        { key: 'sep' },
        { key: 'delete', label: t('delete'), danger: true, onSelect: () => setDialog({ kind: 'confirmDeleteDoc', doc }) },
      ]
    }
    return [
      { key: 'preview', label: t('viewSource'), icon: <IconEye size={14} />, onSelect: () => void openDocument(doc.id, 'preview') },
      { key: 'chunks', label: t('viewChunks'), icon: <IconEye size={14} />, onSelect: () => void openDocument(doc.id, 'chunks') },
      { key: 'reindex', label: t('reindexButton'), icon: <IconRefresh size={14} />, onSelect: () => void reindexDoc(doc) },
      ...(doc.sourceType === 'url'
        ? [{ key: 'refresh-url', label: t('refreshUrl'), icon: <IconRefresh size={14} />, onSelect: () => void refreshUrlDoc(doc) }]
        : []),
      { key: 'sep' },
      { key: 'delete', label: t('delete'), danger: true, onSelect: () => setDialog({ kind: 'confirmDeleteDoc', doc }) },
    ]
  }

  return (
    <div style={style.panel} className="kb-panel-in">
      <div style={style.header}>
        <div style={style.headerLeft}>
          <IconBook size={20} color={C.accent} />
          <span style={style.headerTitle}>{t('nav')}</span>
          {busy && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted }}>
              <span className="kb-spinner" style={style.spinner} />{t('processing')}
            </span>
          )}
        </div>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {toggle !== null && (
            <KnowledgeToggle
              enabled={toggle.enabled}
              enabledBaseIds={toggle.enabledBaseIds}
              bases={bases}
              t={t}
              onChange={(enabled, ids) => void updateToggle({ enabled, enabledBaseIds: ids })}
            />
          )}
          <button style={style.closeButton} onClick={onClose} title={t('close')} aria-label={t('close')}>✕</button>
        </span>
      </div>

      <Toasts toasts={toasts} />

      <div style={style.body}>
        <aside style={{ ...style.sidebar, width: navWidth }} className="kb-scroll">
          <input
            style={style.input}
            placeholder={t('searchBases')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button style={style.newBaseButton} onClick={() => setDialog({ kind: 'createBase' })} disabled={busy}>
            <IconPlus />{t('newBase')}
          </button>
          <button style={style.newBaseButton} onClick={() => setDialog({ kind: 'createGroup' })} disabled={busy}>
            <IconPlus />{t('newGroup')}
          </button>
          {filteredBases.length === 0
            ? <div style={style.empty}>{t('noBases')}</div>
            : !hasGroups && filterText === ''
              ? filteredBases.map(renderBaseRow)
              : sectionKeys.map(key => {
                  const items = basesBySection.get(key) ?? []
                  if (filterText !== '' && items.length === 0) return null
                  const collapsed = collapsedGroups.includes(key)
                  const isGroup = key !== ''
                  return (
                    <div key={key} style={{ marginBottom: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 6px' }}>
                        <button
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
                            border: 'none', background: 'transparent', padding: '4px 6px', cursor: 'pointer',
                            fontSize: 11, fontWeight: 700, color: C.muted, textAlign: 'left',
                            letterSpacing: 0.4, textTransform: 'uppercase',
                          }}
                          onClick={() => toggleCollapse(key)}
                        >
                          <span style={{ fontSize: 9 }}>{collapsed ? '▸' : '▾'}</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {isGroup ? key : t('ungrouped')}
                          </span>
                          <span style={{ fontSize: 10, fontWeight: 600, opacity: 0.75 }}>{items.length}</span>
                        </button>
                        {isGroup && (
                          <PopoverMenu
                            align="end"
                            trigger={<span className="kb-iconbtn" style={{ ...style.iconOnlyButton, width: 22, height: 22 }}><IconMore /></span>}
                            entries={groupRowMenu(key)}
                          />
                        )}
                      </div>
                      {!collapsed && <div>{items.map(renderBaseRow)}</div>}
                    </div>
                  )
                })}
        </aside>

        <div
          onMouseDown={onNavResizeStart}
          style={{ width: 5, cursor: 'col-resize', flexShrink: 0, background: 'transparent', borderRight: `1px solid ${C.border}` }}
          title={t('dragResize')}
        />

        <main style={style.main} className="kb-scroll">
          {selectedBaseId === null || selectedBase === null ? (
            <div style={{ ...style.card, ...style.empty }}>
              <div style={{ fontSize: 30, marginBottom: 8, color: C.muted }}><IconBook size={30} color={C.muted} /></div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t('selectBase')}</div>
              <div style={{ fontSize: 12 }}>{t('noDocsHint')}</div>
            </div>
          ) : (
            <>
              {/* Detail header: name + 召回测试 / 设置 (Cherry Studio DetailHeader) */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ ...style.baseAvatar, background: avatarColor(selectedBase.name), width: 26, height: 26, fontSize: 12 }}>
                    {selectedBase.name.trim().charAt(0).toUpperCase() || '?'}
                  </span>
                  <span style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {selectedBase.name}
                  </span>
                </span>
                <span style={style.actionsRow}>
                  {stats?.staleEmbeddings === true ? (
                    <button
                      className="kb-row"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600,
                        color: C.danger, border: `1px solid ${C.danger}`, borderRadius: 999, padding: '2px 10px',
                        background: 'transparent', cursor: 'pointer',
                      }}
                      onClick={() => setDialog({ kind: 'restoreBase' })}
                      title={t('rebuildHint')}
                    >
                      ✕ {t('rebuildBase')}
                    </button>
                  ) : (
                    <>
                      <button
                        className="kb-row"
                        style={{ ...style.ghostButton, ...(recallOpen ? { color: C.accent, background: accentSoftText() } : {}) }}
                        onClick={() => setRecallOpen(v => !v)}
                      >
                        <IconFlask size={14} />{t('recallTest')}
                      </button>
                      <button
                        className="kb-iconbtn"
                        style={{ ...style.iconOnlyButton, ...(ragOpen ? { color: C.accent, background: accentSoftText() } : {}) }}
                        title={t('settings')}
                        aria-label={t('settings')}
                        onClick={() => setRagOpen(v => !v)}
                      >
                        <IconSliders size={14} />
                      </button>
                    </>
                  )}
                </span>
              </div>

              {selectedDocId !== null && selectedDoc !== null ? (
                <DocumentDetailPanel
                  key={selectedDoc.id}
                  doc={selectedDoc}
                  rawText={rawText}
                  rawTextTruncated={rawTextTruncated}
                  chunks={chunks}
                  t={t}
                  initialMode={detailMode}
                  onBack={() => { setSelectedDocId(null); setChunks([]); setRawText(null); setRawTextTruncated(false) }}
                  onLoadMoreChunks={() => void loadMoreChunks()}
                />
              ) : (
                <>
                  {stats !== null && (
                    <div style={style.statsRow}>
                      <StatChip value={stats.documentCount} label={t('statsDocs')} />
                      <StatChip value={stats.chunkCount} label={t('statsChunks')} />
                      <StatChip value={stats.tokenCount} label={t('statsTokens')} />
                      <StatChip value={formatSize(stats.charCount)} label={t('statsChars')} />
                      <StatChip value={stats.embedded ? '✓' : '—'} label={stats.embedded ? t('embedded') : t('notEmbedded')} />
                    </div>
                  )}

                  {stats !== null && stats.documentCount > 0 && !stats.embedded
                    && globalConfig !== null
                    && (selectedBase.config?.embeddingProvider ?? globalConfig.embeddingProvider) === 'none' && (
                      <div style={{ ...style.warningHint, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <span>{t('embeddingNotConfigured')}</span>
                        <button style={{ ...style.button, flexShrink: 0 }} onClick={() => setRagOpen(true)}>
                          <IconSliders size={13} />{t('settings')}
                        </button>
                      </div>
                    )}

                  <div
                    style={{ ...style.card, ...(dragOver ? { outline: `2px dashed ${C.accent}`, outlineOffset: -4 } : {}) }}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    {dragOver && (
                      <div style={{
                        position: 'absolute', inset: 0, zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 8%, transparent)',
                        borderRadius: 10, pointerEvents: 'none',
                      }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: C.accent, background: 'var(--dsw-bg-base, #fff)', padding: '8px 16px', borderRadius: 999, boxShadow: '0 2px 10px rgba(0,0,0,0.12)' }}>
                          {t('dragToUpload')}
                        </span>
                      </div>
                    )}
                    {currentDirectoryId !== null && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <button className="kb-row" style={style.button} onClick={navigateUp}>← {t('backToParent')}</button>
                        <span style={{ fontSize: 12, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentDirectoryTitle}</span>
                      </div>
                    )}
                    {someChecked || allChecked ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{t('selected')} {checkedDocs.length}</span>
                        <span style={style.actionsRow}>
                          <button style={style.button} disabled={busy} onClick={() => void bulkReindex()}>
                            <IconRefresh size={13} />{t('bulkReindex')}
                          </button>
                          <button
                            style={style.primaryDanger}
                            disabled={busy}
                            onClick={() => setDialog({ kind: 'confirmBulkDelete', count: checkedDocs.length })}
                          >
                            <IconTrash size={13} />{t('bulkDelete')}
                          </button>
                        </span>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 11, color: C.muted }}>
                          {t('updatedAtText')} {formatRelativeTime(selectedBase.updatedAt)}
                        </span>
                        <PopoverMenu
                          align="end"
                          trigger={<button style={style.primary} disabled={busy}><IconPlus />{t('addSource')}</button>}
                          entries={addSourceMenu}
                        />
                      </div>
                    )}
                    {visibleDocuments.length === 0
                      ? (
                          currentDirectoryId !== null ? (
                            <div style={style.empty}>
                              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
                                <IconFolder size={26} color={C.muted} />
                              </div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t('emptyFolder')}</div>
                            </div>
                          ) : documents.length === 0 ? (
                            <div style={{ ...style.empty, padding: '28px 12px' }}>
                              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 14 }}>{t('firstUploadTitle')}</div>
                              {/* Same add-source dropdown as the table header, so
                                  the entry point is identical everywhere. */}
                              <div style={{ display: 'flex', justifyContent: 'center' }}>
                                <PopoverMenu
                                  align="start"
                                  trigger={<button style={style.primary} disabled={busy}><IconPlus />{t('addSource')}</button>}
                                  entries={addSourceMenu}
                                />
                              </div>
                              {globalConfig !== null
                                && globalConfig.embeddingProvider === 'local'
                                && localEmbeddingDownloaded === false && (
                                <div style={{ ...style.warningHint, marginTop: 14, maxWidth: 420, marginLeft: 'auto', marginRight: 'auto', textAlign: 'center' }}>
                                  {t('embeddingModelMissingHint')}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div style={style.empty}>
                              <div style={{ fontSize: 26, marginBottom: 6 }}>📄</div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t('noDocuments')}</div>
                              <div style={{ fontSize: 12 }}>{t('noDocsHint')}</div>
                            </div>
                          )
                        )
                      : (
                          <div style={{ marginTop: 8 }}>
                            <div style={style.tableHeadRow}>
                              <Checkbox checked={allChecked} indeterminate={someChecked} onChange={() => toggleAll()} ariaLabel={t('selectAll')} />
                              <span>{t('baseName')}</span>
                              <span>{t('type')}</span>
                              <span>{t('status')}</span>
                              <span>{t('updatedAtColumn')}</span>
                              <span />
                            </div>
                            {renderedDocuments.map(doc => (
                              <div
                                key={doc.id}
                                className="kb-row"
                                style={style.tableRow}
                                onClick={() => doc.sourceType === 'directory' ? drillIntoDirectory(doc.id) : void openDocument(doc.id, 'preview')}
                                onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, doc }) }}
                              >
                                <Checkbox
                                  checked={checkedDocIds.has(doc.id)}
                                  onChange={(next) => toggleDoc(doc.id, next)}
                                  ariaLabel={doc.title}
                                />
                                <span style={{ minWidth: 0 }}>
                                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                    {doc.sourceType === 'directory'
                                      ? <span style={docIconStyle('#f5a623')}><IconFolder size={16} /></span>
                                      : (() => {
                                          const visual = doc.sourceType === 'url'
                                            ? { color: '#10b981', icon: fileVisual('page').icon }
                                            : fileVisual(doc.fileName ?? 'text.txt')
                                          const DocIcon = visual.icon
                                          return <span style={docIconStyle(visual.color)}><DocIcon size={15} color={visual.color} /></span>
                                        })()}
                                    <span style={{ minWidth: 0 }}>
                                      <span style={{ ...style.docTitle, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {doc.title}
                                      </span>
                                      <span style={style.docMeta}>
                                        {doc.sourceType === 'directory'
                                          ? `${doc.childCount ?? 0} ${t('docCount')}`
                                          : `${doc.chunkCount}${t('chunkCount')} · ${formatSize(doc.charCount)}`}
                                      </span>
                                    </span>
                                  </span>
                                </span>
                                <span style={{ fontSize: 12, color: C.muted }}>{docTypeLabel(doc)}</span>
                                {doc.sourceType === 'directory' ? (
                                  importingFolderIds.has(doc.id) ? (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.accent }}>
                                      <span className="kb-spinner" style={{ ...style.spinner, width: 10, height: 10, borderWidth: 2 }} />
                                      {t('statusImporting')}
                                    </span>
                                  ) : doc.indexingPhase !== undefined || optimisticProcessing.has(doc.id) ? (
                                    // The container itself is being rescanned (reindex of a
                                    // source-backed folder) — Cherry's directory preparing.
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.accent }}>
                                      <span className="kb-spinner" style={{ ...style.spinner, width: 10, height: 10, borderWidth: 2 }} />
                                      {doc.indexingPhase === 'parsing' || optimisticProcessing.has(doc.id) ? t('statusParsing') : t('statusProcessing')}
                                    </span>
                                  ) : (
                                    // Cherry's directory completed → ready badge (dsh used a
                                    // bare '—' here, which read as 'no model running').
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: C.success }}>
                                      <IconCheck size={12} />{t('ready')}
                                    </span>
                                  )
                                ) : (() => {
                                  const phase = doc.indexingPhase
                                  const progress = doc.indexingProgress ?? 0
                                  if (phase !== undefined) {
                                    return (
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.accent }}>
                                        <span className="kb-spinner" style={{ ...style.spinner, width: 10, height: 10, borderWidth: 2 }} />
                                        {phase === 'parsing' ? t('statusParsing') : `${t('statusProcessing')} ${progress}%`}
                                      </span>
                                    )
                                  }
                                  if (optimisticProcessing.has(doc.id)) {
                                    // Reindex requested, request in flight — show live feedback
                                    // even before the poll observes the server-side state.
                                    return (
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.accent }}>
                                        <span className="kb-spinner" style={{ ...style.spinner, width: 10, height: 10, borderWidth: 2 }} />
                                        {t('statusParsing')}
                                      </span>
                                    )
                                  }
                                  if (doc.status === 'completed') {
                                    return (
                                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: C.success }}>
                                        <IconCheck size={12} />{t('ready')}
                                      </span>
                                    )
                                  }
                                  if (doc.status === 'failed') {
                                    return (
                                      <span
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: C.danger }}
                                        title={doc.embeddingError}
                                      >
                                        ✕ {t('embeddingFailed')}
                                      </span>
                                    )
                                  }
                                  return (
                                    <span
                                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: C.muted }}
                                      title={t('lexicalOnlyHint')}
                                    >
                                      {t('lexicalOnly')}
                                    </span>
                                  )
                                })()}
                                <span style={{ fontSize: 11, color: C.muted }}>
                                  {doc.updatedAt !== undefined ? formatRelativeTime(doc.updatedAt) : ''}
                                </span>
                                <PopoverMenu
                                  align="end"
                                  trigger={<span className="kb-iconbtn" style={style.iconOnlyButton}><IconMore /></span>}
                                  entries={docRowMenu(doc)}
                                />
                              </div>
                            ))}
                            {hasMoreDocuments && (
                              <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
                                <button className="kb-row" style={style.button} onClick={() => setDocLimit(v => v + 100)}>
                                  {t('loadMore')}（{renderedDocuments.length}/{visibleDocuments.length}）
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                  </div>
                </>
              )}
            </>
          )}
        </main>

        {ragOpen && globalConfig !== null && selectedBase !== null && (
          <SidePanel title={t('baseSettings')} onClose={() => setRagOpen(false)}>
            <RagConfigPanel
              base={selectedBase}
              globalConfig={globalConfig}
              api={api}
              t={t}
              busy={busy}
              onSaved={() => void saveBaseConfig()}
            />
          </SidePanel>
        )}

        {recallOpen && selectedBase !== null && (
          <SidePanel title={t('recallTest')} onClose={() => setRecallOpen(false)}>
            <RecallPanel
              t={t}
              busy={busy}
              searchQuery={searchQuery}
              hits={hits}
              searchMeta={searchMeta}
              history={recallHistory}
              onQueryChange={setSearchQuery}
              onSearch={(query) => void doSearch(query)}
              onReplay={(query) => void doSearch(query)}
              onRemoveHistory={removeRecallHistory}
              onClearHistory={clearRecallHistory}
            />
          </SidePanel>
        )}
      </div>

      {/* dialogs */}
      {dialog?.kind === 'createBase' && (
        <CreateBaseDialog
          t={t}
          groups={groups}
          initialGroup={dialog.initialGroup}
          busy={busy}
          onCreate={(name, description, group) => void createBase(name, description, group)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'createGroup' && (
        <PromptDialog
          title={t('newGroup')}
          label={t('groupName')}
          initial=""
          onOk={(value) => void createGroup(value, dialog.forBaseId)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'renameGroup' && (
        <PromptDialog
          title={t('renameGroup')}
          label={t('groupName')}
          initial={dialog.group}
          onOk={(value) => void renameGroup(dialog.group, value)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirmDeleteGroup' && (
        <ConfirmDialog
          title={t('delete')}
          message={t('confirmDeleteGroup')}
          confirmLabel={t('delete')}
          busy={busy}
          onConfirm={() => void deleteGroup(dialog.group)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'renameBase' && (
        <PromptDialog
          title={t('rename')}
          label={t('baseName')}
          initial={dialog.base.name}
          onOk={(value) => void renameBase(dialog.base, value)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'restoreBase' && selectedBase !== null && (
        <RestoreBaseDialog
          defaultName={`${selectedBase.name} (${t('rebuildBase')})`}
          t={t}
          busy={busy}
          onRestore={(name) => void restoreBase(name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirmDeleteBase' && (
        <ConfirmDialog
          title={t('delete')}
          message={t('confirmDeleteBase')}
          confirmLabel={t('delete')}
          busy={busy}
          onConfirm={() => void removeBase(dialog.base)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirmDeleteDoc' && (
        <ConfirmDialog
          title={t('delete')}
          message={t('confirmDeleteDoc')}
          confirmLabel={t('delete')}
          busy={busy}
          onConfirm={() => void removeDocument(dialog.doc)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'confirmBulkDelete' && (
        <ConfirmDialog
          title={t('delete')}
          message={t('confirmBulkDelete').replace('{count}', String(dialog.count))}
          confirmLabel={t('bulkDelete')}
          busy={busy}
          onConfirm={() => { setDialog(null); void bulkDelete() }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'addUrl' && (
        <PromptDialog
          title={t('tabUrl')}
          label={t('urlDesc')}
          initial=""
          onOk={(value) => { setDialog(null); addUrl(value) }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'renameDoc' && (
        <PromptDialog
          title={t('renameDoc')}
          label={t('baseName')}
          initial={dialog.doc.title}
          onOk={(value) => void renameDocument(dialog.doc, value)}
          onClose={() => setDialog(null)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={FILE_ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          // Cherry parity: an interactive FILE pick is capped at 20 items with a
          // friendly hint (directory imports are uncapped — see the input below).
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (picked.length > MAX_FILES) {
            notify('warning', t('tooManyFiles').replace('{count}', String(MAX_FILES)))
          }
          void runFileImport(picked.slice(0, MAX_FILES))
        }}
      />
      <input
        ref={dirInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is a Chromium-only attribute for a native folder picker
        webkitdirectory=""
        style={{ display: 'none' }}
        onChange={(e) => {
          // No item cap on directory imports (Cherry: a folder is one source and
          // the whole tree is processed; truncating here silently dropped files).
          const picked = Array.from(e.target.files ?? [])
          e.target.value = ''
          void runDirectoryImport(picked)
        }}
      />

      {contextMenu !== null && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entries={docRowMenu(contextMenu.doc)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

function accentSoftText(): string {
  return 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 10%, transparent)'
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

function RecallPanel(props: {
  t: Translate
  busy: boolean
  searchQuery: string
  hits: SearchHit[]
  searchMeta: { reranked: boolean; elapsedMs: number } | null
  history: readonly RecallEntry[]
  onQueryChange: (value: string) => void
  onSearch: (query: string) => void
  onReplay: (query: string) => void
  onRemoveHistory: (id: number) => void
  onClearHistory: () => void
}): JSX.Element {
  const { t } = props
  const [historyOpen, setHistoryOpen] = useState(false)
  const hasHistory = props.history.length > 0
  const canSearch = props.searchQuery.trim().length > 0 && !props.busy
  const topScore = props.hits.length > 0 ? Math.max(...props.hits.map(hit => hit.score)) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 }}>
      {/* search bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', position: 'relative' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 10px', background: C.surface }}>
          <IconSearch size={14} color={C.muted} />
          <input
            style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: 13, color: C.text, minWidth: 0 }}
            placeholder={t('searchPlaceholder')}
            value={props.searchQuery}
            onChange={(e) => props.onQueryChange(e.target.value)}
            onFocus={() => setHistoryOpen(hasHistory)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSearch) props.onSearch(props.searchQuery) }}
          />
          {hasHistory && (
            <button
              style={{ ...style.iconOnlyButton, width: 22, height: 22 }}
              onClick={() => setHistoryOpen(v => !v)}
              aria-label={t('recallHistory')}
            >🕘</button>
          )}
        </div>
        <button style={style.primary} disabled={!canSearch} onClick={() => props.onSearch(props.searchQuery)}>⚡{t('searchButton')}</button>

        {hasHistory && historyOpen && (
          <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 40, maxHeight: 220, overflowY: 'auto', background: C.overlay, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 10px 32px rgba(0,0,0,0.18)', padding: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 8px' }}>
              <span style={{ fontSize: 11, color: C.muted }}>{t('recallHistory')}</span>
              <button style={{ border: 'none', background: 'transparent', color: C.danger, cursor: 'pointer', fontSize: 11 }} onClick={props.onClearHistory}>{t('recallHistoryClear')}</button>
            </div>
            {props.history.map(entry => (
              <div key={entry.id} className="kb-row" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', borderRadius: 7, cursor: 'pointer' }} onClick={() => { props.onReplay(entry.query); setHistoryOpen(false) }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>🕘 {entry.query}</span>
                <button
                  style={{ border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 12 }}
                  aria-label={t('recallHistoryRemove')}
                  onClick={(e) => { e.stopPropagation(); props.onRemoveHistory(entry.id) }}
                >✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* body */}
      {props.busy ? (
        <div style={{ ...style.empty, flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <span className="kb-spinner" style={style.spinner} />
          <span>{t('recallSearching')}</span>
        </div>
      ) : props.searchMeta === null ? (
        <div style={{ ...style.empty, flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('recallEmptyTitle')}</div>
          <div style={{ fontSize: 12 }}>{t('recallEmptyDesc')}</div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} className="kb-scroll">
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: C.muted, paddingBottom: 8, borderBottom: `1px solid ${C.border}`, marginBottom: 8 }}>
            <span>✨ {props.hits.length} {t('recallResultsSuffix')}</span>
            <span>⏱ {props.searchMeta.elapsedMs}ms</span>
            <span>{t('recallTopScore')}: {Math.round(topScore * 100)}%</span>
          </div>
          {props.hits.map((hit, index) => (
            <RecallResultCard key={hit.chunkId} hit={hit} index={index} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function RecallResultCard(props: { hit: SearchHit; index: number; t: Translate }): JSX.Element {
  const { hit, index, t } = props
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      // Copy a full Markdown citation (quote + source) so the excerpt can be
      // pasted into the conversation with its traceable source line.
      await navigator.clipboard.writeText(citationMarkdown(hit))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable — ignore
    }
  }
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 6, background: C.surface2, color: C.muted, fontSize: 12, flexShrink: 0 }}>{index + 1}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
          <IconBook size={13} color={C.muted} />
          <span style={{ fontSize: 12, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hit.documentTitle}</span>
          <span style={{ fontSize: 12, color: C.muted, flexShrink: 0 }}>#{hit.index + 1}</span>
        </span>
        <span style={{ fontSize: 12, color: C.muted, width: 96, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{t('recallRelevance')} {Math.round(hit.score * 100)}%</span>
        <button style={{ ...style.iconOnlyButton, width: 20, height: 20 }} aria-label={t('recallCopy')} onClick={() => void copy()}>
          {copied ? <IconCheck size={12} color={C.success} /> : '⧉'}
        </button>
        <button style={{ ...style.iconOnlyButton, width: 20, height: 20 }} aria-label={t(expanded ? 'recallCollapse' : 'recallExpand')} onClick={() => setExpanded(v => !v)}>
          {expanded ? '▴' : '▾'}
        </button>
      </div>
      <div style={{ padding: '0 10px 10px' }}>
        <p style={{
          margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}>{hit.text}</p>
      </div>
    </div>
  )
}

function SidePanel(props: { title: string; onClose: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div style={style.sidePanelScrim} onClick={props.onClose}>
      <div style={style.sidePanel} onClick={(e) => e.stopPropagation()}>
        <div style={style.sidePanelHeader}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{props.title}</span>
          <button className="kb-row" style={style.closeButton} onClick={props.onClose} aria-label="close">✕</button>
        </div>
        <div style={style.sidePanelBody} className="kb-scroll">{props.children}</div>
      </div>
    </div>
  )
}

function StatChip(props: { value: string | number; label: string }): JSX.Element {
  return (
    <span style={style.statChip}>
      <span style={style.statValue}>{props.value}</span>
      <span style={style.statLabel}>{props.label}</span>
    </span>
  )
}

/** Master on/off switch plus per-base scope, mirroring Cherry's composer KB toggle. */
function KnowledgeToggle(props: {
  enabled: boolean
  enabledBaseIds: string[]
  bases: BaseSummary[]
  t: Translate
  onChange: (enabled: boolean, ids: string[]) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggleBase = (id: string): void => {
    let ids: string[]
    if (props.enabledBaseIds.length === 0) {
      ids = props.bases.map(b => b.id).filter(x => x !== id)
    } else if (props.enabledBaseIds.includes(id)) {
      ids = props.enabledBaseIds.filter(x => x !== id)
    } else {
      ids = [...props.enabledBaseIds, id]
    }
    props.onChange(props.enabled, ids)
  }

  const allChecked = props.enabledBaseIds.length === 0
  const baseChecked = (id: string): boolean => allChecked || props.enabledBaseIds.includes(id)

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        className="kb-row"
        onClick={() => props.onChange(!props.enabled, props.enabledBaseIds)}
        title={props.enabled ? props.t('kbOff') : props.t('kbOn')}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
          color: props.enabled ? C.success : C.muted,
          border: `1px solid ${props.enabled ? C.success : C.border}`, borderRadius: 999,
          padding: '3px 10px', background: props.enabled ? 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #30a46c) 12%, transparent)' : 'transparent',
          cursor: 'pointer',
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 999, background: props.enabled ? C.success : C.muted }} />
        {props.t('kbInvocation')} {props.enabled ? props.t('kbOn') : props.t('kbOff')}
      </button>
      {props.enabled && (
        <button
          className="kb-row"
          onClick={() => setOpen(v => !v)}
          style={{
            fontSize: 11, color: C.muted, border: `1px solid ${C.border}`, borderRadius: 999,
            padding: '3px 8px', background: 'transparent', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {allChecked ? props.t('kbAll') : `${props.enabledBaseIds.length} ${props.t('kbInvocation')}`} ▾
        </button>
      )}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 300, minWidth: 220, maxHeight: 280,
          overflowY: 'auto', background: C.overlay, border: `1px solid ${C.border}`, borderRadius: 10,
          boxShadow: '0 10px 32px rgba(0,0,0,0.18)', padding: 6,
        }}>
          <div style={{ fontSize: 11, color: C.muted, padding: '4px 8px' }}>{props.t('kbScopeHint')}</div>
          <label className="kb-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={allChecked} onChange={() => props.onChange(props.enabled, [])} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{props.t('kbAll')}</span>
          </label>
          {props.bases.map(base => (
            <label key={base.id} className="kb-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={baseChecked(base.id)} onChange={() => toggleBase(base.id)} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{base.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function Checkbox(props: {
  checked: boolean
  indeterminate?: boolean
  onChange: (next: boolean) => void
  ariaLabel?: string
}): JSX.Element {
  const active = props.checked || props.indeterminate === true
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.indeterminate === true ? 'mixed' : props.checked}
      aria-label={props.ariaLabel}
      style={{ ...style.checkbox, ...(active ? style.checkboxOn : {}) }}
      onClick={(e) => { e.stopPropagation(); props.onChange(!props.checked) }}
    >
      {props.indeterminate === true ? '–' : props.checked ? <IconCheck size={10} /> : null}
    </button>
  )
}

function DocumentDetailPanel(props: {
  doc: DocumentSummary
  rawText: string | null
  rawTextTruncated: boolean
  chunks: ChunkView[]
  t: Translate
  initialMode: 'preview' | 'chunks'
  onBack: () => void
  onLoadMoreChunks: () => void
}): JSX.Element {
  const { doc, t } = props
  const [mode, setMode] = useState<'preview' | 'chunks'>(props.initialMode)
  const visual = doc.sourceType === 'url'
    ? { color: '#10b981', icon: fileVisual('page').icon }
    : fileVisual(doc.fileName ?? 'text.txt')
  const DocIcon = visual.icon
  const chunksTruncated = props.chunks.length < doc.chunkCount
  // PDF rows preview through an embedded viewer (Cherry's in-panel file
  // preview): the raw bytes are fetched and served to the browser's native
  // PDF viewer via a blob URL. Fetching the bytes (instead of pointing the
  // iframe at the raw route) sidesteps Content-Disposition entirely — a
  // stale host would otherwise make the iframe download instead of display.
  const isPdfPreview = doc.sourceType === 'file' && (doc.fileName ?? '').toLowerCase().endsWith('.pdf')
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [pdfPreviewError, setPdfPreviewError] = useState<string | null>(null)
  useEffect(() => {
    if (!isPdfPreview || mode !== 'preview') return
    let disposed = false
    let objectUrl: string | null = null
    setPdfUrl(null)
    setPdfPreviewError(null)
    void fetch(`/knowledge/documents/${doc.id}/raw`, { signal: AbortSignal.timeout(30_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const blob = await response.blob()
        // Cherry caps the in-panel viewer at 100 MB and falls back to the
        // system app; here the fallback is a download of the same bytes.
        if (blob.size > PDF_PREVIEW_MAX_BYTES) {
          setPdfPreviewError(t('pdfTooLarge'))
          return
        }
        if (disposed) return
        objectUrl = URL.createObjectURL(blob)
        setPdfUrl(objectUrl)
      })
      .catch((error: unknown) => {
        if (!disposed) setPdfPreviewError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      disposed = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [doc.id, isPdfPreview, mode, t])
  const tabStyle = (active: boolean): CSSProperties => ({
    border: 'none',
    background: active ? accentSoftText() : 'transparent',
    color: active ? C.accent : C.muted,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 6,
  })
  return (
    <div style={style.card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <button className="kb-row" style={style.button} onClick={props.onBack}>← {t('back')}</button>
        <span style={docIconStyle(visual.color)}><DocIcon size={16} color={visual.color} /></span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ ...style.docTitle, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {doc.title}
          </span>
          <span style={style.docMeta}>{doc.chunkCount}{t('chunkCount')} · {formatSize(doc.charCount)}</span>
        </span>
        <span style={{ display: 'flex', gap: 2, background: C.surface2, borderRadius: 8, padding: 2, flexShrink: 0 }}>
          <button className="kb-row" style={tabStyle(mode === 'preview')} onClick={() => setMode('preview')}>{t('preview')}</button>
          <button className="kb-row" style={tabStyle(mode === 'chunks')} onClick={() => setMode('chunks')}>{t('chunks')} ({doc.chunkCount})</button>
        </span>
      </div>

      <div className="kb-scroll" style={{ maxHeight: 'calc(100vh - 250px)', overflowY: 'auto' }}>
        {mode === 'preview' ? (
          isPdfPreview ? (
            pdfPreviewError !== null ? (
              <div style={style.empty}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.danger, marginBottom: 6 }}>{t('pdfPreviewFailed')}</div>
                <div style={{ fontSize: 12, color: C.muted, wordBreak: 'break-all' }}>{pdfPreviewError}</div>
              </div>
            ) : pdfUrl === null ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 320 }}>
                <span className="kb-spinner" style={{ ...style.spinner, width: 22, height: 22, borderWidth: 3 }} />
              </div>
            ) : (
              <iframe
                src={pdfUrl}
                title={doc.title}
                style={{
                  width: '100%',
                  height: 'calc(100vh - 320px)',
                  minHeight: 420,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  background: '#fff',
                }}
              />
            )
          ) : (
          <>
            {props.rawTextTruncated && (
              <div style={{ ...style.warningHint, marginBottom: 8 }}>
                {t('previewTruncated').replace('{count}', String(PREVIEW_RAW_TEXT_LIMIT))}
              </div>
            )}
            {props.rawText === null || props.rawText === '' ? (
              <div style={style.empty}>{t('noDocsHint')}</div>
            ) : (
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0, color: C.text, lineHeight: 1.6, wordBreak: 'break-word', fontFamily: 'inherit' }}>{props.rawText}</pre>
            )}
          </>
          )
        ) : (
          <>
            {chunksTruncated && (
              <div style={{ ...style.warningHint, marginBottom: 8 }}>
                {t('chunksTruncated').replace('{loaded}', String(props.chunks.length)).replace('{total}', String(doc.chunkCount))}
              </div>
            )}
            {props.chunks.length === 0 ? (
              <div style={style.empty}>{t('lexicalOnly')}</div>
            ) : (
              props.chunks.map(chunk => (
                <div key={chunk.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8, background: C.surface }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 20, height: 20, padding: '0 6px', borderRadius: 5, background: C.accent, color: '#fff', fontSize: 11, fontWeight: 600 }}>{chunk.index + 1}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chunk.heading !== undefined ? chunk.heading : ''}
                    </span>
                    <span style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>{estimateTokens(chunk.text)} tokens</span>
                  </div>
                  <p style={{
                    margin: 0, padding: '8px 10px', fontSize: 13, color: C.muted, lineHeight: 1.6,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>{chunk.text}</p>
                </div>
              ))
            )}
            {chunksTruncated && props.chunks.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 10px' }}>
                <button className="kb-row" style={style.button} onClick={props.onLoadMoreChunks}>
                  {t('loadMoreChunks')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function scoreColor(score: number, palette: typeof C): string {
  if (score >= 0.7) return palette.success
  if (score >= 0.4) return palette.warn
  return palette.muted
}

/** Markdown citation block for one search hit: quote + source line. */
function citationMarkdown(hit: SearchHit): string {
  const quote = hit.text.split('\n').map(line => `> ${line}`).join('\n')
  const source = hit.heading !== undefined && hit.heading.length > 0
    ? `${hit.documentTitle} / ${hit.heading}`
    : hit.documentTitle
  return `${quote}\n>\n> — ${source}（知识库 ${hit.baseId}）`
}

function highlightMatches(text: string, query: string, markStyle: CSSProperties): JSX.Element {
  const terms = query.split(/\s+/).filter(term => term.length > 0)
  if (terms.length === 0) return <>{text}</>
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const parts = text.split(pattern)
  return (
    <>
      {parts.map((part, index) =>
        terms.some(term => part.toLowerCase() === term.toLowerCase())
          ? <mark key={index} style={markStyle}>{part}</mark>
          : <span key={index}>{part}</span>)}
    </>
  )
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract a window around the first query-term match so recall hits show the
 * relevant passage instead of the whole (potentially long) chunk.
 */
function snippetAroundMatch(text: string, query: string, radius = 90): string {
  const terms = query.split(/\s+/).filter(term => term.length > 0)
  if (terms.length === 0) return text
  let firstIndex = -1
  for (const term of terms) {
    const index = text.toLowerCase().indexOf(term.toLowerCase())
    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) firstIndex = index
  }
  if (firstIndex === -1) {
    return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text
  }
  const start = Math.max(0, firstIndex - radius)
  const end = Math.min(text.length, firstIndex + radius * 2)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Rough token estimate matching the host's heuristic (CJK ≈ 1.5 chars, latin ≈ 4). */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  const latin = text.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}
