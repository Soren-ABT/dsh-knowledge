#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const SEVERITIES = Object.freeze(['info', 'low', 'moderate', 'high', 'critical'])

/** Reject every high/critical production advisory and incomplete audit data. */
export function evaluateAudit(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ok: false, blocking: ['audit output is not a JSON object'] }
  }
  if (report.error !== undefined) {
    return { ok: false, blocking: ['audit output contains an error'] }
  }
  if (report.advisories === null || typeof report.advisories !== 'object' || Array.isArray(report.advisories)) {
    return { ok: false, blocking: ['audit output has no advisories map; pnpm output shape may have changed'] }
  }
  const counts = report.metadata?.vulnerabilities
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)
    || SEVERITIES.some(severity => !Number.isInteger(counts[severity]) || counts[severity] < 0)) {
    return { ok: false, blocking: ['audit output has no valid vulnerability counts'] }
  }

  const blocking = []
  const observed = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]))
  for (const advisory of Object.values(report.advisories)) {
    if (advisory === null || typeof advisory !== 'object' || Array.isArray(advisory)) {
      blocking.push('audit contains a malformed advisory entry')
      continue
    }
    const severity = advisory.severity
    if (!SEVERITIES.includes(severity)) {
      blocking.push('audit contains an advisory with a missing or unknown severity')
      continue
    }
    observed[severity] += 1
    if (severity !== 'high' && severity !== 'critical') continue
    const id = String(advisory.github_advisory_id ?? advisory.id ?? 'unknown')
    blocking.push(`${id}: ${severity} ${String(advisory.title ?? advisory.module_name ?? 'dependency advisory')}`)
  }
  for (const severity of SEVERITIES) {
    if (observed[severity] !== counts[severity]) {
      blocking.push(`audit ${severity} count does not match its advisories (${counts[severity]} reported, ${observed[severity]} present)`)
    }
  }
  return { ok: blocking.length === 0, blocking }
}

function selfTest() {
  const report = (advisories = {}, counts = {}) => ({
    advisories,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts } },
  })
  assert.equal(evaluateAudit(report()).ok, true)
  assert.equal(evaluateAudit(report({ 1: { severity: 'moderate' } }, { moderate: 1 })).ok, true)
  for (const id of ['GHSA-f88m-g3jw-g9cj', 'GHSA-rgj7-g3m4-5g8c', 'GHSA-wq5f-xc86-pv6w']) {
    assert.equal(evaluateAudit(report({
      1: { github_advisory_id: id, module_name: 'sharp', severity: 'high', findings: [{ version: '0.34.1', paths: ['.>@huggingface/transformers>sharp'], dev: false }] },
    }, { high: 1 })).ok, false)
  }
  assert.equal(evaluateAudit(report({ 1: { severity: 'critical' } }, { critical: 1 })).ok, false)
  assert.equal(evaluateAudit(report({}, { high: 1 })).ok, false)
  assert.equal(evaluateAudit(report({}, { critical: 1 })).ok, false)
  for (const malformed of [
    null,
    [],
    { advisories: [] },
    { advisories: {} },
    report({ 1: [] }),
    report({ 1: {} }),
    report({ 1: { severity: 'urgent' } }),
    report({}, { high: -1 }),
    report({}, { high: 0.5 }),
    report({}, { high: '0' }),
    { ...report(), error: { message: 'registry unavailable' } },
  ]) {
    assert.equal(evaluateAudit(malformed).ok, false)
  }
  assert.equal(evaluateAudit({ vulnerabilities: {} }).ok, false)
  for (const result of [
    { status: 2, signal: null },
    { status: null, signal: 'SIGTERM' },
    { status: null, signal: null, error: new Error('spawn failed') },
    { status: 1, signal: null },
  ]) {
    assert.throws(() => readAuditResult({ ...result, stdout: JSON.stringify(report()), stderr: '' }))
  }
  assert.deepEqual(readAuditResult({ status: 0, signal: null, stdout: JSON.stringify(report()), stderr: '' }), report())
  assert.deepEqual(readAuditResult({ status: 1, signal: null, stdout: JSON.stringify(report({ 1: { severity: 'moderate' } }, { moderate: 1 })), stderr: '' }), report({ 1: { severity: 'moderate' } }, { moderate: 1 }))
  assert.throws(() => readAuditResult({ status: 0, signal: null, stdout: 'invalid JSON', stderr: '' }))
  console.log('production audit policy self-test passed')
}

function pnpmInvocation(args) {
  if (process.platform !== 'win32') return ['pnpm', args, false]
  const lookup = spawnSync('where.exe', ['pnpm.cmd'], { encoding: 'utf8' })
  for (const shim of lookup.stdout?.split(/\r?\n/).filter(Boolean) ?? []) {
    try {
      const content = readFileSync(shim, 'utf8')
      const candidates = [...content.matchAll(/"([^"]+\.(?:mjs|cjs|js))"/gi)].map(match => match[1])
      const raw = candidates.find(candidate => candidate.toLowerCase().includes('pnpm'))
      if (raw === undefined) continue
      const script = raw.replace(/%~dp0[\\/]?/gi, `${dirname(shim)}\\`)
      if (existsSync(script)) return [process.execPath, [script, ...args], false]
    } catch {
      // Try the next pnpm shim before falling back to cmd.exe.
    }
  }
  return ['pnpm.cmd', args, true]
}

function readAuditResult(result) {
  if (result.error !== undefined) throw result.error
  if (result.signal !== null || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`pnpm audit failed (${result.signal ?? `exit ${result.status}`}): ${result.stderr.trim()}`)
  }
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    const detail = result.stderr.trim() || result.stdout.trim() || `pnpm exited ${result.status}`
    throw new Error(`unable to parse pnpm audit JSON: ${detail}`)
  }
  const counts = report?.metadata?.vulnerabilities
  if (result.status === 1 && counts !== null && typeof counts === 'object'
    && SEVERITIES.every(severity => counts[severity] === 0)) {
    throw new Error('pnpm audit exited 1 without reporting any vulnerabilities')
  }
  return report
}

function runAudit() {
  const [command, args, shell] = pnpmInvocation(['audit', '--prod', '--json'])
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell,
  })
  const report = readAuditResult(result)
  const decision = evaluateAudit(report)
  if (!decision.ok) {
    for (const line of decision.blocking) console.error(`[blocking production risk] ${line}`)
    process.exitCode = 1
    return
  }
  const counts = report.metadata?.vulnerabilities ?? {}
  console.log(`production audit policy passed (critical=${counts.critical}, high=${counts.high})`)
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  try {
    if (process.argv.includes('--self-test')) selfTest()
    else runAudit()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
