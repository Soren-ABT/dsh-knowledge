import { useEffect, useId, useRef, useState } from 'react'
import type { KnowledgeApi, MineruDeploymentPlan, MineruDeploymentStatus, MineruPythonDiscovery } from './api.js'
import type { Translate, KnowledgeKey } from './locales.js'
import { C, accentSoft, style } from './theme.js'

const DRAFT_KEY = 'dsh-knowledge:mineru-deployment-draft:v1'
const DEFAULT_PYTHON_INDEX = 'https://pypi.org/simple'
type Draft = { root?: string; existing?: string; python?: string; manualPython?: string }
function readDraft(): Draft {
  if (typeof window === 'undefined') return {}
  try {
    const value = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? '{}')
    return value && typeof value === 'object' ? {
      root: typeof value.root === 'string' ? value.root.slice(0, 4096) : undefined,
      existing: typeof value.existing === 'string' ? value.existing.slice(0, 4096) : undefined,
      python: typeof value.python === 'string' ? value.python.slice(0, 4096) : undefined,
      manualPython: typeof value.manualPython === 'string' ? value.manualPython.slice(0, 4096) : undefined,
    } : {}
  } catch { return {} }
}
function saveDraft(draft: Draft): void {
  try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { /* Storage may be disabled; the current form remains usable. */ }
}
function capacity(bytes: number): string { return `${(bytes / 1024 ** 2).toFixed(1)} MiB` }
const phases: Record<MineruDeploymentStatus['phase'], KnowledgeKey> = { absent: 'mineruPhaseAbsent', preparing_environment: 'mineruPhaseEnvironment', downloading: 'stageDownloading', probing: 'mineruPhaseProbe', ready: 'mineruPhaseReady', failed: 'stageFailed', canceled: 'stageCanceled', interrupted: 'mineruPhaseInterrupted' }
const pythonReasons: Record<NonNullable<MineruPythonDiscovery['environments'][number]['reason']>, KnowledgeKey> = {
  probe_failed: 'pythonReasonProbe', version_unsupported: 'pythonReasonVersion', implementation_unsupported: 'pythonReasonImplementation', architecture_unsupported: 'pythonReasonArchitecture', prerelease: 'pythonReasonPrerelease', free_threaded: 'pythonReasonThreaded', venv_missing: 'pythonReasonVenv', ensurepip_missing: 'pythonReasonPip',
}

