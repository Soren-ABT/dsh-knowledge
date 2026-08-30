#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'README.en.md',
  'cordis.patch.yml',
  'dsh.plugin.json',
  'package.json',
  'benchmarks/baseline.json',
  'benchmarks/questions.json',
  'benchmarks/corpus/manifest.json',
  'scripts/verify-build-policy.mjs',
  'lib/index.js',
  'lib/knowledge/index.js',
  'lib/tool-knowledge/index.js',
  'lib/client.js',
]
const FORBIDDEN_PREFIXES = ['src/', 'tests/', 'node_modules/', '.git/', '.github/', 'docs/superpowers/']

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function npmInvocation(args) {
  if (process.env.npm_execpath !== undefined) return [process.execPath, [process.env.npm_execpath, ...args]]
  return [executable('npm'), args]
}

function exportedPaths(exportsValue) {
  if (typeof exportsValue === 'string') return [exportsValue]
  if (exportsValue === null || typeof exportsValue !== 'object') return []
  return Object.values(exportsValue).flatMap(exportedPaths)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const manifest = JSON.parse(await readFile('dsh.plugin.json', 'utf8'))
  const errors = []
  if (pkg.version !== manifest.version) errors.push(`manifest version ${manifest.version} differs from package version ${pkg.version}`)
  for (const path of new Set([pkg.main, pkg.types, ...exportedPaths(pkg.exports)])) {
    if (typeof path !== 'string') continue
    const normalized = path.replace(/^\.\//, '')
    if (!(await exists(normalized))) errors.push(`declared package path is missing: ${path}`)
  }
  await import(`${pathToFileURL(resolve(pkg.main)).href}?verify=${Date.now()}`)

  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-pack-'))
  try {
    const [npmCommand, npmArgs] = npmInvocation([
      'pack', '--json', '--ignore-scripts', '--pack-destination', root, '--cache', join(root, 'npm-cache'),
    ])
    const packed = spawnSync(npmCommand, npmArgs, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32' && npmCommand.endsWith('.cmd'),
    })
    if (packed.error !== undefined) throw packed.error
    if (packed.status !== 0) throw new Error(packed.stderr.trim() || `npm pack exited ${packed.status}`)
    const report = JSON.parse(packed.stdout)
    const entry = report[0]
    if (entry?.name !== pkg.name || entry?.version !== pkg.version) errors.push('npm pack metadata differs from package.json')
    const files = new Set((entry?.files ?? []).map(file => String(file.path).replaceAll('\\', '/')))
    for (const path of REQUIRED_FILES) if (!files.has(path)) errors.push(`packed artifact is missing ${path}`)
    for (const path of files) {
      if (FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))) errors.push(`packed artifact exposes forbidden path ${path}`)
      if (path.endsWith('.tgz')) errors.push(`packed artifact contains nested tarball ${path}`)
    }
    if (!files.has(`docs/releases/v${pkg.version}.md`)) errors.push(`packed artifact is missing docs/releases/v${pkg.version}.md`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const workspace = resolve('.').replaceAll('\\', '/')
  for (const path of ['lib/index.js.map', 'lib/knowledge/index.js.map', 'lib/tool-knowledge/index.js.map', 'lib/client.js.map']) {
    const content = (await readFile(path, 'utf8')).replaceAll('\\', '/')
    if (content.includes(workspace)) errors.push(`${path} contains the build machine workspace path`)
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(`packed artifact verified for ${pkg.name}@${pkg.version}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
