import type { LocalModelStatus } from './api.js'
import type { Translate } from './locales.js'
import { C } from './theme.js'

/** Residency is separate from the model's download and validation badges. */
export function ModelRuntimeStatus({ model, t }: { model: Pick<LocalModelStatus, 'runtimeState' | 'loadStartedAt' | 'loadDurationMs' | 'message'>; t: Translate }): JSX.Element {
  const state = model.runtimeState ?? 'unloaded'
  const labels = { unloaded: 'modelRuntimeUnloaded', loading: 'modelRuntimeLoading', loaded: 'modelRuntimeLoaded', error: 'modelRuntimeError' } as const
  const duration = state === 'loading' && model.loadStartedAt !== undefined
    ? Math.max(0, Date.now() - model.loadStartedAt) : state === 'loaded' ? model.loadDurationMs : undefined
  return (
    <span role="status" title={state === 'error' ? model.message : undefined} style={{ color: state === 'error' ? C.danger : state === 'loaded' ? C.success : C.muted, fontSize: 12 }}>
      {t(labels[state])}{duration !== undefined ? ` · ${(duration / 1000).toFixed(1)}s` : ''}
    </span>
  )
}
