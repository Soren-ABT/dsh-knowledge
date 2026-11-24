import { useEffect, useState } from 'react'
import type { BaseSourceInfo, DirectoryScanProgress, DirectoryScanSnapshot, KnowledgeApi } from './api.js'
import type { Translate } from './locales.js'
import { C, style } from './theme.js'

export function DirectorySyncControls({ source, busy, scanning, t, onScan, onBind, onInterval }: {
  source: BaseSourceInfo; busy: boolean; scanning: boolean; t: Translate
  onScan: () => void; onBind: () => void; onInterval: (minutes: number) => void
}): JSX.Element {
  const bound = source.sourcePath !== undefined
  const last = source.lastDirectorySync
  return (
    <span style={{ display: 'inline-flex', flex: '1 1 100%', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <button type="button" style={style.button} disabled={busy || scanning || !bound} onClick={onScan}>{t('directoryRescan')}</button>
      <button type="button" style={style.button} disabled={busy} onClick={onBind}>{t(bound ? 'sourcePathEdit' : 'directoryBind')}</button>
      {bound ? (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {t('directorySyncInterval')}
          <select style={{ ...style.input, width: 'auto' }} aria-label={`${t('directorySyncInterval')}: ${source.text}`}
            disabled={busy} value={source.syncIntervalMinutes ?? 0} onChange={event => onInterval(Number(event.target.value))}>
            <option value={0}>{t('directorySyncManual')}</option>
            {[5, 15, 60].map(minutes => <option key={minutes} value={minutes}>{minutes} {t('directorySyncMinutes')}</option>)}
          </select>
        </label>
      ) : <span style={{ fontSize: 12, color: C.muted }}>{t('directoryUnboundHint')}</span>}
      {last !== undefined && (
        <span role="status" style={{ flexBasis: '100%', fontSize: 12, overflowWrap: 'anywhere', color: last.failed > 0 ? C.danger : C.muted }} title={last.error}>
          {t('directoryLastSync')} {new Date(last.finishedAt).toLocaleString()} · {t('syncCreated')} {last.created} · {t('syncUpdated')} {last.updated} · {t('syncDeleted')} {last.deleted} · {t('syncUnchanged')} {last.unchanged} · {t('syncFailed')} {last.failed}
          {last.error !== undefined ? ` · ${last.error}` : ''}
        </span>
      )}
    </span>
  )
}

export function DirectoryScanStatus({ initial, api, t, onFinish }: {
  initial: DirectoryScanProgress
  api: KnowledgeApi
  t: Translate
  onFinish: (scan: DirectoryScanProgress, snapshot: DirectoryScanSnapshot) => void
}): JSX.Element {
  const [progress, setProgress] = useState(initial)
  const [reconnecting, setReconnecting] = useState(false)
  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      let delay = 800
      try {
        const snapshot = await api.getDirectoryRescan(initial.sourceId)
        if (disposed) return
        if (snapshot.active?.runId !== initial.runId) {
          onFinish(initial, snapshot)
          return
        }
        setProgress(snapshot.active)
        setReconnecting(false)
      } catch {
        if (disposed) return
        setReconnecting(true)
        delay = 2000
      }
      timer = window.setTimeout(() => { void poll() }, delay)
    }
    void poll()
    return () => { disposed = true; window.clearTimeout(timer) }
  }, [api, initial, onFinish])
  return (
    <div role="status" style={{ fontSize: 12, color: C.muted, overflowWrap: 'anywhere' }}>
      {progress.title} · {t('directoryScanProgress')} {progress.processed}
      {progress.lastPath ? ` · ${progress.lastPath}` : ''}
      {reconnecting ? ` · ${t('directoryScanReconnecting')}` : ''}
    </div>
  )
}
