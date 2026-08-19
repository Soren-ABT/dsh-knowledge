#!/usr/bin/env node
/**
 * Retrieval quality evaluator for dsh-knowledge.
 *
 * Runs a set of real questions against the running knowledge service and
 * reports how often the expected documents surface in the top-K results —
 * the numbers you can watch change as you tune chunking, embeddings, rerank
 * or search mode.
 *
 * Usage:
 *   node scripts/eval-retrieval.mjs                       # default eval set
 *   node scripts/eval-retrieval.mjs --file my-questions.json
 *   node scripts/eval-retrieval.mjs --base <baseId> --topK 10
 *
 * Eval set format (JSON):
 * {
 *   "topK": 5,
 *   "questions": [
 *     { "query": "报销流程是什么", "baseId": "<optional>", "expect": ["报销流程.docx"] }
 *   ]
 * }
 * `expect` entries are matched against hit document titles by substring.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080'
const DEFAULT_SET = new URL('./eval-questions.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

async function get(path) {
  const res = await fetch(`${BASE_URL}/knowledge${path}`)
  const body = await res.json()
  if (!res.ok || body.ok !== true) throw new Error(`GET ${path}: ${body.error?.message ?? res.status}`)
  return body.value
}

async function search(query, baseId, topK, mode) {
  const res = await fetch(`${BASE_URL}/knowledge/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...(baseId ? { baseId } : {}), topK, ...(mode ? { mode } : {}) }),
  })
  const body = await res.json()
  if (!res.ok || body.ok !== true) throw new Error(`search "${query}": ${body.error?.message ?? res.status}`)
  return body.value
}

const setPath = resolve(arg('file', DEFAULT_SET))
if (!existsSync(setPath)) {
  console.error(`eval set not found: ${setPath}\nCopy scripts/eval-questions.example.json to scripts/eval-questions.json and fill in real questions.`)
  process.exit(1)
}
const set = JSON.parse(readFileSync(setPath, 'utf8'))
const defaultTopK = arg('topK', String(set.topK ?? 5))
const forceBase = arg('base', undefined)
const forceMode = arg('mode', undefined) // auto | hybrid | vector | lexical — compare modes on the same set

const bases = await get('/bases')
console.log(`knowledge bases: ${bases.map(b => `${b.name} (${b.id.slice(0, 8)}, ${b.chunkCount} chunks)`).join(' | ')}\n`)

const rows = []
let hitSum = 0
let recallNumerator = 0
let recallDenominator = 0
let mrrSum = 0

for (const question of set.questions) {
  const topK = Number(defaultTopK)
  const result = await search(question.query, forceBase ?? question.baseId, topK, forceMode)
  const titles = result.hits.map(hit => hit.documentTitle)
  const expected = question.expect ?? []
  const found = expected.filter(exp => titles.some(title => title.includes(exp)))
  const hit = found.length > 0
  const recall = expected.length > 0 ? found.length / expected.length : 0
  let mrr = 0
  for (let rank = 0; rank < result.hits.length; rank += 1) {
    if (expected.some(exp => result.hits[rank].documentTitle.includes(exp))) {
      mrr = 1 / (rank + 1)
      break
    }
  }
  hitSum += hit ? 1 : 0
  recallNumerator += found.length
  recallDenominator += expected.length
  mrrSum += mrr
  rows.push({ query: question.query, hit, recall, mrr, expected, found, topTitles: titles.slice(0, 3) })
}

console.log('── per question ────────────────────────────────────────────')
for (const row of rows) {
  const mark = row.hit ? '✓' : '✗'
  console.log(`${mark} "${row.query}"  recall=${row.recall.toFixed(2)} mrr=${row.mrr.toFixed(2)}`)
  console.log(`    expect: ${row.expected.join(' | ') || '(none)'}`)
  if (row.found.length > 0) console.log(`    found:  ${row.found.join(' | ')}`)
  else console.log(`    top:    ${row.topTitles.join(' | ') || '(no hits)'}`)
}

const n = rows.length
if (n === 0) {
  console.error('no questions in eval set — nothing to evaluate')
  process.exit(1)
}
console.log('── summary ────────────────────────────────────────────────')
console.log(`questions: ${n}${forceMode ? `  mode: ${forceMode}` : ''}${forceBase ? `  base: ${forceBase.slice(0, 8)}` : ''}`)
console.log(`Hit@${defaultTopK}   : ${(hitSum / n).toFixed(3)} (${hitSum}/${n} questions surfaced an expected doc)`)
console.log(`Recall@${defaultTopK}: ${recallDenominator > 0 ? (recallNumerator / recallDenominator).toFixed(3) : 'n/a'}`)
console.log(`MRR@${defaultTopK}   : ${(mrrSum / n).toFixed(3)}`)
