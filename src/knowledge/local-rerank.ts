/** Parent-side lifecycle, queue, timeout, and circuit breaker for local reranking. */

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  LOCAL_RERANK_PROTOCOL_VERSION,
  isProgressEvent,
  isResponseEnvelope,
  type LocalRerankOperation,
  type LocalRerankProgressEvent,
  type LocalRerankRequest,
  type LocalRerankResponse,
} from './rerank-protocol.js'

export type LocalRerankFailureCode =
  | 'model_not_downloaded'
  | 'model_checking'
  | 'model_unhealthy'
  | 'unsupported_model'
  | 'timeout'
  | 'invalid_response'
  | 'runtime_error'
  | 'process_crash'
  | 'circuit_open'
  | 'busy'

export class LocalRerankError extends Error {
  constructor(
    readonly code: LocalRerankFailureCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'LocalRerankError'
  }
}

export interface LocalRerankHealthReport {
  healthy: true
  latencyMs: number
  scores: number[]
  batchSize: number
}

interface QueueEntry {
  id: number
  operation: LocalRerankOperation
  modelId: string
  request: LocalRerankRequest
  deadline: number
  timer: ReturnType<typeof setTimeout>
  resolve(value: unknown): void
  reject(error: Error): void
}

interface CircuitState {
  failures: number
  openUntil: number
  halfOpenProbe: boolean
}

const MAX_QUEUE_SIZE = 16
const CIRCUIT_FAILURE_LIMIT = 3
const CIRCUIT_COOLDOWN_MS = 5 * 60_000
const circuits = new Map<string, CircuitState>()
let rerankIdleTimeoutMs = 60_000
let child: ChildProcess | null = null
let active: QueueEntry | null = null
let queue: QueueEntry[] = []
let requestSequence = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
let intentionalExit = false
let progressListener: ((event: LocalRerankProgressEvent) => void) | undefined

function processPath(): string {
  return fileURLToPath(new URL('./rerank-process.mjs', import.meta.url))
}

function clearIdleTimer(): void {
  if (idleTimer !== null) clearTimeout(idleTimer)
  idleTimer = null
}

function armIdleTimer(): void {
  clearIdleTimer()
  if (rerankIdleTimeoutMs <= 0 || active !== null || queue.length > 0 || child === null) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    terminateChild()
  }, rerankIdleTimeoutMs)
  idleTimer.unref?.()
}

function normalizeChildError(response: Extract<LocalRerankResponse, { ok: false }>): LocalRerankError {
  const supported: LocalRerankFailureCode[] = ['invalid_response', 'runtime_error']
  const code = supported.includes(response.error.code as LocalRerankFailureCode)
    ? response.error.code as LocalRerankFailureCode
    : 'runtime_error'
  return new LocalRerankError(code, response.error.message, response.error.retryable)
}

function validateSuccess(entry: QueueEntry, response: Extract<LocalRerankResponse, { ok: true }>): unknown {
  if (response.operation !== entry.operation) {
    throw new LocalRerankError('invalid_response', `local rerank response operation mismatch: expected ${entry.operation}, received ${response.operation}`, false)
  }
  if (response.operation === 'rerank') {
    if (!Array.isArray(response.scores) || response.scores.some(score => typeof score !== 'number' || !Number.isFinite(score))) {
      throw new LocalRerankError('invalid_response', 'local rerank response contained invalid scores', false)
    }
    const expected = entry.request.operation === 'rerank' ? entry.request.texts.length : -1
    if (response.scores.length !== expected) {
      throw new LocalRerankError('invalid_response', `local rerank score count mismatch: expected ${expected}, received ${response.scores.length}`, false)
    }
    return response.scores
  }
  if (response.operation === 'self_test') {
    const health = response.health
    if (health?.healthy !== true || !Number.isFinite(health.latencyMs) || !Array.isArray(health.scores)
      || health.scores.length !== 2 || health.scores.some(score => !Number.isFinite(score))) {
      throw new LocalRerankError('invalid_response', 'local rerank self-test returned an invalid health report', false)
    }
    return health
  }
  return undefined
}

