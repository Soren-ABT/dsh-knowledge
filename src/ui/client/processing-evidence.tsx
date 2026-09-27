import { useEffect, useState } from 'react'
import type { DocumentEvidence, DocumentProcessingInfo, DocumentSourceSpan, KnowledgeApi, ProcessingProgress } from './api.js'
import type { KnowledgeKey, Translate } from './locales.js'
import { C, style } from './theme.js'

const stageKeys: Record<ProcessingProgress['stage'], KnowledgeKey> = {
  queued: 'stageQueued', checking: 'stageChecking', uploading: 'stageUploading', parsing: 'stageParsing',
  downloading: 'stageDownloading', normalizing: 'stageNormalizing', indexing: 'stageIndexing',
  completed: 'stageCompleted', failed: 'stageFailed', canceled: 'stageCanceled',
}

export function processingStageLabel(progress: ProcessingProgress, t: Translate): string {
  return t(stageKeys[progress.stage])
}

export function sourcePageUrl(documentId: string, pageIndex: number): string | undefined {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return undefined
  return `/knowledge/documents/${encodeURIComponent(documentId)}/raw?inline=1#page=${pageIndex + 1}`
}

export function artifactUrl(documentId: string, revision: string, assetId: string): string {
  return `/knowledge/documents/${encodeURIComponent(documentId)}/artifacts/${encodeURIComponent(assetId)}?revision=${encodeURIComponent(revision)}`
}

export function ProcessingSummary({ processing, t }: { processing?: DocumentProcessingInfo; t: Translate }): JSX.Element | null {
  if (processing === undefined) return null
  const completeness = processing.completeness === 'complete' ? 'processingComplete' : processing.completeness === 'partial' ? 'processingPartial' : 'processingUnknown'
  const provider = processing.provider === 'mineru-local' ? t('mineruLocalOption') : processing.provider === 'mineru' ? t('mineruOption') : t('processorBuiltin')
  return <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>
    <div>{t('processingInfo')}: {provider}{processing.processorVersion ? ` ${processing.processorVersion}` : ''} · {t(completeness)}{processing.reused ? ` · ${t('processingReused')}` : ''}</div>
    {processing.warnings.length > 0 ? <ul style={{ margin: '4px 0', paddingLeft: 18, color: C.warn }}>
      {processing.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
    </ul> : null}
  </div>
}

/** Geometry describes a source block; a native PDF iframe cannot align an overlay reliably. */
export function SourceReferences(props: { documentId: string; spans?: readonly DocumentSourceSpan[]; t: Translate; onPage?: (pageIndex: number) => void; revision?: string }): JSX.Element | null {
  const { documentId, spans, t } = props
  if (!spans?.length) return null
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: C.muted, marginTop: 6 }}>
    {spans.slice(0, 32).map((span, index) => {
      const current = props.revision === undefined || props.revision === span.revision
      const pageUrl = current && span.pageIndex !== undefined ? sourcePageUrl(documentId, span.pageIndex) : undefined
      return <div key={`${span.revision}-${span.blockId}-${index}`}>
        {pageUrl ? <a href={pageUrl} target="_blank" rel="noreferrer" onClick={props.onPage ? event => { event.preventDefault(); props.onPage?.(span.pageIndex!) } : undefined} style={{ color: C.accent }}>{t('sourcePage').replace('{page}', String(span.pageIndex! + 1))}</a> : <span>{t('sourceUnavailable')}</span>}
        {' · '}{t('sourceBlock')} {span.blockId} · {span.blockType}
        {span.bbox ? <span> · {t('sourceRegion')}: [{[span.bbox.x0, span.bbox.y0, span.bbox.x1, span.bbox.y1].map(value => value.toFixed(3)).join(', ')}]</span> : null}
        {current ? span.assetIds?.map(assetId => <a key={assetId} href={artifactUrl(documentId, span.revision, assetId)} target="_blank" rel="noreferrer" style={{ color: C.accent, marginLeft: 8 }}>{t('sourceAsset')} {assetId}</a>) : null}
      </div>
    })}
  </div>
}

export function EvidenceInspector(props: { api: KnowledgeApi; documentId: string; revision?: string; t: Translate; onPage: (pageIndex: number) => void }): JSX.Element {
  const { api, documentId, revision, t, onPage } = props
  const [cursor, setCursor] = useState<{ blockId: string; blockOffset: number } | undefined>()
  const [result, setResult] = useState<DocumentEvidence | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let canceled = false
    setResult(null)
    setError(null)
    void api.readDocumentEvidence(documentId, { ...cursor, revision, maxTokens: 1600 }).then(value => {
      if (!canceled) setResult(value)
    }).catch((reason: unknown) => {
      if (!canceled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { canceled = true }
  }, [api, documentId, revision, cursor?.blockId, cursor?.blockOffset])
  if (error !== null) return <div role="alert" style={style.warningHint}>{error}</div>
  if (result === null) return <div role="status" style={style.empty}>{t('processing')}</div>
  return <div>
    {result.blocks.length === 0 ? <div style={style.empty}>{t('evidenceEmpty')}</div> : result.blocks.map(block => <div key={block.id} style={{ border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8, padding: 10 }}>
      <div style={{ fontSize: 11, color: C.muted }}>{block.type} · {block.id}</div>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, fontFamily: 'inherit', lineHeight: 1.6 }}>{block.text}</pre>
      <SourceReferences documentId={documentId} t={t} onPage={onPage} revision={revision} spans={result.processing ? [{
        revision: result.processing.revision, blockId: block.id, blockType: block.type,
        chunkStart: 0, chunkEnd: block.text.length, blockStart: 0, blockEnd: block.text.length,
        pageIndex: block.pageIndex, bbox: block.bbox, assetIds: block.assetIds,
      }] : undefined} />
    </div>)}
    {result.truncated && result.next ? <button type="button" style={style.button} onClick={() => setCursor(result.next)}>{t('evidenceNext')}</button> : null}
  </div>
}
