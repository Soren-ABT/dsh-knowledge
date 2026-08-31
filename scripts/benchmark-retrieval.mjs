#!/usr/bin/env node

import { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import * as KnowledgeModule from '../lib/knowledge/index.js'
import * as ToolKnowledgeModule from '../lib/tool-knowledge/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(ROOT, 'benchmarks', 'corpus', 'manifest.json')
const QUESTIONS_PATH = join(ROOT, 'benchmarks', 'questions.json')
const BASELINE_PATH = join(ROOT, 'benchmarks', 'baseline.json')
const HIT_VISIBLE_TOKEN_BUDGET = 768
const EXPLICIT_VISIBLE_TOKEN_BUDGET = 8192
const AUTO_VISIBLE_TOKEN_BUDGET = 640

const { KnowledgeService } = KnowledgeModule
const { serializeContextWindow } = KnowledgeModule
const { buildAutoRetrieveMessage, renderKnowledgeSearchResult } = ToolKnowledgeModule

const CONFIG = {
  embeddingProvider: 'none', embeddingBaseUrl: '', embeddingModel: '', embeddingApiKey: '',
  rerankModel: '', rerankBaseUrl: '', rerankApiKey: '', smartChunk: true,
  chunkSeparator: '\n\n', chunkSize: 800, chunkOverlap: 100, topK: 3,
  searchMode: 'lexical', similarityThreshold: 0, mmrDiversity: 0,
  rrfVectorWeight: 1, embeddingBatchSize: 32, siblingChunks: 1,
  localModelCacheDir: '', hfEndpoint: '', chunkStorePath: '',
  documentProcessorProvider: 'builtin', mineruApiKey: '', mineruApiHost: '',
  semanticChunk: false, semanticChunkThreshold: 0.75, chunkTokenLimit: 0,
  conflictStrategy: 'rename', urlRefreshHours: 0, imageCaptionProvider: 'off',
  imageCaptionModel: '', imageCaptionBaseUrl: '', imageCaptionApiKey: '',
  resumeInterruptedOnStartup: false, autoRetrieve: true, autoRetrieveWeight: 3,
  localWorkerIdleTimeoutMs: 60_000,
}

function fakeWebServer() {
  return { register: () => () => {} }
}

function normalize(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

function sentences(text) {
  return text.split(/[。！？!?\n]+/).map(value => value.trim()).filter(Boolean)
}

function recallFromText(groundTruth, text) {
  const context = normalize(text)
  const expected = sentences(groundTruth).map(normalize).filter(value => value.length >= 4)
  if (expected.length === 0) return 0
  return expected.filter(value => context.includes(value)).length / expected.length
}

function legacyEvidenceText(hit) {
  return `${hit.text ?? ''} ${hit.siblingContext ?? ''}`
}

function isContextWindow(value) {
  return value !== null
    && typeof value === 'object'
    && Array.isArray(value.before)
    && value.anchor !== null
    && typeof value.anchor === 'object'
    && Array.isArray(value.after)
}

function visibleEvidenceText(hit) {
  if (isContextWindow(hit.contextWindow)) {
    return serializeContextWindow(hit.contextWindow)
  }
  return hit.siblingContext !== undefined && hit.siblingContext.length > 0
    ? `${hit.siblingContext}\n>>> ${hit.text ?? ''}`
    : (hit.text ?? '')
}

function contextRecall(groundTruth, hits, evidenceOf) {
  return recallFromText(groundTruth, hits.map(evidenceOf).join('\n'))
}

/** Same deterministic estimate used by the knowledge service and composer. */
function estimateTokens(text) {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length
  const latin = text.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}

function evidenceTokens(text) {
  const lowered = text.toLowerCase()
  const latin = lowered.match(/[a-z0-9][a-z0-9_.-]*/g) ?? []
  const cjkRuns = lowered.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g) ?? []
  const cjk = cjkRuns.flatMap(run => run.length < 2
    ? [run]
    : Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2)))
  return [...latin, ...cjk]
}

function duplicateEvidenceStats(hits) {
  const seen = new Map()
  let total = 0
  let duplicate = 0
  for (const hit of hits) {
    for (const token of evidenceTokens(visibleEvidenceText(hit))) {
      total += 1
      const previous = seen.get(token) ?? 0
      if (previous > 0) duplicate += 1
      seen.set(token, previous + 1)
    }
  }
  return { total, duplicate }
}

