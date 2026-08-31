#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function validateReleaseMetadata({ pkg, manifest, changelog, releaseNotes, tag, expectedVersion }) {
  const errors = []
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : ''
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push(`package.json has invalid version ${JSON.stringify(pkg.version)}`)
    return errors
  }

  if (expectedVersion !== undefined && expectedVersion !== version) {
    errors.push(`package.json version is ${version}, expected ${expectedVersion}`)
  }

  if (manifest.version !== version) {
    errors.push(`dsh.plugin.json version is ${manifest.version}, expected ${version}`)
  }
  if (pkg.packageManager !== 'pnpm@11.7.0') errors.push('packageManager must be pnpm@11.7.0')

  const escapedVersion = escapeRegExp(version)
  const changelogRelease = changelog.match(/^##[ \t]+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[ \t]*(?:—|-|$))/m)?.[1]
  if (changelogRelease === undefined) {
    errors.push('CHANGELOG has no release heading')
  } else if (changelogRelease !== version) {
    errors.push(`CHANGELOG first release is ${changelogRelease}, expected ${version}`)
  }

  const releaseHeading = new RegExp(`^#{1,6}[ \\t]+.*\\bv${escapedVersion}(?=[ \\t]*(?:—|-|:|$))`, 'mi')
  if (!releaseHeading.test(releaseNotes)) errors.push(`release notes heading does not name v${version}`)

  if (tag !== undefined && tag !== `v${version}`) errors.push(`release tag is ${tag}, expected v${version}`)
  return errors
}

function tagFromArgs(args, env) {
  const inline = args.find(argument => argument.startsWith('--tag='))
  if (inline !== undefined) return inline.slice('--tag='.length)
  const index = args.indexOf('--tag')
  if (index >= 0) return args[index + 1] ?? ''
  return env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : undefined
}

function optionFromArgs(args, name) {
  const inline = args.find(argument => argument.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? '') : undefined
}

function selfTest() {
  const fixture = {
    pkg: { version: '1.2.3', packageManager: 'pnpm@11.7.0' },
    manifest: { version: '1.2.3' },
    changelog: '# Changelog\n\n## 1.2.3 — 2030-01-02\n',
    releaseNotes: '# dsh-knowledge v1.2.3 — Release notes\n',
  }
  assert.deepEqual(validateReleaseMetadata(fixture), [])
  assert.match(
    validateReleaseMetadata({ ...fixture, manifest: { version: '1.2.2' } }).join('\n'),
    /dsh\.plugin\.json version is 1\.2\.2/,
  )
  assert.match(
    validateReleaseMetadata({ ...fixture, changelog: '# Changelog\n' }).join('\n'),
    /CHANGELOG has no release heading/,
  )
  assert.match(
    validateReleaseMetadata({
      ...fixture,
      changelog: '# Changelog\n\n## 1.2.2 — older\n\n## 1.2.3 — current\n',
    }).join('\n'),
    /CHANGELOG first release is 1\.2\.2, expected 1\.2\.3/,
  )
  assert.match(
    validateReleaseMetadata({ ...fixture, releaseNotes: '# Notes for the next version\n' }).join('\n'),
    /release notes heading does not name v1\.2\.3/,
  )
  assert.match(
    validateReleaseMetadata({ ...fixture, tag: 'v1.2.2' }).join('\n'),
    /release tag is v1\.2\.2, expected v1\.2\.3/,
  )
  assert.match(
    validateReleaseMetadata({ ...fixture, expectedVersion: '1.2.4' }).join('\n'),
    /package\.json version is 1\.2\.3, expected 1\.2\.4/,
  )
  console.log('verify-release self-test passed')
}

async function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }

  const pkg = await readJson(join(ROOT, 'package.json'))
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : ''
  const manifest = await readJson(join(ROOT, 'dsh.plugin.json'))
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const releaseNotePath = join(ROOT, 'docs', 'releases', `v${version}.md`)
  let releaseNotes
  try {
    releaseNotes = await readFile(releaseNotePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`release notes are missing: docs/releases/v${version}.md`)
    throw error
  }

  const args = process.argv.slice(2)
  const tag = tagFromArgs(args, process.env)
  const expectedVersion = optionFromArgs(args, '--expected-version')
  const errors = validateReleaseMetadata({ pkg, manifest, changelog, releaseNotes, tag, expectedVersion })
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(`release metadata verified for dsh-knowledge@${version}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
