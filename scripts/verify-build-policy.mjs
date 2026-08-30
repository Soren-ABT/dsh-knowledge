#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_DECISIONS = new Map([
  ['esbuild', true],
  ['onnxruntime-node', true],
  ['protobufjs', true],
  ['sharp', true],
  ['tesseract.js', false],
])

/** Validate the top-level allowBuilds map without relying on installed packages. */
export function evaluateBuildPolicy(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^allowBuilds:\s*(?:#.*)?$/.test(line))
  if (headings.length !== 1) {
    return { ok: false, errors: [`expected exactly one top-level allowBuilds mapping, found ${headings.length}`] }
  }

  const decisions = new Map()
  const errors = []
  for (let index = headings[0].index + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(?:#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break
    const entry = line.match(/^\s+([^:#]+):\s*(.*?)\s*$/)
    if (entry === null) {
      errors.push(`line ${index + 1}: allowBuilds entries must use "package: true|false"`)
      continue
    }
    const name = entry[1].trim()
    const rawValue = entry[2].replace(/\s+#.*$/, '').trim()
    if (decisions.has(name)) {
      errors.push(`line ${index + 1}: duplicate allowBuilds decision for ${name}`)
      continue
    }
    if (rawValue !== 'true' && rawValue !== 'false') {
      errors.push(`line ${index + 1}: allowBuilds.${name} must be true or false, found ${JSON.stringify(rawValue)}`)
      continue
    }
    decisions.set(name, rawValue === 'true')
  }

  for (const [name, expected] of EXPECTED_DECISIONS) {
    if (!decisions.has(name)) {
      errors.push(`allowBuilds.${name} must have an explicit ${expected} decision`)
    } else if (decisions.get(name) !== expected) {
      errors.push(`allowBuilds.${name} must be ${expected}, found ${decisions.get(name)}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

function selfTest() {
  const valid = `allowBuilds:
  esbuild: true
  onnxruntime-node: true
  protobufjs: true
  sharp: true
  tesseract.js: false
`
  assert.equal(evaluateBuildPolicy(valid).ok, true)
  assert.equal(evaluateBuildPolicy(valid.replace('esbuild: true', 'esbuild: set this to true or false')).ok, false)
  assert.equal(evaluateBuildPolicy(valid.replace('  sharp: true\n', '')).ok, false)
  assert.equal(evaluateBuildPolicy(valid.replace('tesseract.js: false', 'tesseract.js: true')).ok, false)
  assert.equal(evaluateBuildPolicy(`${valid}\nallowBuilds:\n  esbuild: true\n`).ok, false)
  console.log('workspace build policy self-test passed')
}

function verifyFile() {
  const path = resolve('pnpm-workspace.yaml')
  const decision = evaluateBuildPolicy(readFileSync(path, 'utf8'))
  if (!decision.ok) throw new Error(decision.errors.join('\n'))
  console.log(`workspace build policy verified (${EXPECTED_DECISIONS.size} explicit decisions)`)
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  try {
    if (process.argv.includes('--self-test')) selfTest()
    else verifyFile()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