/** The final production renderer must contain every canonical window exactly
 * as serialized. Because three 768-token windows fit inside the 8192-token
 * global budget, a missing window here is an ordering/clipping regression. */
function rendererOrderErrors(hits, rendered) {
  let errors = 0
  for (const hit of hits) {
    if (!isContextWindow(hit.contextWindow)) continue
    const canonical = serializeContextWindow(hit.contextWindow)
    if (!rendered.includes(canonical)) errors += 1
  }
  return errors
}

function contextOrderErrors(window) {
  if (!isContextWindow(window)) return 0
  const anchorIndex = Number.isInteger(window.anchorIndex) ? window.anchorIndex : window.anchor.index
  if (!Number.isInteger(anchorIndex) || window.anchor.index !== anchorIndex) return 1
  let errors = 0
  let previous = Number.NEGATIVE_INFINITY
  for (const chunk of window.before) {
    if (!Number.isInteger(chunk.index) || chunk.index >= anchorIndex || chunk.index <= previous) errors += 1
    previous = chunk.index
  }
  previous = anchorIndex
  for (const chunk of window.after) {
    if (!Number.isInteger(chunk.index) || chunk.index <= anchorIndex || chunk.index <= previous) errors += 1
    previous = chunk.index
  }
  return errors
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function summarize(rows) {
  const totalExpected = rows.reduce((sum, row) => sum + row.expectedCount, 0)
  const totalHits = rows.reduce((sum, row) => sum + row.hitCount, 0)
  const contextWindows = rows.reduce((sum, row) => sum + row.contextWindowCount, 0)
  const evidenceTokensTotal = rows.reduce((sum, row) => sum + row.evidenceTokensTotal, 0)
  return {
    hitAt1: rows.reduce((sum, row) => sum + row.hitAt1, 0) / rows.length,
    hitAt3: rows.reduce((sum, row) => sum + row.hitAt3, 0) / rows.length,
    recallAt3: rows.reduce((sum, row) => sum + row.foundCount, 0) / totalExpected,
    mrr: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length,
    contextRecall: rows.reduce((sum, row) => sum + row.contextRecall, 0) / rows.length,
    visibleEvidenceRecall: rows.reduce((sum, row) => sum + row.visibleEvidenceRecall, 0) / rows.length,
    contextWindowCoverage: totalHits === 0 ? 0 : contextWindows / totalHits,
    contextOrderErrors: rows.reduce((sum, row) => sum + row.contextOrderErrors, 0),
    rendererOrderErrors: rows.reduce((sum, row) => sum + row.rendererOrderErrors, 0),
    hitBudgetOverruns: rows.reduce((sum, row) => sum + row.hitBudgetOverruns, 0),
    contextBudgetOverruns: rows.reduce((sum, row) => sum + row.contextBudgetOverruns, 0),
    duplicateTokenRatio: evidenceTokensTotal === 0
      ? 0
      : rows.reduce((sum, row) => sum + row.duplicateEvidenceTokens, 0) / evidenceTokensTotal,
    averageVisibleTokens: rows.reduce((sum, row) => sum + row.visibleTokens, 0) / rows.length,
    p50Ms: percentile(rows.map(row => row.elapsedMs), 0.5),
    p95Ms: percentile(rows.map(row => row.elapsedMs), 0.95),
  }
}

async function runQueries(service, questions, multiQuery) {
  if (typeof serializeContextWindow !== 'function') {
    throw new Error('benchmark requires the exported production serializeContextWindow helper')
  }
  if (typeof renderKnowledgeSearchResult !== 'function') {
    throw new Error('benchmark requires the exported renderKnowledgeSearchResult helper')
  }
  const baseNames = new Map(service.listBases().map(base => [base.id, base.name]))
  const rows = []
  for (const question of questions) {
    const started = performance.now()
    const result = await service.search({
      query: question.query,
      ...(multiQuery ? { queries: question.variants } : {}),
      mode: 'lexical',
      topK: 3,
    })
    const elapsedMs = performance.now() - started
    const titles = result.hits.map(hit => hit.documentTitle)
    const expected = question.expected
    const firstRank = titles.findIndex(title => expected.includes(title)) + 1
    const found = expected.filter(title => titles.includes(title))
    const visibleText = renderKnowledgeSearchResult(result, baseId => baseNames.get(baseId))
    const duplicate = duplicateEvidenceStats(result.hits)
    const windows = result.hits.map(hit => hit.contextWindow).filter(isContextWindow)
    rows.push({
      id: question.id,
      expected,
      observed: titles,
      expectedCount: expected.length,
      foundCount: found.length,
      hitCount: result.hits.length,
      hitAt1: firstRank === 1 ? 1 : 0,
      hitAt3: firstRank > 0 && firstRank <= 3 ? 1 : 0,
      reciprocalRank: firstRank > 0 ? 1 / firstRank : 0,
      contextRecall: contextRecall(question.groundTruth, result.hits, legacyEvidenceText),
      visibleEvidenceRecall: recallFromText(question.groundTruth, visibleText),
      contextWindowCount: windows.length,
      contextOrderErrors: windows.reduce((sum, window) => sum + contextOrderErrors(window), 0),
      rendererOrderErrors: rendererOrderErrors(result.hits, visibleText),
      hitBudgetOverruns: result.hits.reduce((sum, hit) => (
        sum + (estimateTokens(visibleEvidenceText(hit)) > HIT_VISIBLE_TOKEN_BUDGET ? 1 : 0)
      ), 0),
      contextBudgetOverruns: estimateTokens(visibleText) > EXPLICIT_VISIBLE_TOKEN_BUDGET ? 1 : 0,
      evidenceTokensTotal: duplicate.total,
      duplicateEvidenceTokens: duplicate.duplicate,
      visibleTokens: estimateTokens(visibleText),
      elapsedMs,
    })
  }
  return { metrics: summarize(rows), rows }
}

async function runAutoQueries(service, questions) {
  if (typeof buildAutoRetrieveMessage !== 'function') {
    throw new Error('benchmark requires the exported buildAutoRetrieveMessage helper')
  }
  const rows = []
  for (const question of questions) {
    const started = performance.now()
    const background = await buildAutoRetrieveMessage(
      service,
      { id: `benchmark-${question.id}`, inject: () => {} },
      question.query,
    )
    const elapsedMs = performance.now() - started
    const text = background?.message?.content
      ?.filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n') ?? ''
    rows.push({
      id: question.id,
      expected: question.expected,
      observed: background === undefined ? [] : ['auto background'],
      injected: background === undefined ? 0 : 1,
      visibleEvidenceRecall: recallFromText(question.groundTruth, text),
      budgetOverrun: estimateTokens(text) > AUTO_VISIBLE_TOKEN_BUDGET ? 1 : 0,
      visibleTokens: estimateTokens(text),
      elapsedMs,
    })
  }
  return {
    metrics: {
      injectionRate: rows.reduce((sum, row) => sum + row.injected, 0) / rows.length,
      visibleEvidenceRecall: rows.reduce((sum, row) => sum + row.visibleEvidenceRecall, 0) / rows.length,
      budgetOverruns: rows.reduce((sum, row) => sum + row.budgetOverrun, 0),
      averageVisibleTokens: rows.reduce((sum, row) => sum + row.visibleTokens, 0) / rows.length,
      p50Ms: percentile(rows.map(row => row.elapsedMs), 0.5),
      p95Ms: percentile(rows.map(row => row.elapsedMs), 0.95),
    },
    rows,
  }
}

/** Exercise the evidence-chain contracts that cannot be proved by ordinary
 * document-level retrieval questions. The bridge answer intentionally lives
 * outside the matching anchor; the tail answer intentionally lives outside
 * the opening 768-token slice of an oversized canonical anchor. */
async function runEvidenceChainFixtures(service) {
  const bridgeBase = await service.createBase({
    name: '__benchmark_v2_bridge__',
    config: {
      smartChunk: false,
      chunkSeparator: '||',
      chunkSize: 800,
      chunkOverlap: 0,
      siblingChunks: 1,
      searchMode: 'lexical',
      similarityThreshold: 0,
    },
  })
  const bridgeAnswer = 'The bridge authorization answer is ORBIT-CEDAR-9381.'
  const bridgeBeforeMarker = 'BRIDGE-BEFORE-9381'
  const bridgeAnchorMarker = 'BRIDGEANCHOR9381'
  const bridgeAfterMarker = 'BRIDGE-AFTER-9381'
  const bridgeDocument = await service.addTextDocument({
    baseId: bridgeBase.id,
    title: '__benchmark_bridge_manual__',
    content: [
      `${bridgeBeforeMarker}: prerequisite evidence appears before the locator.`,
      `${bridgeAnchorMarker}: this locator deliberately omits the neighboring secret.`,
      `${bridgeAfterMarker}: ${bridgeAnswer}`,
    ].join('||'),
  })
  const bridgeChunks = service.listChunks(bridgeDocument.id)
  const bridgeSearch = await service.search({
    query: bridgeAnchorMarker,
    baseId: bridgeBase.id,
    mode: 'lexical',
    topK: 1,
  })
  const bridgeHit = bridgeSearch.hits[0]
  const bridgeVisible = bridgeHit === undefined ? '' : visibleEvidenceText(bridgeHit)
  const bridgeRendered = renderKnowledgeSearchResult(bridgeSearch, baseId => (
    baseId === bridgeBase.id ? bridgeBase.name : undefined
  ))
  const anchorRead = bridgeHit === undefined
    ? undefined
    : service.getDocumentContext(bridgeDocument.id, {
      anchorChunkId: bridgeHit.chunkId,
      before: 1,
      after: 1,
      maxTokens: 1600,
      focus: bridgeAnchorMarker,
    })
  const anchorReadVisible = anchorRead === undefined ? '' : serializeContextWindow(anchorRead.contextWindow)
  const bridgeRenderedWindowStart = bridgeRendered.indexOf(bridgeVisible)
  const bridgeRenderedWindow = bridgeRenderedWindowStart < 0
    ? ''
    : bridgeRendered.slice(bridgeRenderedWindowStart, bridgeRenderedWindowStart + bridgeVisible.length)
  const markerPositions = [bridgeBeforeMarker, bridgeAnchorMarker, bridgeAfterMarker]
    .map(marker => bridgeRenderedWindow.indexOf(marker))
  const markersInOrder = markerPositions.every((position, index) => (
    position >= 0 && (index === 0 || position > markerPositions[index - 1])
  ))
  const top1AnchorOnlyMiss = bridgeHit !== undefined
    && bridgeHit.chunkId === bridgeChunks[1]?.id
    && !bridgeHit.text.includes(bridgeAnswer)
  const searchWindowBridge = bridgeHit !== undefined
    && isContextWindow(bridgeHit.contextWindow)
    && bridgeVisible.includes(bridgeAnswer)
  const anchorReadBridge = anchorRead !== undefined
    && anchorRead.contextWindow.anchorChunkId === bridgeHit?.chunkId
    && anchorReadVisible.includes(bridgeAnswer)
  const bridgeSuccess = top1AnchorOnlyMiss
    && searchWindowBridge
    && anchorReadBridge
    && bridgeRendered.includes(bridgeAnswer)

  const tailBase = await service.createBase({
    name: '__benchmark_v2_tail__',
    config: {
      smartChunk: false,
      chunkSeparator: '||',
      chunkSize: 800,
      chunkOverlap: 0,
      siblingChunks: 0,
      searchMode: 'lexical',
      similarityThreshold: 0,
    },
  })
  const tailMarker = 'TAILFOCUS9381'
  const tailAnswer = `${tailMarker}: the terminal evidence is VIOLET-HARBOR-2718.`
  // ~790 estimated tokens: one canonical 800-token chunk, but necessarily
  // query-centred before it can enter a 768-token visible evidence window.
  const longAnchorText = `${'neutral preface '.repeat(195)}${tailAnswer}`
  const tailDocument = await service.addTextDocument({
    baseId: tailBase.id,
    title: '__benchmark_long_anchor_manual__',
    content: longAnchorText,
  })
  const tailChunks = service.listChunks(tailDocument.id)
  const tailSearch = await service.search({
    query: tailMarker,
    baseId: tailBase.id,
    mode: 'lexical',
    topK: 1,
  })
  const tailHit = tailSearch.hits[0]
  const tailEvidence = tailHit === undefined ? '' : visibleEvidenceText(tailHit)
  const tailRendered = renderKnowledgeSearchResult(tailSearch, baseId => (
    baseId === tailBase.id ? tailBase.name : undefined
  ))
  const longAnchorCanonicalOversized = tailHit !== undefined
    && tailChunks.length === 1
    && estimateTokens(tailHit.text) > HIT_VISIBLE_TOKEN_BUDGET
  const longAnchorTailVisible = longAnchorCanonicalOversized
    && isContextWindow(tailHit.contextWindow)
    && tailHit.contextWindow.anchor.truncatedStart === true
    && estimateTokens(tailEvidence) <= HIT_VISIBLE_TOKEN_BUDGET
    && tailRendered.includes(tailAnswer)

  // Drive the exact renderer close to its whole-response budget with real,
  // service-produced bounded windows. The clones stress rendering only; their
  // canonical evidence remains the production ContextWindow output above.
  const stressHits = tailHit === undefined
    ? []
    : Array.from({ length: 24 }, (_, index) => ({
      ...tailHit,
      chunkId: `${tailHit.chunkId}-stress-${index}`,
      docId: `${tailHit.docId}-stress-${index}`,
      documentTitle: `__benchmark_render_stress_${index}__`,
      score: Math.max(0, tailHit.score - index / 1000),
      contextWindow: {
        ...tailHit.contextWindow,
        anchorChunkId: `${tailHit.chunkId}-stress-${index}`,
        anchor: {
          ...tailHit.contextWindow.anchor,
          chunkId: `${tailHit.chunkId}-stress-${index}`,
        },
      },
    }))
  const stressRendered = renderKnowledgeSearchResult({
    ...tailSearch,
    total: stressHits.length,
    hits: stressHits,
  }, baseId => (baseId === tailBase.id ? tailBase.name : undefined))
  const allFixtureHits = [bridgeHit, tailHit, ...stressHits].filter(Boolean)
  const hitBudgetOverruns = allFixtureHits.reduce((sum, hit) => (
    sum + (estimateTokens(visibleEvidenceText(hit)) > HIT_VISIBLE_TOKEN_BUDGET ? 1 : 0)
  ), 0)
  const globalBudgetOverruns = [bridgeRendered, tailRendered, stressRendered]
    .reduce((sum, text) => sum + (estimateTokens(text) > EXPLICIT_VISIBLE_TOKEN_BUDGET ? 1 : 0), 0)

  const metrics = {
    top1AnchorOnlyMissAt1: top1AnchorOnlyMiss ? 1 : 0,
    searchWindowBridgeAt1: searchWindowBridge ? 1 : 0,
    anchorReadBridgeAt1: anchorReadBridge ? 1 : 0,
    bridgeSuccessAt1: bridgeSuccess ? 1 : 0,
    longAnchorCanonicalOversizedAt1: longAnchorCanonicalOversized ? 1 : 0,
    longAnchorTailVisibleAt1: longAnchorTailVisible ? 1 : 0,
    contextWindowCoverage: [bridgeHit, tailHit].filter(hit => isContextWindow(hit?.contextWindow)).length / 2,
    rendererOrderErrors: markersInOrder ? 0 : 1,
    hitBudgetOverruns,
    globalBudgetOverruns,
    maxHitVisibleTokens: Math.max(0, ...allFixtureHits.map(hit => estimateTokens(visibleEvidenceText(hit)))),
    maxRenderedTokens: Math.max(...[bridgeRendered, tailRendered, stressRendered].map(estimateTokens)),
  }
  return {
    metrics,
    rows: [{
      id: 'evidence-chain-fixtures',
      expected: ['multi-chunk bridge', 'anchor continuation', 'long-anchor tail'],
      observed: [
        `bridge chunks=${bridgeChunks.length}`,
        `tail chunks=${tailChunks.length}`,
        `stress visible tokens=${estimateTokens(stressRendered)}`,
      ],
      hitAt3: bridgeSuccess && longAnchorTailVisible ? 1 : 0,
      contextRecall: bridgeSuccess ? 1 : 0,
      visibleEvidenceRecall: longAnchorTailVisible ? 1 : 0,
    }],
  }
}

function roundedMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [
    key,
    Number(value.toFixed(key.endsWith('Ms') ? 3 : 6)),
  ]))
}