function finishActive(error: Error | undefined, value?: unknown): void {
  const entry = active
  if (entry === null) return
  active = null
  clearTimeout(entry.timer)
  if (error !== undefined) entry.reject(error)
  else entry.resolve(value)
  queueMicrotask(pump)
}

function onMessage(message: unknown): void {
  if (isProgressEvent(message)) {
    progressListener?.(message)
    return
  }
  const entry = active
  if (entry === null) return
  if (!isResponseEnvelope(message)) {
    finishActive(new LocalRerankError('invalid_response', 'local rerank process returned an invalid response envelope', false))
    terminateChild()
    return
  }
  // A response may arrive after its caller timed out and the next request was
  // dispatched. It belongs to the old id and must never poison the new one.
  if (message.id !== entry.id) return
  if (message.ok === false) {
    finishActive(normalizeChildError(message))
    return
  }
  try {
    finishActive(undefined, validateSuccess(entry, message))
  } catch (error) {
    finishActive(error instanceof Error ? error : new Error(String(error)))
    terminateChild()
  }
}

function spawnChild(): ChildProcess {
  if (child !== null) return child
  intentionalExit = false
  const spawned = fork(processPath(), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    // Host-only eval/test/debug flags can make a file-based fork fail or make
    // every rerank child fight for the same inspector port.
    execArgv: process.execArgv.filter(argument =>
      argument !== '--test'
      && !argument.startsWith('--input-type')
      && !argument.startsWith('--inspect')),
  })
  spawned.on('message', onMessage)
  spawned.on('error', error => {
    if (child !== spawned || intentionalExit) return
    child = null
    finishActive(new LocalRerankError('process_crash', `local rerank process failed: ${error.message}`, true))
  })
  spawned.on('exit', (code, signal) => {
    if (child !== spawned) return
    child = null
    clearIdleTimer()
    if (!intentionalExit && active !== null) {
      finishActive(new LocalRerankError('process_crash', `local rerank process exited (${signal ?? code ?? 'unknown'})`, true))
    }
    intentionalExit = false
  })
  child = spawned
  return spawned
}

function terminateChild(): void {
  clearIdleTimer()
  const running = child
  child = null
  if (running === null) return
  intentionalExit = true
  running.removeListener('message', onMessage)
  running.kill('SIGKILL')
}

function pump(): void {
  if (active !== null) return
  while (queue.length > 0) {
    const next = queue.shift()!
    if (Date.now() >= next.deadline) {
      clearTimeout(next.timer)
      next.reject(new LocalRerankError('timeout', 'local rerank request timed out while queued', true))
      continue
    }
    active = next
    clearIdleTimer()
    try {
      spawnChild().send(next.request)
    } catch (error) {
      finishActive(new LocalRerankError('process_crash', error instanceof Error ? error.message : String(error), true))
      terminateChild()
    }
    return
  }
  armIdleTimer()
}

function callProcess(
  operation: LocalRerankOperation,
  modelId: string,
  cacheDir: string,
  hfEndpoint: string | undefined,
  timeoutMs: number,
  input?: { query: string; texts: string[] },
): Promise<unknown> {
  if ((active === null ? 0 : 1) + queue.length >= MAX_QUEUE_SIZE) {
    return Promise.reject(new LocalRerankError('busy', 'local rerank queue is full', true))
  }
  const id = ++requestSequence
  const base = { protocolVersion: LOCAL_RERANK_PROTOCOL_VERSION, id, operation, modelId, cacheDir, hfEndpoint }
  const request = operation === 'rerank'
    ? { ...base, operation, query: input?.query ?? '', texts: input?.texts ?? [] } as LocalRerankRequest
    : { ...base, operation } as LocalRerankRequest
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const entry = {} as QueueEntry
    const timer = setTimeout(() => {
      if (active === entry) {
        active = null
        reject(new LocalRerankError('timeout', 'local rerank inference timed out', true))
        terminateChild()
        queueMicrotask(pump)
        return
      }
      const index = queue.indexOf(entry)
      if (index >= 0) queue.splice(index, 1)
      reject(new LocalRerankError('timeout', 'local rerank request timed out while queued', true))
    }, timeoutMs)
    timer.unref?.()
    Object.assign(entry, { id, operation, modelId, request, deadline, timer, resolve, reject })
    queue.push(entry)
    pump()
  })
}

