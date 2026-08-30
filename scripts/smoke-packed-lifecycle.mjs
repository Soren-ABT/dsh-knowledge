import { spawn, spawnSync } from 'node:child_process'

const DEFAULT_TERMINATION_GRACE_MS = 5_000

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    let timer
    const finish = (exited) => {
      if (timer !== undefined) clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once('exit', onExit)
    timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
  })
}

/** Terminate only the process tree rooted at a child this runner spawned. */
export async function terminateProcessTree(child, graceMs = DEFAULT_TERMINATION_GRACE_MS) {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await waitForExit(child, graceMs)
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch {}
  }
  if (await waitForExit(child, graceMs)) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
  }
  await waitForExit(child, Math.min(graceMs, 1_000))
}

/**
 * Run a command with a total deadline and deterministic process-tree cleanup.
 * Dependency injection keeps the lifecycle races independently testable.
 */
export function runSupervised(executable, args, options) {
  const {
    timeoutMs,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    spawnImpl = spawn,
    terminateTree = terminateProcessTree,
    ...spawnOptions
  } = options
  return new Promise(resolve => {
    let settled = false
    let timedOut = false
    let timeout
    const child = spawnImpl(executable, args, {
      ...spawnOptions,
      detached: process.platform !== 'win32',
      shell: process.platform === 'win32' && executable.endsWith('.cmd'),
    })
    const finish = outcome => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      resolve(outcome)
    }
    child.once('error', error => finish({ kind: 'spawn_error', error }))
    child.once('exit', (code, signal) => {
      if (timedOut) finish({ kind: 'timed_out' })
      else finish({ kind: 'exited', code, signal })
    })
    timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      void Promise.resolve(terminateTree(child, terminationGraceMs))
        .then(() => finish({ kind: 'timed_out' }))
        .catch(error => finish({ kind: 'spawn_error', error }))
    }, timeoutMs)
    timeout.unref?.()
  })
}

/** Apply the authoritative manifest-based verdict after uninstall cleanup. */
export function verifyUninstallOutcome(outcome, profilePackage, options = {}) {
  const { strictBundleCleanup = false } = options
  if (outcome.kind === 'spawn_error') throw outcome.error
  const dependencyPresent = profilePackage.dependencies?.['dsh-knowledge'] !== undefined
  const bundlePresent = profilePackage.dsh?.profile?.bundles?.includes('dsh-knowledge') === true
  if (dependencyPresent) throw new Error('official DSH remove left dsh-knowledge in the profile package')
  if (outcome.kind === 'exited' && outcome.code !== 0) {
    throw new Error(`official DSH remove exited unsuccessfully (${outcome.code ?? outcome.signal ?? 'unknown'})`)
  }
  if (bundlePresent) {
    if (outcome.kind !== 'timed_out' || strictBundleCleanup) {
      throw new Error('official DSH remove left dsh-knowledge in the profile bundle stack')
    }
    return 'official DSH remove timed out after removing the package dependency but before reconciling the profile bundle stack; this is a known upstream DSH CLI cleanup issue and the temporary profile will be discarded'
  }
  if (outcome.kind === 'timed_out') {
    return 'official DSH remove timed out after updating the profile; the process tree was reclaimed and the on-disk uninstall state was verified'
  }
  return undefined
}

/** Format one-line local output or a native GitHub Actions warning annotation. */
export function formatUninstallWarning(message, options = {}) {
  const { githubActions = false } = options
  const oneLine = String(message).replace(/[\r\n]+/g, ' ').trim()
  if (!githubActions) return oneLine
  const escaped = oneLine.replace(/%/g, '%25')
  return `::warning title=DSH uninstall reconciliation::${escaped}`
}
