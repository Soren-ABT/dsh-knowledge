/**
 * Cherry Studio-style per-base retrieval settings panel (the 设置 view): the
 * exact section order of RagConfigPanel — 文档处理, 嵌入模型, 重排模型,
 * Top K + 相似度阈值, and a collapsed 高级设置 accordion — with a
 * 重置 / 保存 footer and dirty tracking.
 * @module dsh-knowledge/client/rag-config
 */

import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { KnowledgeApi } from './api.js'
import type { BaseConfig, BaseSummary, EmbeddingProvider, KnowledgeConfig, LocalModelStatus, ModelSuggestions } from './api.js'
import { C, style } from './theme.js'
import { IconRefresh } from './icons.js'
import type { Translate } from './locales.js'

interface PanelProps {
  base: BaseSummary
  globalConfig: KnowledgeConfig
  api: KnowledgeApi
  t: Translate
  busy: boolean
  onSaved: () => void
}

export function RagConfigPanel(props: PanelProps): JSX.Element {
  const { base, globalConfig, api, t, busy, onSaved } = props
  const [values, setValues] = useState<KnowledgeConfig>(() => ({
    ...globalConfig,
    ...(base.config ?? {}),
  }))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [localStatus, setLocalStatus] = useState<LocalModelStatus | null>(null)
  const [suggestions, setSuggestions] = useState<ModelSuggestions>({ embedding: [], local: [], rerank: [] })
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getModelSuggestions().then(result => { if (!cancelled) setSuggestions(result) }).catch(() => {})
    return () => { cancelled = true }
  }, [api])

  const listId = (kind: 'embedding' | 'local' | 'rerank'): string => `kb-${kind}-models-${base.id}`

  useEffect(() => {
    if (values.embeddingProvider !== 'local') { setLocalStatus(null); return }
    let cancelled = false
    const model = values.embeddingModel.trim() === '' ? 'onnx-community/Qwen3-Embedding-0.6B-ONNX' : values.embeddingModel.trim()
    const poll = async (): Promise<void> => {
      try {
        const status = await api.getLocalModelStatus(model)
        if (!cancelled) setLocalStatus(status)
      } catch {
        // keep the last known status on transient failures
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 800)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [api, values.embeddingProvider, values.embeddingModel])

  const initial = useMemo<KnowledgeConfig>(() => ({
    ...globalConfig,
    ...(base.config ?? {}),
  }), [globalConfig, base.config])

  const dirty = JSON.stringify(values) !== JSON.stringify(initial)

  const patch = (p: Partial<KnowledgeConfig>): void => setValues(prev => ({ ...prev, ...p }))

  const save = async (): Promise<void> => {
    setSaveError(null)
    const overrides: BaseConfig = {}
    const current = (base.config ?? {}) as Record<string, unknown>
    for (const key of Object.keys(values) as Array<keyof KnowledgeConfig>) {
      const value = values[key]
      const wasOverridden = current[key] !== undefined
      if (value !== globalConfig[key] || wasOverridden) {
        // A string field set back to its global value clears the override.
        ;(overrides as Record<string, unknown>)[key] = value === globalConfig[key] && typeof value === 'string' ? '' : value
      }
    }
    try {
      await api.updateBase(base.id, { config: overrides })
      onSaved()
    } catch (err) {
      // The host refuses switching an already-configured embedding model on a
      // non-empty base (Cherry's restore route) — surface that guidance.
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  const usesThreshold = values.rerankModel.trim() !== ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0 }}>
      <div style={{ ...style.card, flex: 1, overflowY: 'auto' }} className="kb-scroll">
        {/* 文档处理 */}
        <Section title={t('docProcessing')} hint={t('docProcessingHint')}>
          <select
            style={style.input}
            value={values.documentProcessorProvider}
            onChange={(e) => patch({ documentProcessorProvider: e.target.value as 'builtin' | 'mineru' })}
          >
            <option value="builtin">{t('processorBuiltin')}</option>
            <option value="mineru">MinerU（远程，扫描件/复杂版面）</option>
          </select>
          {values.documentProcessorProvider === 'mineru' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              <input
                style={style.input}
                type="password"
                placeholder="MinerU API Key"
                value={values.mineruApiKey}
                onChange={(e) => patch({ mineruApiKey: e.target.value })}
              />
              <input
                style={style.input}
                placeholder="API Host（默认 https://mineru.net）"
                value={values.mineruApiHost}
                onChange={(e) => patch({ mineruApiHost: e.target.value })}
              />
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                {t('processorMineruDesc')}
              </div>
            </div>
          )}
        </Section>

        {/* 嵌入模型 */}
        <Section title={t('embeddingProvider')} hint={t('perBaseHint')}>
          <select
            style={style.input}
            value={values.embeddingProvider}
            onChange={(e) => {
              const provider = e.target.value as EmbeddingProvider
              patch(
                provider === 'local' && values.embeddingModel.trim() === ''
                  ? { embeddingProvider: provider, embeddingModel: 'onnx-community/Qwen3-Embedding-0.6B-ONNX' }
                  : { embeddingProvider: provider }
              )
            }}
          >
            <option value="none">{t('providerNone')}</option>
            <option value="openai">{t('providerOpenAI')}</option>
            <option value="ollama">{t('providerOllama')}</option>
            <option value="local">{t('providerLocal')}</option>
          </select>
          {values.embeddingProvider === 'local' && (
            <div style={{ marginTop: 10 }}>
              <label style={style.label}>{t('embeddingModel')}</label>
              <input
                list={listId('local')}
                style={style.input}
                value={values.embeddingModel}
                onChange={(e) => patch({ embeddingModel: e.target.value })}
              />
              <div style={style.warningHint}>{t('localModelHint')}</div>
              {localStatus !== null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 12 }}>
                  {localStatus.status === 'downloading' && (
                    <>
                      <span className="kb-spinner" style={style.spinner} />
                      <span style={{ color: C.accent }}>{t('localModelDownloading')} {Math.floor(localStatus.progress)}%</span>
                      <div style={{ flex: 1, height: 4, borderRadius: 2, background: C.surface2 }}>
                        <div style={{ width: `${localStatus.progress}%`, height: 4, borderRadius: 2, background: C.accent }} />
                      </div>
                    </>
                  )}
                  {localStatus.status === 'ready' && (
                    <span style={{ color: C.success }}>✓ {t('localModelReady')}</span>
                  )}
                  {localStatus.status === 'error' && (
                    <span style={{ color: C.danger }} title={localStatus.message}>✕ {t('localModelError')}</span>
                  )}
                  {localStatus.status === 'idle' && (
                    <span style={{ color: C.muted }}>{t('localModelHint')}</span>
                  )}
                </div>
              )}
            </div>
          )}
          {values.embeddingProvider !== 'none' && values.embeddingProvider !== 'local' && (
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={style.label}>{t('embeddingModel')}</label>
                <input
                  list={listId('embedding')}
                  style={style.input}
                  value={values.embeddingModel}
                  onChange={(e) => patch({ embeddingModel: e.target.value })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={style.label}>{t('embeddingBaseUrl')}</label>
                <input style={style.input} value={values.embeddingBaseUrl} onChange={(e) => patch({ embeddingBaseUrl: e.target.value })} />
              </div>
            </div>
          )}
        </Section>

        {/* 重排模型 */}
        <Section title={t('rerankModel')} hint={t('rerankHint')}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <input
                list={listId('rerank')}
                style={style.input}
                value={values.rerankModel}
                onChange={(e) => patch({ rerankModel: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <input style={style.input} placeholder={t('rerankBaseUrl')} value={values.rerankBaseUrl} onChange={(e) => patch({ rerankBaseUrl: e.target.value })} />
            </div>
          </div>
        </Section>

        {/* Top K + 阈值 */}
        <Section title={t('topK')} hint={t('topKHint')}>
          <Slider
            value={values.topK}
            min={1}
            max={50}
            step={1}
            onChange={(v) => patch({ topK: v })}
            minLabel="1"
            maxLabel="50"
            format={(v) => String(v)}
          />
        </Section>
        {usesThreshold && (
          <Section title={t('threshold')} hint={t('thresholdHint')}>
            <Slider
              value={values.similarityThreshold}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => patch({ similarityThreshold: v })}
              minLabel="0.00"
              maxLabel="1.00"
              format={(v) => v.toFixed(2)}
            />
          </Section>
        )}

        {/* 上下文拼接 */}
        <Section title={t('siblingChunks')} hint={t('siblingChunksHint')}>
          <Slider
            value={values.siblingChunks}
            min={0}
            max={3}
            step={1}
            onChange={(v) => patch({ siblingChunks: v })}
            minLabel="0"
            maxLabel="3"
            format={(v) => String(v)}
          />
        </Section>

        {/* 高级设置 */}
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
          <button style={style.accordionHeader} onClick={() => setAdvancedOpen(v => !v)}>
            <span>{t('advancedSettings')}</span>
            <span style={{ color: C.muted, fontSize: 12 }}>{advancedOpen ? '▾' : '▸'}</span>
          </button>
          {advancedOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
              <FieldRow label={t('smartChunk')} hint={t('smartChunkHint')}>
                <Switch checked={values.smartChunk} onChange={(v) => patch({ smartChunk: v })} />
              </FieldRow>
              <FieldRow label={t('semanticChunk')} hint={t('semanticChunkHint')}>
                <Switch checked={values.semanticChunk} onChange={(v) => patch({ semanticChunk: v })} />
              </FieldRow>
              {values.semanticChunk && (
                <FieldRow label={t('semanticChunkThreshold')} hint={t('semanticChunkThresholdHint')}>
                  <input
                    style={{ ...style.input, width: 100 }}
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={values.semanticChunkThreshold}
                    onChange={(e) => patch({ semanticChunkThreshold: Number(e.target.value) })}
                  />
                </FieldRow>
              )}
              <FieldRow label={t('chunkSeparator')} hint={t('chunkSeparatorHint')}>
                <input
                  style={{ ...style.input, width: 140 }}
                  value={values.chunkSeparator}
                  onChange={(e) => patch({ chunkSeparator: e.target.value })}
                />
              </FieldRow>
              <FieldRow label={t('chunkSize')}>
                <input
                  style={{ ...style.input, width: 100 }}
                  type="number"
                  value={values.chunkSize}
                  onChange={(e) => patch({ chunkSize: Number(e.target.value) })}
                />
              </FieldRow>
              <FieldRow label={t('chunkOverlap')}>
                <input
                  style={{ ...style.input, width: 100 }}
                  type="number"
                  value={values.chunkOverlap}
                  onChange={(e) => patch({ chunkOverlap: Number(e.target.value) })}
                />
              </FieldRow>
              <FieldRow label={t('rrfVectorWeight')} hint={t('rrfVectorWeightHint')}>
                <input
                  style={{ ...style.input, width: 100 }}
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="5"
                  value={values.rrfVectorWeight}
                  onChange={(e) => patch({ rrfVectorWeight: Number(e.target.value) })}
                />
              </FieldRow>
              <div style={style.warningHint}>{t('chunkChangeWarning')}</div>
            </div>
          )}
        </div>
      </div>

      {/* footer: 重置 + 保存 */}
      {saveError !== null && (
        <div style={{ ...style.error, marginBottom: 8 }}>{saveError}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        <button
          style={{ ...style.ghostButton, opacity: dirty ? 1 : 0.45 }}
          disabled={!dirty || busy}
          onClick={() => setValues(initial)}
        >
          <IconRefresh size={13} />{t('reset')}
        </button>
        <button style={style.primary} disabled={!dirty || busy} onClick={() => void save()}>
          {t('save')}
        </button>
      </div>

      <datalist id={listId('embedding')}>
        {suggestions.embedding.map(model => <option key={model} value={model} />)}
      </datalist>
      <datalist id={listId('local')}>
        {suggestions.local.map(model => <option key={model} value={model} />)}
      </datalist>
      <datalist id={listId('rerank')}>
        {suggestions.rerank.map(model => <option key={model} value={model} />)}
      </datalist>
    </div>
  )
}

function Section(props: { title: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 18 }}>
      <p style={style.sectionTitle}>{props.title}</p>
      {props.hint !== undefined && <p style={style.sectionHint}>{props.hint}</p>}
      {props.children}
    </div>
  )
}

function FieldRow(props: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{props.label}</div>
        {props.hint !== undefined && <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{props.hint}</div>}
      </div>
      {props.children}
    </div>
  )
}

function Switch(props: { checked: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <button
      style={{ ...style.switch, ...(props.checked ? style.switchOn : {}) }}
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span style={{ ...style.switchKnob, transform: props.checked ? 'translateX(16px)' : 'none' }} />
    </button>
  )
}

function Slider(props: {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  minLabel: string
  maxLabel: string
  format: (value: number) => string
}): JSX.Element {
  return (
    <div>
      <div style={style.sliderRow}>
        <span />
        <span style={style.sliderValue}>{props.format(props.value)}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: C.accent }}
      />
      <div style={style.sliderBounds}>
        <span>{props.minLabel}</span>
        <span>{props.maxLabel}</span>
      </div>
    </div>
  )
}
