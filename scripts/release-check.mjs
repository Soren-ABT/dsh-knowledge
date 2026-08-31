#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

function executable(name) {
  return process.platform === 'win32' && (name === 'npm' || name === 'pnpm') ? `${name}.cmd` : name
}

function run(command, args) {
  console.log(`\n> ${command} ${args.join(' ')}`)
  const useNpmCli = command === 'npm' && process.env.npm_execpath !== undefined
  const target = useNpmCli ? process.execPath : executable(command)
  const targetArgs = useNpmCli ? [process.env.npm_execpath, ...args] : args
  const result = spawnSync(target, targetArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32' && !useNpmCli && (command === 'npm' || command === 'pnpm'),
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}`)
}

try {
  const releaseArguments = process.argv.slice(2)
  run('node', ['scripts/verify-build-policy.mjs', '--self-test'])
  run('node', ['scripts/verify-build-policy.mjs'])
  run('node', ['scripts/verify-release.mjs', '--self-test'])
  run('node', ['scripts/verify-release.mjs', ...releaseArguments])
  run('node', ['scripts/audit-production.mjs', '--self-test'])
  run('node', ['scripts/audit-production.mjs'])
  run('npm', ['run', 'typecheck'])
  run('npm', ['test'])
  run('npm', ['run', 'benchmark'])
  run('npm', ['run', 'build'])
  run('npm', ['run', 'verify:package'])
  const status = spawnSync(executable('git'), ['status', '--porcelain'], { encoding: 'utf8' })
  if (status.error !== undefined) throw status.error
  if (status.status !== 0) throw new Error('git status failed')
  if (status.stdout.trim() !== '') throw new Error(`release requires a clean working tree:\n${status.stdout.trimEnd()}`)
  console.log('\nrelease preflight passed; no tag, push, GitHub action, or npm publish was performed')
} catch (error) {
  console.error(`\nrelease preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
