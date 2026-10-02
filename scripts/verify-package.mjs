#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'README.en.md',
  'SECURITY.md',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'dsh.plugin.json',
  'package.json',
  'benchmarks/baseline.json',
  'benchmarks/questions.json',
  'benchmarks/corpus/manifest.json',
  'scripts/verify-build-policy.mjs',
  'scripts/smoke-mineru-local.mjs',
  'docs/mineru-self-hosted.md',
  'lib/index.js',
  'lib/knowledge/index.js',
  'lib/knowledge/mineru-deployment.mjs',
  'lib/knowledge/embed-process.mjs',
  'lib/knowledge/rerank-process.mjs',
  'lib/knowledge/ocr-process.mjs',
  'lib/knowledge/pdf-parse-worker.mjs',
  'lib/tool-knowledge/index.js',
  'lib/client.js',
]
// `docs/issues/` and `docs/images/` are working notes and retired local assets:
// the first is git-ignored, the second is unreferenced, and neither has any
// reason to reach a consumer. Listing them here means a later change to the
// `files` allowlist cannot publish them by accident.
const FORBIDDEN_PREFIXES = ['src/', 'tests/', 'node_modules/', '.git/', '.github/', 'docs/superpowers/', 'docs/issues/', 'docs/images/']
const FORBIDDEN_FILES = ['lib/knowledge/embed-worker.mjs', 'lib/knowledge/embed-worker.mjs.map', 'lib/knowledge/ocr-worker.mjs', 'lib/knowledge/ocr-worker.mjs.map']

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

/** `pack` is an npm surface: pnpm rejects `--ignore-scripts` and `--cache`, so a
 *  process started from a pnpm lifecycle script (`pnpm run verify:package`)
 *  cannot reuse its `npm_execpath`. Fall back to the real npm CLI there instead
 *  of failing the gate with "Unknown options" after the whole suite has run. */
function npmInvocation(args) {
  const execpath = process.env.npm_execpath
  if (execpath !== undefined && !/^pnpm/i.test(basename(execpath))) return [process.execPath, [execpath, ...args]]
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
      if (FORBIDDEN_FILES.includes(path)) errors.push(`packed artifact exposes obsolete runtime ${path}`)
      if (path.endsWith('.tgz')) errors.push(`packed artifact contains nested tarball ${path}`)
      // A real evaluation set is built from private study material, so only the
      // templates may ship. Keeping one in `scripts/` (which is in `files`) was a
      // repeatable privacy regression — see the 0.2.12 changelog entry.
      if (/^scripts\/eval-.*\.json$/.test(path) && !path.endsWith('.example.json')) {
        errors.push(`packed artifact exposes a non-example eval set ${path}`)
      }
    }
    if (!files.has(`docs/releases/v${pkg.version}.md`)) errors.push(`packed artifact is missing docs/releases/v${pkg.version}.md`)
    // The benchmark ships with its index but the gate only required the index:
    // dropping the corpus documents would have stayed green while the shipped
    // benchmark (and any corpus claim) silently broke.
    const manifest = JSON.parse(await readFile('benchmarks/corpus/manifest.json', 'utf8'))
    for (const entry of manifest.documents ?? []) {
      if (typeof entry?.file !== 'string') continue
      if (!files.has(`benchmarks/corpus/${entry.file}`)) errors.push(`packed artifact is missing corpus document benchmarks/corpus/${entry.file}`)
    }
    // README.md links SECURITY.md; a published package that omits it dangles.
    // `scripts/verify-build-policy.mjs` ships and reads pnpm-workspace.yaml, so a
    // tarball without that file contains a script that cannot run.
    for (const referenced of ['SECURITY.md', 'pnpm-workspace.yaml']) {
      if (!files.has(referenced)) errors.push(`packed artifact is missing ${referenced}, which the package references`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const workspace = resolve('.').replaceAll('\\', '/')
  // Derive the emitted bundles from build.mjs instead of listing four by hand: a
  // new companion bundle used to be outside this check the day it was added. The
  // assertion below fails loudly if the parse stops finding the entries.
  const buildSource = await readFile('build.mjs', 'utf8')
  const emitted = [...buildSource.matchAll(/\['src\/([^']+)',\s*'([^']+)'\]/g)].map(match => match[2])
  if (emitted.length < 7) errors.push(`build.mjs parse found ${emitted.length} host entries; expected at least 7`)
  for (const path of [...emitted.map(file => `${file}.map`), 'lib/client.js.map']) {
    const content = (await readFile(path, 'utf8')).replaceAll('\\', '/')
    // Both forms: the scrub in build.mjs only recognises Windows drive paths, so a
    // Linux-built artifact would leak `/home/runner/...` past it, and CI builds on
    // ubuntu. Check the POSIX shape here as well.
    if (content.includes(workspace)) errors.push(`${path} contains the build machine workspace path`)
    if (/\/home\/runner\/|\/Users\/runner\//.test(content)) {
      errors.push(`${path} contains a CI runner absolute path`)
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(`packed artifact verified for ${pkg.name}@${pkg.version}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
