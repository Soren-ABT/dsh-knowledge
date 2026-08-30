#!/usr/bin/env node

import { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { KnowledgeService } from '../lib/knowledge/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(ROOT, 'benchmarks', 'corpus', 'manifest.json')
const QUESTIONS_PATH = join(ROOT, 'benchmarks', 'questions.json')
const BASELINE_PATH = join(ROOT, 'benchmarks', 'baseline.json')

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

function contextRecall(groundTruth, hits) {
  const context = normalize(hits.map(hit => `${hit.text ?? ''} ${hit.siblingContext ?? ''}`).join(' '))
  const expected = sentences(groundTruth).map(normalize).filter(value => value.length >= 4)
  if (expected.length === 0) return 0
  return expected.filter(value => context.includes(value)).length / expected.length
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function summarize(rows) {
  const totalExpected = rows.reduce((sum, row) => sum + row.expectedCount, 0)
  return {
    hitAt1: rows.reduce((sum, row) => sum + row.hitAt1, 0) / rows.length,
    hitAt3: rows.reduce((sum, row) => sum + row.hitAt3, 0) / rows.length,
    recallAt3: rows.reduce((sum, row) => sum + row.foundCount, 0) / totalExpected,
    mrr: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length,
    contextRecall: rows.reduce((sum, row) => sum + row.contextRecall, 0) / rows.length,
    p50Ms: percentile(rows.map(row => row.elapsedMs), 0.5),
    p95Ms: percentile(rows.map(row => row.elapsedMs), 0.95),
  }
}

async function runQueries(service, questions, multiQuery) {
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
    rows.push({
      id: question.id,
      expected,
      observed: titles,
      expectedCount: expected.length,
      foundCount: found.length,
      hitAt1: firstRank === 1 ? 1 : 0,
      hitAt3: firstRank > 0 && firstRank <= 3 ? 1 : 0,
      reciprocalRank: firstRank > 0 ? 1 / firstRank : 0,
      contextRecall: contextRecall(question.groundTruth, result.hits),
      elapsedMs,
    })
  }
  return { metrics: summarize(rows), rows }
}

function roundedMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Number(value.toFixed(key.endsWith('Ms') ? 3 : 6))]))
}

function enforceThresholds(name, result, thresholds) {
  const failures = []
  for (const [metric, minimum] of Object.entries(thresholds)) {
    if (result.metrics[metric] < minimum) failures.push(`${name}.${metric}=${result.metrics[metric].toFixed(4)} < ${minimum}`)
  }
  if (failures.length > 0) {
    const missed = result.rows
      .filter(row => row.hitAt3 === 0 || row.contextRecall < 1)
      .map(row => `${row.id}: expected ${row.expected.join(' | ')}, observed ${row.observed.join(' | ') || '(none)'}`)
    throw new Error(`${failures.join('\n')}\n${missed.join('\n')}`)
  }
}

async function main() {
  const jsonOnly = process.argv.includes('--json')
  const update = process.argv.includes('--update')
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
  const questions = JSON.parse(await readFile(QUESTIONS_PATH, 'utf8')).questions
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
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
  const report = {
    schemaVersion: 1,
    corpusDocuments: manifest.documents.length,
    questions: questions.length,
    primary: roundedMetrics(primary.metrics),
    multiQuery: roundedMetrics(multiQuery.metrics),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      rssBeforeBytes: rssBefore,
      rssAfterBytes: process.memoryUsage().rss,
    },
  }
  enforceThresholds('primary', primary, baseline.thresholds.primary)
  enforceThresholds('multiQuery', multiQuery, baseline.thresholds.multiQuery)

  if (update) {
    const next = {
      ...baseline,
      observed: {
        primary: Object.fromEntries(Object.entries(report.primary).filter(([key]) => !key.endsWith('Ms'))),
        multiQuery: Object.fromEntries(Object.entries(report.multiQuery).filter(([key]) => !key.endsWith('Ms'))),
      },
    }
    await writeFile(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  }
  if (jsonOnly) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`retrieval benchmark: ${report.corpusDocuments} documents, ${report.questions} questions`)
    for (const [name, metrics] of [['primary', report.primary], ['multi-query RRF', report.multiQuery]]) {
      console.log(`${name}: Hit@1 ${(metrics.hitAt1 * 100).toFixed(1)}% | Hit@3 ${(metrics.hitAt3 * 100).toFixed(1)}% | Recall@3 ${(metrics.recallAt3 * 100).toFixed(1)}% | MRR ${metrics.mrr.toFixed(3)} | Context Recall ${(metrics.contextRecall * 100).toFixed(1)}% | p50 ${metrics.p50Ms.toFixed(2)}ms | p95 ${metrics.p95Ms.toFixed(2)}ms`)
    }
    console.log(`RSS: ${(report.runtime.rssBeforeBytes / 1024 / 1024).toFixed(1)} MiB -> ${(report.runtime.rssAfterBytes / 1024 / 1024).toFixed(1)} MiB`)
    if (update) console.log('benchmark baseline observations updated')
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
