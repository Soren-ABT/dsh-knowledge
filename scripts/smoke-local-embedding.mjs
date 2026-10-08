#!/usr/bin/env node

import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PROTOCOL_VERSION = 1
const MODEL = 'Xenova/bge-small-en-v1.5'
const childPath = resolve('lib/knowledge/embed-process.mjs')
const cacheRoot = await mkdtemp(join(tmpdir(), 'dsh-local-embedding-smoke-'))
const children = new Set()
const probeTexts = [
  'How is an expense reimbursement approved?',
  'The reimbursement workflow requires an invoice and approval.',
  'A completely unrelated sentence about rainy weather.',
]

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('embedding smoke child did not exit')), 10_000)
    child.once('exit', () => { clearTimeout(timer); resolvePromise() })
    child.kill('SIGKILL')
  })
}

function assertVectors(vectors, expected) {
  if (!Array.isArray(vectors) || vectors.length !== expected || vectors.some(vector => !Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(value)))) {
    throw new Error('embedding process returned invalid vectors')
  }
  const dimensions = vectors[0].length
  if (vectors.some(vector => vector.length !== dimensions)) throw new Error('embedding process returned inconsistent dimensions')
  if (dimensions !== 384) throw new Error(`BGE Small returned ${dimensions} dimensions instead of 384`)
  if (vectors.some(vector => Math.abs(Math.hypot(...vector) - 1) > 1e-4)) {
    throw new Error('embedding process returned vectors that are not L2-normalized')
  }
  return dimensions
}

function start(label) {
  const child = fork(childPath, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] })
  children.add(child)
  child.once('exit', () => children.delete(child))
  let sequence = 0
  const call = (operation, texts) => new Promise((resolvePromise, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${label} ${operation} timed out`))
    }, 15 * 60_000)
    child.on('message', function onMessage(message) {
      if (message?.type === 'progress' && message.status === 'downloading') {
        process.stdout.write(`\r${label}: downloading ${Math.floor(message.progress ?? 0)}%`)
        return
      }
      if (message?.id !== id) return
      child.removeListener('message', onMessage)
      clearTimeout(timer)
      if (message?.protocolVersion !== PROTOCOL_VERSION || message?.operation !== operation || message?.ok !== true) {
        reject(new Error(message?.error?.message ?? `${label} ${operation} returned an invalid response`))
        return
      }
      resolvePromise(message.vectors)
    })
    child.send({
      protocolVersion: PROTOCOL_VERSION,
      id,
      operation,
      modelId: MODEL,
      cacheDir: cacheRoot,
      ...(texts === undefined ? {} : { texts, pooling: 'cls' }),
      ...(process.env.HF_ENDPOINT ? { hfEndpoint: process.env.HF_ENDPOINT } : {}),
    })
  })
  return { child, call }
}

try {
  const first = start('initial embedding process')
  await first.call('download')
  const initialVectors = await first.call('embed', probeTexts)
  const dimensions = assertVectors(initialVectors, 3)
  const similarity = vector => initialVectors[0].reduce((sum, value, index) => sum + value * vector[index], 0)
  if (similarity(initialVectors[1]) <= similarity(initialVectors[2])) {
    throw new Error('embedding model did not rank the related document above the unrelated document')
  }
  await stop(first.child)

  const recovered = start('fresh embedding process recovery')
  await recovered.call('load')
  const recoveredVectors = await recovered.call('embed', probeTexts)
  if (assertVectors(recoveredVectors, 3) !== dimensions) throw new Error('recovered process changed embedding dimensions')
  if (initialVectors.some((vector, row) => vector.some((value, column) => Math.abs(value - recoveredVectors[row][column]) > 1e-4))) {
    throw new Error('cached model inference changed after process recovery')
  }
  await stop(recovered.child)
  console.log(`\nlocal embedding smoke passed on ${process.platform}/${process.arch} Node ${process.version} (${dimensions} dimensions)`)
} finally {
  await Promise.all([...children].map(stop))
  await rm(cacheRoot, { recursive: true, force: true })
}
