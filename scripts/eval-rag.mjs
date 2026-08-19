#!/usr/bin/env node
/**
 * RAG-style evaluation for dsh-knowledge — retrieval quality against golden
 * answers, computed locally (no LLM needed):
 *
 * - Hit@k: how often the expected document surfaces in the top-K results
 *   (`expect` titles matched by substring, as in eval-retrieval.mjs).
 * - Context Recall (RAGAS-style approximation): the fraction of the golden
 *   answer's sentences covered by the retrieved context (normalized
 *   substring match against the top-K hit texts). Higher = the retrieved
 *   chunks actually carry the answer's content.
 * - Context Precision (approximation): mean reciprocal rank of the expected
 *   documents among the hits — how early the relevant source appears.
 *
 * A full RAGAS suite (answer faithfulness, completeness via an LLM judge)
 * needs a chat model; this script stays dependency-free and focuses on the
 * retrieval half, which is what chunking/embedding/rerank changes affect.
 *
 * Usage:
 *   node scripts/eval-rag.mjs --file rag-set.json --base <baseId> --topK 5
 *
 * Eval set format (JSON):
 * {
 *   "topK": 5,
 *   "questions": [
 *     {
 *       "query": "什么是马尔可夫链的转移概率?",
 *       "groundTruth": "从状态 i 到状态 j 的概率记为 p_ij…",
 *       "expect": ["马尔科夫链模型.pdf"],
 *       "baseId": "<optional>"
 *     }
 *   ]
 * }
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

async function search(query, baseId, topK) {
  const res = await fetch(`${BASE_URL}/knowledge/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...(baseId ? { baseId } : {}), topK }),
  })
  const body = await res.json()
  if (!res.ok || body.ok !== true) throw new Error(`search "${query}": ${body.error?.message ?? res.status}`)
  return body.value
}

/** Sentence-level splitting for CJK + latin text. */
function sentences(text) {
  return text
    .split(/[。！？!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/** Strip whitespace + punctuation + symbols for lenient matching. */
function normalize(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
}

/** Fraction of golden sentences covered by the retrieved context. */
function contextRecall(groundTruth, hits) {
  const context = normalize(hits.map(hit => `${hit.text ?? ''} ${hit.siblingContext ?? ''}`).join(' '))
  const total = sentences(groundTruth)
  if (total.length === 0) return 0
  let covered = 0
  for (const sentence of total) {
    const key = normalize(sentence)
    // Short fragments are unreliable for substring matching — require a
    // minimum of 4 normalized chars.
    if (key.length >= 4 && context.includes(key)) covered += 1
  }
  return covered / total.length
}

async function main() {
  const setPath = resolve(arg('file', ''))
  if (!existsSync(setPath)) {
    console.error(`eval set not found: ${setPath}\nUsage: node scripts/eval-rag.mjs --file rag-set.json --base <baseId>`)
    process.exit(1)
  }
  const set = JSON.parse(readFileSync(setPath, 'utf8'))
  const defaultTopK = Number(arg('topK', String(set.topK ?? 5)))
  const forceBase = arg('base', undefined)

  const rows = []
  for (const question of set.questions) {
    const baseId = forceBase ?? question.baseId
    const result = await search(question.query, baseId, defaultTopK)
    const hits = result.hits ?? []
    const expected = question.expect ?? []
    const matched = hits.filter(hit => expected.some(title => hit.documentTitle.includes(title)))
    const hitAtK = matched.length > 0 ? 1 : 0
    const firstRank = matched.length > 0 ? hits.findIndex(hit => expected.some(title => hit.documentTitle.includes(title))) + 1 : 0
    const recall = question.groundTruth !== undefined && question.groundTruth.trim() !== ''
      ? contextRecall(question.groundTruth, hits)
      : undefined
    rows.push({
      query: question.query.slice(0, 40),
      hitAtK,
      firstRank,
      contextRecall: recall,
      hits: hits.length,
    })
  }

  if (rows.length === 0) {
    console.error('no questions in eval set — nothing to evaluate')
    process.exit(1)
  }
  const hitRate = rows.reduce((sum, row) => sum + row.hitAtK, 0) / rows.length
  const meanRecall = rows.filter(row => row.contextRecall !== undefined)
  const avgRecall = meanRecall.length > 0
    ? meanRecall.reduce((sum, row) => sum + row.contextRecall, 0) / meanRecall.length
    : undefined
  const ranked = rows.filter(row => row.firstRank > 0)
  const mrr = ranked.length > 0
    ? ranked.reduce((sum, row) => sum + 1 / row.firstRank, 0) / rows.length
    : 0

  console.log(`\nRAG evaluation — ${rows.length} question(s), topK ${defaultTopK} (${BASE_URL})\n`)
  for (const row of rows) {
    console.log(
      `  ${row.hitAtK ? '✓' : '✗'} ${row.query}`
      + `  rank=${row.firstRank || '—'}`
      + (row.contextRecall !== undefined ? `  contextRecall=${row.contextRecall.toFixed(2)}` : ''),
    )
  }
  console.log(`\n  Hit@k:        ${(hitRate * 100).toFixed(1)}%`)
  if (avgRecall !== undefined) console.log(`  Context Recall: ${(avgRecall * 100).toFixed(1)}% (sentence coverage)`)
  console.log(`  MRR (expect): ${mrr.toFixed(3)}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
