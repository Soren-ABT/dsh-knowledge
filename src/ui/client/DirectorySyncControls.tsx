import type { BaseSourceInfo } from './api.js'
import type { Translate } from './locales.js'
import { C, style } from './theme.js'

export function DirectorySyncControls({ source, busy, t, onScan, onBind, onInterval }: {
  source: BaseSourceInfo; busy: boolean; t: Translate
  onScan: () => void; onBind: () => void; onInterval: (minutes: number) => void
}): JSX.Element {
  const bound = source.sourcePath !== undefined
  const last = source.lastDirectorySync
  return (
    <span style={{ display: 'inline-flex', flex: '1 1 100%', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <button type="button" style={style.button} disabled={busy || !bound} onClick={onScan}>{t('directoryRescan')}</button>
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
