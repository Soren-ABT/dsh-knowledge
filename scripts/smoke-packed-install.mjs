#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSupervised, verifyUninstallOutcome } from './smoke-packed-lifecycle.mjs'

const STARTUP_TIMEOUT_MS = 120_000
const SHUTDOWN_TIMEOUT_MS = 15_000
const UNINSTALL_TIMEOUT_MS = 120_000

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function npmInvocation(args) {
  if (process.env.npm_execpath !== undefined) return [process.execPath, [process.env.npm_execpath, ...args]]
  return [command('npm'), args]
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32' && executable.endsWith('.cmd'),
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`
    throw new Error(`${executable} ${args.join(' ')} failed (${result.status ?? result.signal ?? 'unknown'})\n${detail}`)
  }
  return result.stdout ?? ''
}

async function waitForKnowledge(port, logs) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/knowledge/bases`, { signal: AbortSignal.timeout(2_000) })
      const body = await response.text()
      if (response.ok) {
        const parsed = JSON.parse(body)
        if (parsed?.ok === true && Array.isArray(parsed.value)) return
        lastError = `unexpected response: ${body.slice(0, 500)}`
      } else {
        lastError = `HTTP ${response.status}: ${body.slice(0, 500)}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  throw new Error(`DSH knowledge route did not become ready: ${lastError}\n\n${logs()}`)
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  const exited = new Promise(resolvePromise => {
    if (child.exitCode !== null) resolvePromise(undefined)
    else child.once('exit', resolvePromise)
  })
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('DSH did not stop within the shutdown deadline')), SHUTDOWN_TIMEOUT_MS)),
  ])
}

async function main() {
  const configuredDsh = process.env.DSH_CMD
  const dshIsScript = configuredDsh !== undefined && /\.(?:mjs|cjs|js)$/i.test(configuredDsh)
  const dsh = dshIsScript ? process.execPath : configuredDsh ?? command('dsh')
  const dshPrefix = dshIsScript ? [resolve(configuredDsh)] : []
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-smoke-'))
  const packDir = join(root, 'pack')
  const home = join(root, 'home')
  const profiles = join(home, 'profiles')
  const port = Number(process.env.DSH_SMOKE_PORT ?? 31879)
  await mkdir(packDir, { recursive: true })
  await mkdir(profiles, { recursive: true })
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
    PATH: process.env.PATH ?? process.env.Path ?? '',
  }
  let child
  let output = ''
  try {
    // Let the official CLI create the built-in profile manifest and bundle
    // stack first. We then extend its own workspace file with this plugin's
    // native build approvals — writing a workspace one directory above the
    // profile would not affect the pnpm command whose cwd is profiles/web.
    run(dsh, [...dshPrefix, '--profile', 'web', '--dump-config'], { env })
    await writeFile(join(profiles, 'web', 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      '',
      'allowBuilds:',
      '  esbuild: true',
      '  onnxruntime-node: true',
      '  protobufjs: true',
      '  sharp: true',
      '  tesseract.js: false',
      '',
    ].join('\n'))
    const [npmCommand, npmArgs] = npmInvocation([
      'pack', '--json', '--ignore-scripts', '--pack-destination', packDir, '--cache', join(root, 'npm-cache'),
    ])
    const packedOutput = run(npmCommand, npmArgs)
    const packed = JSON.parse(packedOutput)[0]
    if (packed?.filename === undefined) throw new Error('npm pack did not return a tarball filename')
    const tarball = resolve(packDir, packed.filename)
    run(dsh, [...dshPrefix, 'plugin', '--profile', 'web', 'add', tarball], {
      env,
      stdio: 'inherit',
      timeout: 10 * 60_000,
    })

    child = spawn(dsh, [...dshPrefix, '--profile', 'web', '--no-open', '--port', String(port)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && dsh.endsWith('.cmd'),
    })
    child.stdout?.on('data', chunk => { output += chunk.toString() })
    child.stderr?.on('data', chunk => { output += chunk.toString() })
    child.once('error', error => { output += `\nspawn error: ${error.message}` })
    await waitForKnowledge(port, () => output)
    console.log(`packed DSH smoke passed at http://127.0.0.1:${port}/knowledge/bases`)
    await stopProcess(child)
    const uninstall = await runSupervised(dsh, [...dshPrefix, 'plugin', '--profile', 'web', 'remove', 'dsh-knowledge'], {
      env,
      stdio: 'inherit',
      timeoutMs: Number(process.env.DSH_SMOKE_UNINSTALL_TIMEOUT_MS ?? UNINSTALL_TIMEOUT_MS),
    })
    const profilePackagePath = join(profiles, 'web', 'package.json')
    const profilePackage = JSON.parse(await readFile(profilePackagePath, 'utf8'))
    const uninstallWarning = verifyUninstallOutcome(uninstall, profilePackage)
    if (uninstallWarning !== undefined) console.warn(uninstallWarning)
    console.log('official DSH remove round-trip passed')
  } catch (error) {
    if (output !== '') console.error(`\n--- captured DSH output ---\n${output}`)
    throw error
  } finally {
    if (child !== undefined && child.exitCode === null) {
      try { await stopProcess(child) } catch (error) { console.error(error instanceof Error ? error.message : String(error)) }
    }
    await rm(root, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