function enforceThresholds(name, result, minimums = {}, maximums = {}) {
  const failures = []
  for (const [metric, minimum] of Object.entries(minimums)) {
    const observed = result.metrics[metric]
    if (typeof observed !== 'number') failures.push(`${name}.${metric} is missing`)
    else if (observed < minimum) failures.push(`${name}.${metric}=${observed.toFixed(4)} < ${minimum}`)
  }
  for (const [metric, maximum] of Object.entries(maximums)) {
    const observed = result.metrics[metric]
    if (typeof observed !== 'number') failures.push(`${name}.${metric} is missing`)
    else if (observed > maximum) failures.push(`${name}.${metric}=${observed.toFixed(4)} > ${maximum}`)
  }
  if (failures.length > 0) {
    const missed = result.rows
      .filter(row => row.hitAt3 === 0 || row.contextRecall < 1 || row.visibleEvidenceRecall < 1 || row.injected === 0)
      .map(row => `${row.id}: expected ${row.expected.join(' | ')}, observed ${row.observed.join(' | ') || '(none)'}`)
    throw new Error(`${failures.join('\n')}\n${missed.join('\n')}`.trim())
  }
}

function observedMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).filter(([key]) => !key.endsWith('Ms')))
}

async function main() {
  if (typeof serializeContextWindow !== 'function') {
    throw new Error('benchmark requires the exported production serializeContextWindow helper; structural fallback is forbidden')
  }
  if (typeof renderKnowledgeSearchResult !== 'function') {
    throw new Error('benchmark requires the exported production renderKnowledgeSearchResult helper')
  }
  const jsonOnly = process.argv.includes('--json')
  const update = process.argv.includes('--update')
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const questions = JSON.parse(await readFile(QUESTIONS_PATH, 'utf8')).questions
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  if (baseline.schemaVersion !== 2) throw new Error(`benchmark baseline schemaVersion must be 2, found ${baseline.schemaVersion}`)
  if (manifest.documents.length !== 24) throw new Error(`benchmark corpus must contain 24 documents, found ${manifest.documents.length}`)
  if (questions.length !== 40) throw new Error(`benchmark must contain 40 questions, found ${questions.length}`)

  const rssBefore = process.memoryUsage().rss
  const ctx = new Context()
  ctx.provide('webServer', fakeWebServer())
  await ctx.plugin(KnowledgeService, CONFIG)
  const service = ctx.get('knowledge')
  const bases = new Map()
  for (const document of manifest.documents) {
    let base = bases.get(document.base)
    if (base === undefined) {
      base = await service.createBase({ name: document.base })
      bases.set(document.base, base)
    }
    const content = await readFile(join(ROOT, 'benchmarks', 'corpus', document.file), 'utf8')
    await service.addTextDocument({ baseId: base.id, title: document.title, content })
  }

  const primary = await runQueries(service, questions, false)
  const multiQuery = await runQueries(service, questions, true)
  const autoRetrieve = await runAutoQueries(service, questions)
  const evidenceChain = await runEvidenceChainFixtures(service)
  const report = {
    schemaVersion: 2,
    corpusDocuments: manifest.documents.length,
    questions: questions.length,
    capabilities: {
      contextWindowObserved: primary.metrics.contextWindowCoverage === 1 && multiQuery.metrics.contextWindowCoverage === 1,
      contextWindowSerializer: 'production',
      nativeSearchRenderer: 'production',
      bridgeMeasurement: 'dedicated-anchor-miss-plus-context-window-and-anchor-read',
      longAnchorTailMeasurement: 'dedicated-production-renderer-fixture',
      autoRetrieveEvaluated: true,
    },
    primary: roundedMetrics(primary.metrics),
    multiQuery: roundedMetrics(multiQuery.metrics),
    autoRetrieve: roundedMetrics(autoRetrieve.metrics),
    evidenceChain: roundedMetrics(evidenceChain.metrics),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      logicalCalls: {
        primary: questions.length,
        multiQuery: questions.length,
        autoRetrieve: questions.length,
        evidenceChain: 2,
      },
      rssBeforeBytes: rssBefore,
      rssAfterBytes: process.memoryUsage().rss,
    },
  }
  enforceThresholds('primary', primary, baseline.thresholds.primary, baseline.maximums.primary)
  enforceThresholds('multiQuery', multiQuery, baseline.thresholds.multiQuery, baseline.maximums.multiQuery)
  enforceThresholds('autoRetrieve', autoRetrieve, baseline.thresholds.autoRetrieve, baseline.maximums.autoRetrieve)
  enforceThresholds('evidenceChain', evidenceChain, baseline.thresholds.evidenceChain, baseline.maximums.evidenceChain)

  if (update) {
    const next = {
      ...baseline,
      observed: {
        primary: observedMetrics(report.primary),
        multiQuery: observedMetrics(report.multiQuery),
        autoRetrieve: observedMetrics(report.autoRetrieve),
        evidenceChain: observedMetrics(report.evidenceChain),
      },
    }
    await writeFile(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  }
  if (jsonOnly) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`retrieval benchmark v2: ${report.corpusDocuments} documents, ${report.questions} questions`)
    for (const [name, metrics] of [['primary', report.primary], ['multi-query RRF', report.multiQuery]]) {
      console.log(`${name}: Hit@1 ${(metrics.hitAt1 * 100).toFixed(1)}% | Hit@3 ${(metrics.hitAt3 * 100).toFixed(1)}% | Recall@3 ${(metrics.recallAt3 * 100).toFixed(1)}% | MRR ${metrics.mrr.toFixed(3)} | Context Recall ${(metrics.contextRecall * 100).toFixed(1)}% | Visible Evidence ${(metrics.visibleEvidenceRecall * 100).toFixed(1)}% | p50 ${metrics.p50Ms.toFixed(2)}ms | p95 ${metrics.p95Ms.toFixed(2)}ms`)
      console.log(`${name} diagnostics: context-window coverage ${(metrics.contextWindowCoverage * 100).toFixed(1)}% | structure order errors ${metrics.contextOrderErrors} | renderer order errors ${metrics.rendererOrderErrors} | per-hit overruns ${metrics.hitBudgetOverruns} | global overruns ${metrics.contextBudgetOverruns} | duplicate-token ratio ${(metrics.duplicateTokenRatio * 100).toFixed(1)}% | avg visible tokens ${metrics.averageVisibleTokens.toFixed(1)}`)
    }
    console.log(`auto-retrieve: injection ${(report.autoRetrieve.injectionRate * 100).toFixed(1)}% | Visible Evidence ${(report.autoRetrieve.visibleEvidenceRecall * 100).toFixed(1)}% | budget overruns ${report.autoRetrieve.budgetOverruns} | avg visible tokens ${report.autoRetrieve.averageVisibleTokens.toFixed(1)} | p50 ${report.autoRetrieve.p50Ms.toFixed(2)}ms | p95 ${report.autoRetrieve.p95Ms.toFixed(2)}ms`)
    console.log(`evidence-chain fixtures: Bridge@1 ${(report.evidenceChain.bridgeSuccessAt1 * 100).toFixed(1)}% | anchored read ${(report.evidenceChain.anchorReadBridgeAt1 * 100).toFixed(1)}% | long-tail visible ${(report.evidenceChain.longAnchorTailVisibleAt1 * 100).toFixed(1)}% | renderer order errors ${report.evidenceChain.rendererOrderErrors} | per-hit overruns ${report.evidenceChain.hitBudgetOverruns} | global overruns ${report.evidenceChain.globalBudgetOverruns} | max hit ${report.evidenceChain.maxHitVisibleTokens} tokens | max render ${report.evidenceChain.maxRenderedTokens} tokens`)
    console.log(`contracts: contextWindow=${report.capabilities.contextWindowObserved ? '100% covered' : 'incomplete'} | serializer=${report.capabilities.contextWindowSerializer} | native-renderer=${report.capabilities.nativeSearchRenderer} | bridge=${report.capabilities.bridgeMeasurement}`)
    console.log(`RSS: ${(report.runtime.rssBeforeBytes / 1024 / 1024).toFixed(1)} MiB -> ${(report.runtime.rssAfterBytes / 1024 / 1024).toFixed(1)} MiB`)
    if (update) console.log('benchmark baseline observations updated')
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
