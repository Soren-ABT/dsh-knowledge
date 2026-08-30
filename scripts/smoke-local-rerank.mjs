#!/usr/bin/env node

import { fork } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PROTOCOL_VERSION = 1
const MODEL = 'Xenova/bge-reranker-base'
const cacheRoot = process.env.DSH_HOME?.trim()
  ? join(resolve(process.env.DSH_HOME), 'cache', 'dsh-knowledge', 'local-models')
  : join(homedir(), '.dsh', 'cache', 'dsh-knowledge', 'local-models')
const childPath = resolve('lib/knowledge/rerank-process.mjs')

function runSelfTest(label) {
  return new Promise((resolvePromise, reject) => {
    const child = fork(childPath, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${label} timed out`))
    }, 15 * 60_000)
    child.on('message', message => {
      if (message?.event === 'progress' && message.status === 'downloading') {
        process.stdout.write(`\r${label}: downloading ${Math.floor(message.progress ?? 0)}%`)
        return
      }
      if (message?.id !== 1) return
      clearTimeout(timer)
      if (message.ok !== true || message.operation !== 'self_test') {
        child.kill('SIGKILL')
        reject(new Error(message?.error?.message ?? `${label} returned an invalid response`))
        return
      }
      const health = message.health
      if (!Array.isArray(health?.scores) || health.scores.length !== 2
        || !health.scores.every(Number.isFinite) || !(health.scores[0] > health.scores[1])) {
        child.kill('SIGKILL')
        reject(new Error(`${label} returned invalid/non-discriminating scores`))
        return
      }
      child.kill('SIGKILL')
      process.stdout.write(`\r${label}: ok (${health.latencyMs}ms, scores ${health.scores.map(score => score.toFixed(4)).join(' > ')})\n`)
      resolvePromise(health)
    })
    child.on('error', reject)
    child.send({
      protocolVersion: PROTOCOL_VERSION,
      id: 1,
      operation: 'self_test',
      modelId: MODEL,
      cacheDir: cacheRoot,
      ...(process.env.HF_ENDPOINT ? { hfEndpoint: process.env.HF_ENDPOINT } : {}),
    })
  })
}

await runSelfTest('initial local rerank process')
await runSelfTest('fresh process recovery')
console.log(`local rerank smoke passed on ${process.platform}/${process.arch} Node ${process.version}`)