/** Optional local MinerU deployment flow; detection never installs software. */
export function MineruDeploymentSection({ api, t, pickDirectory }: { api: KnowledgeApi; t: Translate; pickDirectory?: () => Promise<string | null> }): JSX.Element {
  const id = useId()
  const initial = useRef(readDraft()).current
  const [root, setRoot] = useState(initial.root ?? '')
  const [existing, setExisting] = useState(initial.existing ?? '')
  const [python, setPython] = useState(initial.python ?? '')
  const [pythonIndexUrl, setPythonIndexUrl] = useState(DEFAULT_PYTHON_INDEX)
  const [pythonIndexSaved, setPythonIndexSaved] = useState(false)
  const [manualPython, setManualPython] = useState(initial.manualPython ?? initial.python ?? '')
  const [pythonVerified, setPythonVerified] = useState(false)
  const [discovery, setDiscovery] = useState<MineruPythonDiscovery | null>(null)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<MineruDeploymentPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [status, setStatus] = useState<MineruDeploymentStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [applied, setApplied] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const statusRevision = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { saveDraft({ root, existing, python, manualPython }) }, [root, existing, python, manualPython])
  useEffect(() => {
    let canceled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      let fastPoll = false
      const revision = statusRevision.current
      try {
        const next = await api.mineruDeploymentStatus()
        fastPoll = next.active || next.service === 'starting' || next.service === 'stopping'
        if (!canceled && revision === statusRevision.current) { setStatus(next); setStatusError(null) }
      } catch (reason) { if (!canceled && revision === statusRevision.current) setStatusError(reason instanceof Error ? reason.message : String(reason)) }
      if (!canceled) timer = setTimeout(() => void poll(), fastPoll ? 1200 : 8000)
    }
    void poll()
    return () => { canceled = true; clearTimeout(timer) }
  }, [api])
  useEffect(() => {
    let canceled = false
    void api.getConfig().then(config => {
      if (!canceled) { setPythonIndexUrl(config.mineruPythonIndexUrl || DEFAULT_PYTHON_INDEX); setPythonIndexSaved(true) }
    }).catch(() => { if (!canceled) setPythonIndexSaved(false) })
    return () => { canceled = true }
  }, [api])
  useEffect(() => { if (confirming) dialog.current?.showModal(); else dialog.current?.close() }, [confirming])
  const locked = busy || status?.active === true || status?.service === 'running'
  function invalidatePlan(): void { setPlan(null); setError(null) }
  async function action(operation: 'prepare' | 'start' | 'stop' | 'cancel' | 'use') {
    if (pending.current) return
    statusRevision.current++
    pending.current = true; setBusy(true); setError(null); setConfirming(false)
    try {
      if (operation === 'use') { await api.useManagedMineru(); if (mounted.current) setApplied(true) }
      else {
        const next = operation === 'prepare' ? await api.prepareMineruDeployment(plan!.id) : await api.mineruDeploymentAction(operation)
        if (mounted.current) { statusRevision.current++; setStatus(next); if (operation === 'prepare') setPlan(null) }
      }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { statusRevision.current++; pending.current = false; if (mounted.current) setBusy(false) }
  }
  async function check() {
    if (pending.current || !python || !pythonVerified || !pythonIndexSaved) return
    pending.current = true; setBusy(true); setError(null); setPlan(null)
    try { const next = await api.planMineruDeployment(root, existing.trim() || undefined, python); if (mounted.current) setPlan(next) }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  async function savePythonSource() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null); invalidatePlan()
    try {
      const config = await api.setConfig({ mineruPythonIndexUrl: pythonIndexUrl.trim() || DEFAULT_PYTHON_INDEX })
      if (mounted.current) { setPythonIndexUrl(config.mineruPythonIndexUrl || DEFAULT_PYTHON_INDEX); setPythonIndexSaved(true) }
    } catch (reason) { if (mounted.current) { setPythonIndexSaved(false); setError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  async function browse(set: (value: string) => void) {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { const path = await pickDirectory?.(); if (path && mounted.current) { set(path); invalidatePlan() } }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  async function detect(executable?: string) {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null); invalidatePlan()
    try {
      const next = await api.detectMineruPython(executable)
      if (mounted.current) {
        setDiscovery(next)
        const chosen = executable ? next.environments[0] : next.environments.find(item => item.executable === python) ?? (!python ? next.environments.find(item => item.eligible) : undefined)
        if (executable && chosen) { setPython(chosen.executable); setManualPython(executable); setPythonVerified(chosen.eligible) }
        else if (chosen?.eligible) { setPython(chosen.executable); setManualPython(chosen.executable); setPythonVerified(true) }
        else setPythonVerified(false)
      }
    } catch (reason) { if (mounted.current) { setPythonVerified(false); setError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const selectPython = (path: string) => {
    setPython(path); setManualPython(path)
    setPythonVerified(discovery?.environments.some(item => item.executable === path && item.eligible) ?? false)
    invalidatePlan()
  }
  const setDraftPath = (setter: (value: string) => void) => (value: string) => { setter(value); invalidatePlan() }
  const validationLabels: [keyof NonNullable<MineruDeploymentStatus['validation']>, KnowledgeKey][] = [
    ['interpreter', 'pythonStepInterpreter'], ['environment', 'pythonStepEnvironment'], ['dependencies', 'pythonStepDependencies'], ['inference', 'pythonStepInference'],
  ]
  return <section aria-labelledby={`${id}-title`} style={{ padding: 18, marginBottom: 16, border: `1px solid ${C.border}`, borderRadius: 14, background: C.surface }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
      <div><h3 id={`${id}-title`} style={{ fontSize: 16, margin: '0 0 6px', color: C.text }}>{t('mineruDeployTitle')}</h3>
        <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, margin: 0, maxWidth: 720 }}>{t('mineruDeployDescription')}</p></div>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.accent, border: `1px solid ${C.border}`, borderRadius: 999, padding: '5px 10px', whiteSpace: 'nowrap', background: C.surface2 }}>Basic · ONNX</span>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 16 }}>
      <div style={{ padding: 14, border: `1px solid ${C.border}`, borderRadius: 12, minWidth: 0, background: C.surface2 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}><span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', width: 24, height: 24, borderRadius: 999, background: accentSoft, color: C.accent }}>1</span>{t('pythonChoose')}</div>
        <select aria-label={t('pythonChoose')} style={{ ...style.input, width: '100%', marginBottom: 8 }} value={python} disabled={locked} onChange={event => selectPython(event.target.value)}>
          <option value="">{t('pythonChoose')}</option>
          {python && !discovery?.environments.some(item => item.executable === python) ? <option value={python}>{t('pythonRemembered')} · {python}</option> : null}
          {discovery?.environments.map(env => <option key={env.executable} value={env.executable} disabled={!env.eligible}>{env.version ?? '?'} · {env.bits ?? '?'} bit · {env.executable}</option>)}
        </select>
        {python ? <div style={{ fontSize: 12, overflowWrap: 'anywhere', color: C.muted, marginBottom: 8, lineHeight: 1.55 }}>
          <code>{python}</code><br />{pythonVerified ? t('pythonEligible') : t('pythonRefreshHint')}
        </div> : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="kb-btn" style={style.button} disabled={locked} onClick={() => void detect()}>{t('pythonDetect')}</button>
          <button type="button" style={style.button} disabled={locked || !python} onClick={() => void detect(python)}>{t('pythonVerify')}</button>
        </div>
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, padding: '5px 0' }}>{t('pythonPath')}</summary>
          <p style={{ color: C.muted, fontSize: 12, lineHeight: 1.55 }}>{t('pythonManualHint')}</p>
          <input aria-label={t('pythonPath')} style={{ ...style.input, width: '100%', boxSizing: 'border-box', marginBottom: 8 }} value={manualPython} disabled={locked} onChange={event => {
            const value = event.target.value
            setManualPython(value); setPython(value); setPythonVerified(false); invalidatePlan()
          }} />
          <button type="button" style={style.button} disabled={locked || !manualPython.trim()} onClick={() => void detect(manualPython.trim())}>{t('pythonVerify')}</button>
        </details>
        {discovery?.environments.length === 0 ? <p role="status" style={{ fontSize: 12, color: C.muted }}>{t('pythonMissing')}</p> : null}
        {discovery?.truncated ? <p role="status" style={{ fontSize: 12, color: C.muted }}>{t('pythonLimited')}</p> : null}
        {discovery?.environments.some(item => !item.eligible) ? <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', fontSize: 12, color: C.muted, padding: '5px 0' }}>{t('pythonOtherDetected')}</summary>
          {discovery.environments.filter(item => !item.eligible).map(env => <div key={env.executable} style={{ fontSize: 11, overflowWrap: 'anywhere', paddingTop: 6 }}><code>{env.executable}</code><br />{env.version ?? '?'} · {t(pythonReasons[env.reason!])}</div>)}
        </details> : null}
      </div>

      <div style={{ padding: 14, border: `1px solid ${C.border}`, borderRadius: 12, minWidth: 0, background: C.surface2 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}><span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', width: 24, height: 24, borderRadius: 999, background: accentSoft, color: C.accent }}>2</span>{t('mineruDeployRoot')}</div>
        <label htmlFor={`${id}-root`} style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 5 }}>{t('mineruDeployRoot')}</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id={`${id}-root`} value={root} disabled={locked} style={{ ...style.input, flex: 1, minWidth: 0 }} onChange={event => setDraftPath(setRoot)(event.target.value)} />
          {pickDirectory ? <button type="button" className="kb-btn" style={style.button} disabled={locked} onClick={() => void browse(setDraftPath(setRoot))}>{t('mineruDeployBrowse')}</button> : null}
        </div>
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, padding: '8px 0 5px' }}>{t('mineruDeployExisting')}</summary>
          <p style={{ fontSize: 12, color: C.muted, lineHeight: 1.55 }}>{t('mineruExternalCopy')}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input aria-label={t('mineruDeployExisting')} value={existing} disabled={locked} style={{ ...style.input, flex: 1, minWidth: 0 }} onChange={event => { setExisting(event.target.value); invalidatePlan() }} />
            {pickDirectory ? <button type="button" className="kb-btn" style={style.button} disabled={locked} onClick={() => void browse(setDraftPath(setExisting))}>{t('mineruDeployBrowse')}</button> : null}
          </div>
        </details>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
          <label htmlFor={`${id}-python-index`} style={{ display: 'block', fontSize: 12, color: C.muted, marginBottom: 5 }}>{t('mineruPythonSource')}</label>
          <p style={{ fontSize: 12, lineHeight: 1.55, color: C.muted, margin: '0 0 8px' }}>{t('mineruPythonSourceHint')}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input id={`${id}-python-index`} value={pythonIndexUrl} disabled={locked || busy} style={{ ...style.input, flex: '1 1 220px', minWidth: 0 }} onChange={event => { setPythonIndexUrl(event.target.value); setPythonIndexSaved(false); invalidatePlan() }} />
            <button type="button" style={style.button} disabled={locked || busy || pythonIndexSaved} onClick={() => void savePythonSource()}>{t('mineruSaveSource')}</button>
          </div>
        </div>
      </div>
    </div>

    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
      <button type="button" className="kb-btn" style={style.button} disabled={locked || !root.trim() || !python || !pythonVerified || !pythonIndexSaved} onClick={() => void check()}>{t('mineruDeployCheck')}</button>
      {busy ? <span role="status" style={{ color: C.muted, fontSize: 12 }}>{t('mineruDeployChecking')}</span> : null}
    </div>
    {error ? <p role="alert" style={style.warningHint}>{error}</p> : null}
    {statusError ? <p role="status" style={style.warningHint}>{statusError}</p> : null}

    {discovery?.environments.some(item => item.eligible) ? <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontSize: 12, color: C.muted, padding: '5px 0' }}>{t('pythonDetectedDetails')}</summary>
      {discovery.environments.filter(item => item.eligible).map(env => <div key={env.executable} style={{ fontSize: 11, overflowWrap: 'anywhere', paddingTop: 6 }}><code>{env.executable}</code><br />{t('pythonVersion')} {env.version} · {t('pythonArchitecture')} {env.architecture} · {t('pythonSource')} {env.source}</div>)}
    </details> : null}

    {status ? <div aria-live="polite" style={{ fontSize: 12, lineHeight: 1.7, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
      <div style={{ fontWeight: 600 }}>{t(phases[status.phase])} · {t(status.service === 'running' ? 'mineruServiceRunning' : status.service === 'starting' ? 'mineruServiceStarting' : status.service === 'stopping' ? 'mineruServiceStopping' : status.service === 'error' ? 'mineruServiceError' : 'mineruServiceStopped')}</div>
      {status.root ? <div style={{ color: C.muted, overflowWrap: 'anywhere' }}>{t('mineruCurrentInstall')}: <code>{status.root}</code></div> : null}
      {status.totalBytes && status.completedBytes !== undefined ? <div><progress max={status.totalBytes} value={status.completedBytes} style={{ width: '100%' }} />{capacity(status.completedBytes)} / {capacity(status.totalBytes)}</div> : null}
      {status.validation ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 6, marginTop: 8 }}>
        {validationLabels.map(([key, label]) => <span key={key} style={{ color: status.validation?.[key] ? C.success : C.muted }}>{status.validation?.[key] ? '✓' : '○'} {t(label)}</span>)}
      </div> : null}
      {status.error ? <p role="alert" style={style.warningHint}>{status.error.code}: {status.error.message}</p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {status.active ? <button type="button" style={style.button} disabled={busy} onClick={() => void action('cancel')}>{t('mineruCancelTask')}</button> : null}
        {!status.active && status.phase === 'ready' && status.service !== 'running' ? <button type="button" style={style.button} disabled={busy} onClick={() => void action('start')}>{t('mineruStart')}</button> : null}
        {status.service === 'running' ? <><button type="button" style={style.button} disabled={busy} onClick={() => void action('stop')}>{t('mineruStop')}</button><button type="button" style={style.button} disabled={busy} onClick={() => void action('use')}>{t('mineruUse')}</button></> : null}
      </div>
      {applied ? <p role="status">{t('mineruApplied')}</p> : null}
    </div> : null}

    {plan ? <div aria-live="polite" style={{ marginTop: 14, padding: 12, border: `1px solid ${C.border}`, borderRadius: 10 }}>
      <h4 style={{ fontSize: 13, margin: '0 0 10px' }}>{t('mineruDeployCheck')}</h4>
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, fontSize: 12, margin: 0 }}>
        {([['mineruDeployTotal', plan.capacity.totalBytes], ['mineruDeployReuse', plan.capacity.verifiedReusableBytes], ['mineruDeployRemaining', plan.capacity.downloadBytes]] as const).map(([label, bytes]) => <div key={label}><dt style={{ color: C.muted }}>{t(label)}</dt><dd style={{ margin: '4px 0', fontWeight: 600 }}>{capacity(bytes)}</dd></div>)}
      </dl>
      <p style={{ color: C.muted, fontSize: 11, overflowWrap: 'anywhere' }}>{plan.modelRepo} · {plan.modelRevision.slice(0, 12)} · {plan.metadataDate}<br />{t('mineruDownloadSource')}: {plan.modelEndpoint}</p>
      <p style={style.warningHint}>{t('mineruDeployUnknownRuntime')}</p>
      {plan.blockers.map(code => <p key={code} role="alert" style={style.warningHint}>{code === 'external_models_incomplete' ? t('mineruDeployIncomplete') : code === 'insufficient_model_space' ? t('mineruDeploySpace') : code}</p>)}
      <button type="button" className="kb-btn" style={style.button} disabled={locked || plan.blockers.length > 0} onClick={() => setConfirming(true)}>{t('mineruPrepare')}</button>
    </div> : null}
    <p style={{ fontSize: 11, lineHeight: 1.55, color: C.muted, margin: '12px 0 0' }}>{t('mineruManagedPreview')}</p>

    <dialog ref={dialog} onCancel={() => setConfirming(false)} onClose={() => setConfirming(false)} aria-labelledby={`${id}-confirmation`} style={{ maxWidth: 520, width: 'calc(100% - 48px)', border: `1px solid ${C.border}`, borderRadius: 12, color: C.text, background: C.surface }}>
      <h3 id={`${id}-confirmation`}>{t('mineruPrepare')}</h3>
      <p style={{ fontSize: 12, lineHeight: 1.7 }}>{t('mineruConfirmPreparation')}</p>
      <p style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{plan?.root}<br />MinerU {plan?.runtimeVersion} · Basic / ONNX<br />{plan?.pythonIndexUrl} · {plan?.modelEndpoint} · {capacity(plan?.capacity.downloadBytes ?? 0)}</p>
      <p style={{ fontSize: 12 }}>{t('mineruDeployUnknownRuntime')}</p>
      <p style={{ overflowWrap: 'anywhere', fontSize: 12 }}>Python {plan?.python?.version} · {plan?.python?.bits} bit<br />{plan?.python?.executable}</p>
      <div style={{ display: 'flex', gap: 8 }}><button type="button" autoFocus style={style.button} onClick={() => setConfirming(false)}>{t('mineruNotNow')}</button><button type="button" className="kb-btn" style={style.button} disabled={busy || !plan} onClick={() => void action('prepare')}>{t('mineruConfirm')}</button></div>
    </dialog>
  </section>
}
