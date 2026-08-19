/**
 * Cherry Studio-style Local Models settings section: model cards with
 * download / retry / remove actions and a live progress bar, mirroring
 * `LocalModelsSection` + `ModelCard`. The settings shell supplies only the
 * `close` owner prop; data and actions arrive through the inject face.
 * @module dsh-knowledge/client/LocalModelsSection
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { KnowledgeApi } from './api.js'
import type { LocalModelSummary } from './api.js'
import { C, style } from './theme.js'
import { IconBot, IconBox, IconDownload, IconFolderInput, IconFolderOpen, IconFolderSearch, IconRefresh, IconScanText, IconTrash, IconX } from './icons.js'
import type { Translate } from './locales.js'

export interface LocalModelsSectionProps {
  close: () => void
  api: KnowledgeApi
  t: Translate
  /** DSH's native directory picker + path opener (optional; absent in tests). */
  workspaces?: {
    pickDirectory(): Promise<string | null>
    openPath(path: string): Promise<void>
  }
}

export function LocalModelsSection(props: LocalModelsSectionProps): JSX.Element {
  const { api, t } = props
  const [models, setModels] = useState<LocalModelSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [mirror, setMirror] = useState('')
  const [mirrorLoaded, setMirrorLoaded] = useState(false)
  const [cacheDir, setCacheDir] = useState('')
  const [ocrStatus, setOcrStatus] = useState<{ status: string; progress: number; message: string }>({ status: 'idle', progress: 0, message: '' })
  const [ocrBusy, setOcrBusy] = useState(false)
  // Ollama: base URL + model picker + pull progress.
  const [ollamaBase, setOllamaBase] = useState('http://127.0.0.1:11434')
  const [ollamaModel, setOllamaModel] = useState('')
  const [ollamaInstalled, setOllamaInstalled] = useState<string[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<{ status: string; progress: number; message: string }>({ status: 'idle', progress: 0, message: '' })
  const [ollamaBusy, setOllamaBusy] = useState(false)
  // Recommended Ollama models (embedding + vision), mirroring the local-model registry posture.
  const [ollamaSuggestions, setOllamaSuggestions] = useState<{ ollamaEmbedding: string[]; ollamaVision: string[] }>({ ollamaEmbedding: [], ollamaVision: [] })

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [next, ocr] = await Promise.all([api.listLocalModels(), api.getOcrStatus()])
      setModels(next)
      setOcrStatus(ocr)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 1000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // Live Ollama pull progress (polled only while pulling).
  useEffect(() => {
    if (ollamaModel === '' || ollamaStatus.status !== 'pulling') return
    const timer = window.setInterval(() => {
      void api.getOllamaPullStatus(ollamaModel).then(setOllamaStatus).catch(() => {})
    }, 1000)
    return () => window.clearInterval(timer)
  }, [api, ollamaModel, ollamaStatus.status])

  // Load the current mirror + cache-dir settings once.
  useEffect(() => {
    void api.getConfig().then(config => {
      setMirror(config.hfEndpoint)
      setCacheDir(config.localModelCacheDir)
      setMirrorLoaded(true)
    }).catch(() => { setMirrorLoaded(true) })
  }, [api])

  // Load the Ollama recommendations once.
  useEffect(() => {
    void api.getModelSuggestions().then(suggestions => {
      setOllamaSuggestions({
        ollamaEmbedding: suggestions.ollamaEmbedding ?? [],
        ollamaVision: suggestions.ollamaVision ?? [],
      })
    }).catch(() => {})
  }, [api])

  const saveMirror = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      await api.setConfig({ hfEndpoint: mirror.trim() })
      setMirror(mirror.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api, mirror])

  const saveCacheDir = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      await api.setConfig({ localModelCacheDir: cacheDir.trim() })
      setCacheDir(cacheDir.trim())
      // Saving only points the config at the new directory; the files stay
      // where they are. Say so explicitly — a silent save read as "no
      // reaction" and left users believing the models had moved.
      setError(t('cacheDirSaved'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api, cacheDir, t])

  const browseCacheDir = useCallback(async (): Promise<void> => {
    setError(null)
    if (props.workspaces === undefined) {
      setError('文件夹选择不可用（当前环境无目录选择能力）')
      return
    }
    try {
      const picked = await props.workspaces.pickDirectory()
      if (picked !== null) setCacheDir(picked)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [props.workspaces])

  const openCacheDir = useCallback(async (): Promise<void> => {
    setError(null)
    if (props.workspaces === undefined) return
    try {
      await props.workspaces.openPath(cacheDir.trim() === '' ? '~' : cacheDir.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [props.workspaces, cacheDir])

  const [migrating, setMigrating] = useState(false)
  const migrateCacheDir = useCallback(async (): Promise<void> => {
    setMigrating(true)
    setError(null)
    try {
      const result = await api.migrateLocalModels(cacheDir.trim())
      setCacheDir(result.to)
      setError(null)
      if (result.moved > 0) {
        setError(`${result.moved} 个模型目录已迁移到 ${result.to}`)
      } else {
        // Also silent before: a no-op migration (same dir, or the target
        // already holds the entries) showed nothing at all.
        setError(t('cacheDirMigrateNone'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMigrating(false)
    }
  }, [api, cacheDir, t])

  const refreshOllamaTags = useCallback(async (): Promise<void> => {
    setOllamaBusy(true)
    setError(null)
    try {
      const { models: installed } = await api.listOllamaModels(ollamaBase)
      setOllamaInstalled(installed)
    } catch (err) {
      setError(`${err instanceof Error ? err.message : String(err)} ${t('ollamaNeedInstall')}`)
    } finally {
      setOllamaBusy(false)
    }
  }, [api, ollamaBase, t])

  // Two-step delete: the first click arms the chip, the second executes.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const deleteOllama = useCallback(async (model: string): Promise<void> => {
    if (pendingDelete !== model) {
      setPendingDelete(model)
      window.setTimeout(() => setPendingDelete(current => (current === model ? null : current)), 3000)
      return
    }
    setPendingDelete(null)
    setOllamaBusy(true)
    setError(null)
    try {
      await api.deleteOllamaModel(model, ollamaBase)
      const { models: installed } = await api.listOllamaModels(ollamaBase)
      setOllamaInstalled(installed)
    } catch (err) {
      setError(`${err instanceof Error ? err.message : String(err)} ${t('ollamaNeedInstall')}`)
    } finally {
      setOllamaBusy(false)
    }
  }, [api, ollamaBase, pendingDelete, t])

  const pullOllama = useCallback(async (): Promise<void> => {
    const model = ollamaModel.trim()
    if (model === '') return
    setOllamaBusy(true)
    setError(null)
    try {
      await api.pullOllamaModel(model, ollamaBase)
      setOllamaStatus({ status: 'pulling', progress: 0, message: '' })
    } catch (err) {
      setError(`${err instanceof Error ? err.message : String(err)} ${t('ollamaNeedInstall')}`)
      setOllamaBusy(false)
    }
  }, [api, ollamaModel, ollamaBase, t])

  const cancelOllama = useCallback(async (): Promise<void> => {
    const model = ollamaModel.trim()
    if (model === '') return
    try {
      await api.cancelOllamaPull(model)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setOllamaStatus({ status: 'idle', progress: 0, message: '' })
    setOllamaBusy(false)
  }, [api, ollamaModel])

  const download = useCallback(async (id: string): Promise<void> => {
    setBusyId(id)
    setError(null)
    try {
      await api.downloadLocalModel(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
      void refresh()
    }
  }, [api, refresh])

  const cancel = useCallback(async (id: string): Promise<void> => {
    setError(null)
    try {
      await api.cancelLocalModel(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      void refresh()
    }
  }, [api, refresh])

  const remove = useCallback(async (id: string): Promise<void> => {
    setBusyId(id)
    setError(null)
    try {
      await api.removeLocalModel(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }, [api, refresh])

  const downloadOcr = useCallback(async (): Promise<void> => {
    setOcrBusy(true)
    setError(null)
    try {
      await api.downloadOcr()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOcrBusy(false)
    }
  }, [api, refresh])

  const removeOcr = useCallback(async (): Promise<void> => {
    setOcrBusy(true)
    setError(null)
    try {
      await api.removeOcr()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOcrBusy(false)
    }
  }, [api, refresh])

  const ocrReady = ocrStatus.status === 'ready'

  return (
    <div style={{ minWidth: 0 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{t('localModelsTitle')}</h2>
      <p style={{ marginTop: 4, marginBottom: 12, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>{t('localModelsDesc')}</p>

      {mirrorLoaded && (
        <div style={{ marginBottom: 14, padding: 12, border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{t('hfMirror')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={style.input}
              placeholder="https://hf-mirror.com"
              value={mirror}
              onChange={(e) => setMirror(e.target.value)}
            />
            <button style={style.button} onClick={() => void saveMirror()}>{t('hfMirrorSave')}</button>
          </div>
          <p style={{ marginTop: 6, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>{t('hfMirrorHint')}</p>
        </div>
      )}

      {mirrorLoaded && (
        <div style={{ marginBottom: 14, padding: 12, border: `1px solid ${C.border}`, borderRadius: 12, background: C.surface }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{t('cacheDirTitle')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ ...style.input, flex: 1 }}
              placeholder="C:\\Users\\you\\.dsh\\cache\\dsh-knowledge\\local-models"
              value={cacheDir}
              onChange={(e) => setCacheDir(e.target.value)}
            />
            <button style={style.button} onClick={() => void browseCacheDir()}><IconFolderSearch size={13} /> {t('cacheDirBrowse')}</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button style={style.button} onClick={() => void saveCacheDir()}>{t('hfMirrorSave')}</button>
            <button style={style.button} disabled={migrating} onClick={() => void migrateCacheDir()}>
              <IconFolderInput size={13} /> {t('cacheDirMigrate')}
            </button>
            <button style={style.button} onClick={() => void openCacheDir()}><IconFolderOpen size={13} /> {t('cacheDirOpen')}</button>
          </div>
          <p style={{ marginTop: 6, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>{t('cacheDirHint')}</p>
        </div>
      )}

      {error !== null && <div style={{ ...style.error, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
        {(models ?? []).map(model => (
          <ModelCard
            key={model.id}
            model={model}
            t={t}
            busy={busyId === model.id}
            onDownload={() => void download(model.id)}
            onCancel={() => void cancel(model.id)}
            onRemove={() => void remove(model.id)}
          />
        ))}
        {models !== null && models.length === 0 && (
          <div style={style.empty}>{t('noLocalModels')}</div>
        )}
      </div>

      {/* Local OCR — scanned PDFs (Cherry's local-document posture) */}
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40,
              borderRadius: 12, flexShrink: 0, background: ocrReady ? accentSoft : C.surface2,
              color: ocrReady ? C.accent : C.muted,
            }}
          >
            <IconScanText size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('ocrTitle')}</span>
              {ocrReady && <span style={readyBadge}>{t('ready')}</span>}
            </div>
            <p style={{ marginTop: 2, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>{t('ocrDesc')}</p>
          </div>
          {ocrReady && (
            <button
              className="kb-dangerbtn"
              style={style.iconOnlyButton}
              title={t('ocrRemove')}
              aria-label={t('ocrRemove')}
              disabled={ocrBusy}
              onClick={() => void removeOcr()}
            >
              <IconTrash size={14} />
            </button>
          )}
        </div>

        {ocrStatus.status === 'error' && ocrStatus.message !== '' && (
          <p style={{ marginTop: 8, fontSize: 12, color: C.danger, lineHeight: 1.5 }}>{ocrStatus.message}</p>
        )}

        {ocrStatus.status === 'downloading' && (
          <div style={{ marginTop: 12 }}>
            <div style={{ height: 6, width: '100%', borderRadius: 999, background: C.surface2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${ocrStatus.progress}%`, borderRadius: 999, background: C.accent, transition: 'width 0.2s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: C.muted }}>
              <span>{t('localModelDownloading')}</span>
              <span>{Math.floor(ocrStatus.progress)}%</span>
            </div>
          </div>
        )}

        {!ocrReady && ocrStatus.status !== 'downloading' && (
          <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
            <button
              style={{ ...style.button, width: '100%', justifyContent: 'center' }}
              disabled={ocrBusy}
              onClick={() => void downloadOcr()}
            >
              {ocrStatus.status === 'error' ? <IconRefresh size={13} /> : <IconDownload size={13} />}
              {ocrStatus.status === 'error' ? t('localModelRetry') : t('ocrDownload')}
            </button>
          </div>
        )}
      </div>

      {/* Ollama — pull local models through the Ollama API (embeddings, VLMs) */}
      <div style={{ ...cardStyle, marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: C.surface2, color: C.muted }}>
            <IconBot size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{t('ollamaTitle')}</div>
            <p style={{ marginTop: 2, fontSize: 12, color: C.muted, lineHeight: 1.5 }}>{t('ollamaDesc')}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            style={{ ...style.input, flex: 1 }}
            placeholder="http://127.0.0.1:11434"
            value={ollamaBase}
            onChange={(e) => setOllamaBase(e.target.value)}
          />
          <button style={style.button} disabled={ollamaBusy} onClick={() => void refreshOllamaTags()}>
            <IconRefresh size={13} />{t('ollamaRefresh')}
          </button>
        </div>
        {ollamaInstalled.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {ollamaInstalled.map(name => (
              <span
                key={name}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 6px 3px 8px', borderRadius: 999, border: `1px solid ${C.border}`, background: C.surface2, color: C.text }}
              >
                <button style={{ border: 0, padding: 0, background: 'transparent', color: C.text, cursor: 'pointer', fontSize: 11 }} onClick={() => setOllamaModel(name)}>
                  {name}
                </button>
                <button
                  style={{ border: 0, padding: '0 2px', background: 'transparent', color: pendingDelete === name ? C.danger : C.muted, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                  title={t('ollamaDelete')}
                  aria-label={t('ollamaDelete')}
                  disabled={ollamaBusy}
                  onClick={() => void deleteOllama(name)}
                >
                  {pendingDelete === name ? t('ollamaConfirmDelete') : '×'}
                </button>
              </span>
            ))}
          </div>
        )}
        {(ollamaSuggestions.ollamaEmbedding.length > 0 || ollamaSuggestions.ollamaVision.length > 0) && (
          <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{t('ollamaRecommended')}</div>
            {ollamaSuggestions.ollamaEmbedding.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {ollamaSuggestions.ollamaEmbedding.map(name => (
                  <button
                    key={name}
                    title={t('ollamaEmbeddingHint')}
                    style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, border: `1px solid ${C.border}`, background: 'transparent', color: C.text, cursor: 'pointer' }}
                    onClick={() => setOllamaModel(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
            {ollamaSuggestions.ollamaVision.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ollamaSuggestions.ollamaVision.map(name => (
                  <button
                    key={name}
                    title={t('ollamaVisionHint')}
                    style={{ fontSize: 11, padding: '3px 8px', borderRadius: 999, border: `1px solid ${C.border}`, background: 'transparent', color: C.text, cursor: 'pointer' }}
                    onClick={() => setOllamaModel(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            style={{ ...style.input, flex: 1 }}
            placeholder="llava / qwen2.5vl / nomic-embed-text …"
            value={ollamaModel}
            onChange={(e) => setOllamaModel(e.target.value)}
          />
          <button
            style={style.button}
            disabled={ollamaBusy || ollamaModel.trim() === '' || ollamaStatus.status === 'pulling'}
            onClick={() => void pullOllama()}
          >
            <IconDownload size={13} />{t('ollamaPull')}
          </button>
        </div>
        {ollamaStatus.status === 'pulling' && (
          <div style={{ marginTop: 12 }}>
            <div style={{ height: 6, width: '100%', borderRadius: 999, background: C.surface2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${ollamaStatus.progress}%`, borderRadius: 999, background: C.accent, transition: 'width 0.2s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, fontSize: 12, color: C.muted }}>
              <span>{t('localModelDownloading')}{ollamaStatus.message !== '' ? ` · ${ollamaStatus.message}` : ''}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{Math.floor(ollamaStatus.progress)}%</span>
                <button style={{ border: 0, padding: '2px 6px', borderRadius: 6, background: C.surface2, color: C.text, cursor: 'pointer', fontSize: 11 }} onClick={() => void cancelOllama()}>
                  {t('localModelCancel')}
                </button>
              </span>
            </div>
          </div>
        )}
        {ollamaStatus.status === 'error' && ollamaStatus.message !== '' && (
          <p style={{ marginTop: 8, fontSize: 12, color: C.danger, lineHeight: 1.5 }}>{ollamaStatus.message}</p>
        )}
      </div>
    </div>
  )
}

function ModelCard(props: {
  model: LocalModelSummary
  t: Translate
  busy: boolean
  onDownload: () => void
  onCancel: () => void
  onRemove: () => void
}): JSX.Element {
  const { model, t, busy, onDownload, onCancel, onRemove } = props
  const ready = model.status === 'ready'
  const downloading = model.status === 'downloading'
  const failed = model.status === 'error'

  return (
    <div style={{ ...cardStyle, ...(ready ? {} : {}) }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40,
            borderRadius: 12, flexShrink: 0,
            background: ready ? accentSoft : C.surface2,
            color: ready ? C.accent : C.muted,
          }}
        >
          <IconBox size={20} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {model.name}
            </span>
            {ready && (
              <span style={readyBadge}>{t('ready')}</span>
            )}
          </div>
          <p style={{ marginTop: 2, fontSize: 12, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {model.subtitle}
          </p>
        </div>
        {ready && (
          <button
            className="kb-dangerbtn"
            style={style.iconOnlyButton}
            title={t('localModelRemove')}
            aria-label={t('localModelRemove')}
            disabled={busy}
            onClick={onRemove}
          >
            <IconTrash size={14} />
          </button>
        )}
      </div>

      {failed && (
        <p style={{ marginTop: 8, fontSize: 12, color: C.danger, lineHeight: 1.5 }}>
          {model.message !== '' ? model.message : t('localModelError')}
        </p>
      )}

      {downloading && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 6, width: '100%', borderRadius: 999, background: C.surface2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${model.progress}%`, borderRadius: 999, background: C.accent, transition: 'width 0.2s' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: C.muted }}>
            <span>{t('localModelDownloading')}</span>
            <span>{Math.floor(model.progress)}%</span>
          </div>
          <div style={{ marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
            <button
              style={{ ...style.button, width: '100%', justifyContent: 'center' }}
              disabled={busy}
              onClick={onCancel}
            >
              <IconX size={13} />{t('localModelCancel')}
            </button>
          </div>
        </div>
      )}

      {!ready && !downloading && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
          <button
            style={{ ...style.button, width: '100%', justifyContent: 'center' }}
            disabled={busy}
            onClick={onDownload}
          >
            {failed ? <IconRefresh size={13} /> : <IconDownload size={13} />}
            {failed ? t('localModelRetry') : t('localModelDownload')}
          </button>
        </div>
      )}
    </div>
  )
}

const cardStyle: CSSProperties = {
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: 16,
  background: C.surface,
}

const accentSoft = 'color-mix(in srgb, var(--dsw-alias-brand-primary, #3b6ef6) 10%, transparent)'

const readyBadge: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.5,
  padding: '0 6px',
  borderRadius: 999,
  background: C.surface2,
  color: C.muted,
  flexShrink: 0,
}