function circuitFor(modelId: string): CircuitState {
  const existing = circuits.get(modelId)
  if (existing !== undefined) return existing
  const created = { failures: 0, openUntil: 0, halfOpenProbe: false }
  circuits.set(modelId, created)
  return created
}

function enterCircuit(modelId: string): void {
  const state = circuitFor(modelId)
  const now = Date.now()
  if (state.openUntil > now) throw new LocalRerankError('circuit_open', 'local rerank is temporarily disabled after repeated failures', true)
  if (state.openUntil > 0) {
    if (state.halfOpenProbe) throw new LocalRerankError('circuit_open', 'local rerank recovery probe is already running', true)
    state.halfOpenProbe = true
  }
}

function circuitSuccess(modelId: string): void {
  circuits.set(modelId, { failures: 0, openUntil: 0, halfOpenProbe: false })
}

function circuitFailure(modelId: string, error: unknown): void {
  const state = circuitFor(modelId)
  state.halfOpenProbe = false
  if (!(error instanceof LocalRerankError) || !['timeout', 'process_crash', 'runtime_error', 'invalid_response'].includes(error.code)) return
  state.failures += 1
  if (state.failures >= CIRCUIT_FAILURE_LIMIT) state.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS
}

export function setLocalRerankIdleTimeoutMs(ms: number): void {
  rerankIdleTimeoutMs = Number.isFinite(ms) && ms >= 0 ? Math.trunc(ms) : 60_000
  armIdleTimer()
}

export function setLocalRerankProgressListener(listener: ((event: LocalRerankProgressEvent) => void) | undefined): void {
  progressListener = listener
}

export async function rerankInLocalProcess(
  modelId: string,
  cacheDir: string,
  hfEndpoint: string | undefined,
  query: string,
  texts: readonly string[],
  timeoutMs: number,
): Promise<number[]> {
  enterCircuit(modelId)
  try {
    const scores = await callProcess('rerank', modelId, cacheDir, hfEndpoint, timeoutMs, { query, texts: [...texts] }) as number[]
    circuitSuccess(modelId)
    return scores
  } catch (error) {
    circuitFailure(modelId, error)
    throw error
  }
}

export async function loadLocalReranker(modelId: string, cacheDir: string, hfEndpoint?: string): Promise<void> {
  await callProcess('load', modelId, cacheDir, hfEndpoint, 30 * 60_000)
}

export async function selfTestLocalReranker(modelId: string, cacheDir: string, hfEndpoint?: string): Promise<LocalRerankHealthReport> {
  const health = await callProcess('self_test', modelId, cacheDir, hfEndpoint, 5 * 60_000) as LocalRerankHealthReport
  circuitSuccess(modelId)
  return health
}

export async function releaseLocalReranker(modelId: string, cacheDir: string, hfEndpoint?: string): Promise<void> {
  if (child === null) return
  await callProcess('dispose', modelId, cacheDir, hfEndpoint, 3000).catch(() => {})
}

export async function cancelLocalReranker(modelId: string): Promise<void> {
  const cancelled = new LocalRerankError('runtime_error', 'local rerank operation cancelled', true)
  queue = queue.filter(entry => {
    if (entry.modelId !== modelId) return true
    clearTimeout(entry.timer)
    entry.reject(cancelled)
    return false
  })
  if (active?.modelId === modelId) {
    const entry = active
    active = null
    clearTimeout(entry.timer)
    entry.reject(cancelled)
    terminateChild()
    queueMicrotask(pump)
  }
}

export async function disposeLocalRerankProcess(): Promise<void> {
  clearIdleTimer()
  const error = new LocalRerankError('process_crash', 'local rerank process disposed', true)
  if (active !== null) {
    clearTimeout(active.timer)
    active.reject(error)
    active = null
  }
  for (const entry of queue) {
    clearTimeout(entry.timer)
    entry.reject(error)
  }
  queue = []
  terminateChild()
}

/** Test-only visibility without exposing process handles. */
export function localRerankRuntimeSnapshot(): { active: boolean; queued: number; process: boolean } {
  return { active: active !== null, queued: queue.length, process: child !== null }
}
