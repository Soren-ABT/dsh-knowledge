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
import { IconBox, IconDownload, IconRefresh, IconTrash, IconX } from './icons.js'
import type { Translate } from './locales.js'

export interface LocalModelsSectionProps {
  close: () => void
  api: KnowledgeApi
  t: Translate
}

export function LocalModelsSection(props: LocalModelsSectionProps): JSX.Element {
  const { api, t } = props
  const [models, setModels] = useState<LocalModelSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.listLocalModels()
      setModels(next)
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

  return (
    <div style={{ minWidth: 0 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{t('localModelsTitle')}</h2>
      <p style={{ marginTop: 4, marginBottom: 12, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>{t('localModelsDesc')}</p>

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
