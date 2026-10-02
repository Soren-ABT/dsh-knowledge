#!/usr/bin/env node
/**
 * Worker-bundle protocol smoke: prove that every emitted companion bundle
 * actually LOADS and answers on its own wire protocol.
 *
 * Why this exists: `verify-package.mjs` only checks that these files are present
 * in the tarball, and vitest runs `src/`, where three of the four companion files
 * do not exist (their `.ts` sources are compiled to `lib/` only). The real child
 * implementations — `embed-worker.ts` (bundled into `embed-process.mjs`),
 * `rerank-process.ts`, `ocr-process.ts` — were therefore executed by NO test and
 * NO gate, so a bundle that cannot start shipped green.
 *
 * Every request below is local and returns immediately (`release`/`dispose`/
 * `shutdown`, or a parse that just fails); nothing downloads a model and no
 * network is used.
 *
 * Usage: node scripts/smoke-worker-protocol.mjs   (run after a build)
 */
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(ROOT, 'lib', 'knowledge')
const PROTOCOL_VERSION = 1
const STEP_TIMEOUT_MS = 30_000
const WATCHDOG_MS = 120_000

// A bundle that hangs must fail the gate rather than stall CI forever.
const watchdog = setTimeout(() => {
  console.error(`worker protocol smoke FAILED: no result within ${WATCHDOG_MS / 1000}s`)
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

const failures = []
const results = []

function record(name, detail) {
  results.push(`${name}: ${detail}`)
}

function fail(name, detail) {
  failures.push(`${name}: ${detail}`)
  results.push(`${name}: FAILED — ${detail}`)
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/** Wait for the next IPC message, or reject on timeout / early exit. */
function nextMessage(port, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => { cleanup(); rejectPromise(new Error(`${label}: no reply within ${STEP_TIMEOUT_MS / 1000}s`)) }, STEP_TIMEOUT_MS)
    const onMessage = message => { cleanup(); resolvePromise(message) }
    const onError = error => { cleanup(); rejectPromise(error) }
    const onExit = code => { cleanup(); rejectPromise(new Error(`${label}: exited early with code ${code}`)) }
    function cleanup() {
      clearTimeout(timer)
      port.off('message', onMessage)
      port.off('error', onError)
      port.off('exit', onExit)
    }
    port.on('message', onMessage)
    port.on('error', onError)
    port.on('exit', onExit)
  })
}

/** Fork one child-process bundle: one local round trip, then a clean shutdown. */
async function smokeForkedBundle({ name, file, probe }) {
  const child = fork(join(LIB, file), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced', windowsHide: true })
  try {
    const replyPromise = nextMessage(child, `${name} ${probe.operation}`)
    child.send(probe)
    const reply = await replyPromise
    if (reply === null || typeof reply !== 'object') {
      fail(name, `reply was not an object: ${JSON.stringify(reply)}`)
      return
    }
    if (reply.protocolVersion !== PROTOCOL_VERSION) {
      fail(name, `protocolVersion was ${String(reply.protocolVersion)}, expected ${PROTOCOL_VERSION}`)
      return
    }
    if (reply.id !== probe.id || reply.operation !== probe.operation) {
      fail(name, `reply did not echo the request (id=${String(reply.id)}, operation=${String(reply.operation)})`)
      return
    }
    if (reply.ok !== true) {
      fail(name, `a local ${probe.operation} should succeed, got ok=false${reply.error?.code !== undefined ? ` (${reply.error.code})` : ''}`)
      return
    }

    // The child must SURVIVE the probe (the host keeps it alive on purpose), and
    // then exit cleanly when asked to shut down.
    const exit = new Promise(resolvePromise => child.once('exit', code => resolvePromise(code)))
    child.send({ protocolVersion: PROTOCOL_VERSION, id: probe.id + 1, operation: 'shutdown', modelId: probe.modelId, cacheDir: probe.cacheDir })
    const code = await Promise.race([exit, delay(STEP_TIMEOUT_MS).then(() => 'timeout')])
    if (code !== 0) {
      fail(name, `did not exit cleanly on shutdown (${String(code)})`)
      return
    }
    record(name, `answered ${probe.operation}, survived, and exited 0 on shutdown`)
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
    child.kill('SIGKILL')
  }
}

/** Start one worker-thread bundle, optionally exchange one request, then require
 *  a clean exit. */
async function smokeWorkerBundle({ name, file, probe, expectReply }) {
  const worker = new Worker(join(LIB, file))
  try {
    if (probe !== undefined) {
      const replyPromise = nextMessage(worker, `${name} probe`)
      worker.postMessage(probe)
      const reply = await replyPromise
      if (!expectReply(reply)) {
        fail(name, `probe reply was unexpected: ${JSON.stringify(reply)}`)
        return
      }
    }
    const exit = new Promise(resolvePromise => worker.once('exit', code => resolvePromise(code)))
    worker.postMessage({ type: 'shutdown' })
    const code = await Promise.race([exit, delay(STEP_TIMEOUT_MS).then(() => 'timeout')])
    if (code !== 0) {
      fail(name, `did not exit cleanly on shutdown (${String(code)})`)
      return
    }
    record(name, probe === undefined
      ? 'loaded and exited 0 on shutdown'
      : 'loaded, answered its probe, and exited 0 on shutdown')
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error))
    void worker.terminate()
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-worker-smoke-'))
try {
  await smokeForkedBundle({
    name: 'embed-process.mjs',
    file: 'embed-process.mjs',
    // `release` disposes a model's runners and returns immediately: no load, no
    // download. It proves the bundle loaded, parsed the envelope, accepted the
    // protocol version, and stayed alive.
    probe: { protocolVersion: PROTOCOL_VERSION, id: 1, operation: 'release', modelId: 'dsh-smoke/absent', cacheDir: tmp },
  })
  await smokeForkedBundle({
    name: 'rerank-process.mjs',
    file: 'rerank-process.mjs',
    probe: { protocolVersion: PROTOCOL_VERSION, id: 1, operation: 'dispose', modelId: 'dsh-smoke/absent', cacheDir: tmp },
  })
  await smokeWorkerBundle({
    name: 'pdf-parse-worker.mjs',
    file: 'pdf-parse-worker.mjs',
    // A well-formed request whose payload is not a PDF: the worker must answer
    // with a structured failure and stay alive, which is the containment the host
    // relies on (its stray rejections must not reach the host process).
    probe: { id: 1, data: new Uint8Array(Buffer.from('this is not a pdf at all %%%')) },
    expectReply: reply => reply?.id === 1 && reply?.ok === false && typeof reply?.error === 'string',
  })
  await smokeForkedBundle({
    name: 'ocr-process.mjs',
    file: 'ocr-process.mjs',
    // Probe without importing native inference libraries or downloading models.
    probe: { protocolVersion: PROTOCOL_VERSION, id: 1, operation: 'status' },
  })
} finally {
  clearTimeout(watchdog)
  rmSync(tmp, { recursive: true, force: true })
}

for (const line of results) console.log(`  ${line}`)
if (failures.length > 0) {
  console.error(`\nworker protocol smoke FAILED (${failures.length}):`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log(`\nworker protocol smoke passed for ${results.length} bundle(s)`)
}
