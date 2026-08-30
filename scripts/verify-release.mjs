#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const EXPECTED_VERSION = '0.3.6'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const pkg = await readJson('package.json')
  const manifest = await readJson('dsh.plugin.json')
  const changelog = await readFile('CHANGELOG.md', 'utf8')
  const releaseNotes = await readFile(`docs/releases/v${EXPECTED_VERSION}.md`, 'utf8')
  const errors = []
  if (pkg.version !== EXPECTED_VERSION) errors.push(`package.json version is ${pkg.version}, expected ${EXPECTED_VERSION}`)
  if (manifest.version !== EXPECTED_VERSION) errors.push(`dsh.plugin.json version is ${manifest.version}, expected ${EXPECTED_VERSION}`)
  if (pkg.packageManager !== 'pnpm@11.7.0') errors.push('packageManager must be pnpm@11.7.0')
  if (!changelog.includes(`## ${EXPECTED_VERSION} — 2026-08-30`)) errors.push(`CHANGELOG has no ${EXPECTED_VERSION} release heading`)
  if (!releaseNotes.includes(`v${EXPECTED_VERSION}`)) errors.push(`release notes do not name v${EXPECTED_VERSION}`)
  const tagArg = process.argv.find(argument => argument.startsWith('--tag='))?.slice('--tag='.length)
  const environmentTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined
  const tag = tagArg ?? environmentTag
  if (tag !== undefined && tag !== `v${EXPECTED_VERSION}`) errors.push(`release tag is ${tag}, expected v${EXPECTED_VERSION}`)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(`release metadata verified for dsh-knowledge@${EXPECTED_VERSION}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
