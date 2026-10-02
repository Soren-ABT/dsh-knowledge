#!/usr/bin/env node
// Opt-in real inference. Sends ONLY the generated public fixture below.
import assert from 'node:assert/strict'
import { extractWithMineruLocal, probeMineruLocal } from '../lib/knowledge/index.js'

const apiUrl = process.env.MINERU_SMOKE_URL
if (!apiUrl) throw new Error('Set MINERU_SMOKE_URL to your explicitly chosen MinerU 4 V1 service. No models are installed by this script.')
const tier = process.env.MINERU_SMOKE_TIER ?? 'basic'
if (!['flash', 'basic', 'standard', 'advanced'].includes(tier)) throw new Error('Unsupported MINERU_SMOKE_TIER')
const settings = { apiUrl, tier, apiKey: process.env.MINERU_SMOKE_API_KEY, timeoutMs: 30 * 60_000 }

function syntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const content = 'BT /F1 18 Tf 50 730 Td (Synthetic public evidence fixture) Tj 0 -36 Td /F1 12 Tf (Sample A has mass 42 kg.) Tj 0 -24 Td (Formula: E = mc^2 - 7.) Tj ET'
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

const capability = await probeMineruLocal(settings)
assert(capability.tiers.includes(tier), 'Requested tier must be advertised')
const start = performance.now()
const output = await extractWithMineruLocal(syntheticPdf(), 'synthetic-public-evidence.pdf', settings)
assert(output.document.blocks.length > 0, 'Expected source blocks')
assert(output.document.blocks.some(block => block.pageIndex === 0 && /42\s*kg/.test(block.text)), 'Exact quantity, unit and page provenance must survive')
assert(output.document.text.includes('- 7') || output.document.text.includes('-7'), 'The negative term must survive')
for (const block of output.document.blocks) assert.equal(output.document.text.slice(block.textStart, block.textEnd), block.text)
console.log(JSON.stringify({ status: 'passed', version: capability.version, tier, elapsedMs: Math.round(performance.now() - start), completeness: output.document.completeness, blockCount: output.document.blocks.length }))
// A pass establishes compatibility with this fixture/tier, not general OCR quality.
