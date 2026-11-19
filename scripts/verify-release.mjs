#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export function validateReleaseMetadata({ pkg, manifest, changelog, releaseNotes, readme, readmeEn, issueTemplate, tag, expectedVersion }) {
  const errors = []
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : ''
  if (!new RegExp(`^${VERSION}$`).test(version)) {
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

  if (version.includes('-beta.') && pkg.publishConfig?.tag !== 'beta') errors.push('beta releases must use the npm beta tag')
  if (!version.includes('-') && pkg.publishConfig?.tag === 'beta') errors.push('stable releases must clear the npm beta tag')

  const changelogRelease = changelog.match(new RegExp(`^##[ \\t]+v?(${VERSION})(?=[ \\t—:]|$)`, 'm'))?.[1]
  if (changelogRelease === undefined) {
    errors.push('CHANGELOG has no release heading')
  } else if (changelogRelease !== version) {
    errors.push(`CHANGELOG first release is ${changelogRelease}, expected ${version}`)
  }

  const notesVersion = releaseNotes.match(new RegExp(`^#{1,6}[ \\t]+.*?\\bv(${VERSION})(?=[ \\t—:]|$)`, 'mi'))?.[1]
  if (notesVersion !== version) errors.push(`release notes heading does not name v${version}`)

  if (tag !== undefined && tag !== `v${version}`) errors.push(`release tag is ${tag}, expected v${version}`)

  // Version literals OUTSIDE the four gated sources used to drift silently: the
  // README install commands named a tarball that no longer exists after a bump,
  // and the issue template's placeholder stayed two majors behind. Both are
  // user-facing, so they are checked here rather than left to whoever notices.
  for (const [label, text] of [['README.md', readme], ['README.en.md', readmeEn]]) {
    if (typeof text !== 'string') continue
    const installLines = [...text.matchAll(new RegExp(`dsh-knowledge-(${VERSION})\\.tgz\\b`, 'g'))].map(match => match[1])
    for (const found of installLines) {
      if (found !== version) errors.push(`${label} install example names dsh-knowledge-${found}.tgz, expected ${version}`)
    }
    if (installLines.length === 0) errors.push(`${label} has no dsh-knowledge-<version>.tgz install example`)
    for (const [, pinned] of text.matchAll(new RegExp(`\\badd[ \\t]+dsh-knowledge@(${VERSION})`, 'g'))) {
      if (pinned !== version) errors.push(`${label} npm install example names ${pinned}, expected ${version}`)
    }
    const highlight = text.match(new RegExp(`^##[ \\t]+v(${VERSION})[ \\t]+(?:更新重点|highlights)`, 'm'))?.[1]
    if (highlight !== undefined && highlight !== version) {
      errors.push(`${label} highlights section is v${highlight}, expected v${version}`)
    }
  }
  if (typeof issueTemplate === 'string') {
    const placeholder = issueTemplate.match(new RegExp(`placeholder:[ \\t]*["']?(${VERSION})`))?.[1]
    if (placeholder !== undefined && placeholder !== version) {
      errors.push(`bug report template placeholder is ${placeholder}, expected ${version}`)
    }
  }
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
  const readme = 'dsh plugin add ./dsh-knowledge-1.2.3.tgz\n\n## v1.2.3 highlights\n'
  assert.deepEqual(validateReleaseMetadata({ ...fixture, readme, readmeEn: readme }), [])
  assert.match(
    validateReleaseMetadata({ ...fixture, readme: readme.replace('1.2.3', '1.2.2'), readmeEn: readme }).join('\n'),
    /README\.md install example names dsh-knowledge-1\.2\.2\.tgz, expected 1\.2\.3/,
  )
  assert.match(
    validateReleaseMetadata({ ...fixture, readme: readme.replace('## v1.2.3 highlights', '## v1.2.2 highlights'), readmeEn: readme }).join('\n'),
    /README\.md highlights section is v1\.2\.2, expected v1\.2\.3/,
  )
  assert.match(
    validateReleaseMetadata({ ...fixture, readme: 'no install example here', readmeEn: readme }).join('\n'),
    /README\.md has no dsh-knowledge-<version>\.tgz install example/,
  )
  assert.match(
    validateReleaseMetadata({ ...fixture, readme, readmeEn: readme, issueTemplate: 'placeholder: 0.3.6' }).join('\n'),
    /bug report template placeholder is 0\.3\.6, expected 1\.2\.3/,
  )
  const version = '1.2.3-beta.1'
  const betaReadme = `dsh plugin add dsh-knowledge@${version}\ndsh plugin add ./dsh-knowledge-${version}.tgz`
  const beta = {
    pkg: { ...fixture.pkg, version, publishConfig: { tag: 'beta' } }, manifest: { version },
    changelog: `## ${version} — Prerelease`, releaseNotes: `# dsh-knowledge v${version}`,
    readme: betaReadme, readmeEn: betaReadme, issueTemplate: `placeholder: ${version}`, tag: `v${version}`,
  }
  assert.deepEqual(validateReleaseMetadata(beta), [])
  assert.match(validateReleaseMetadata({ ...beta, readmeEn: betaReadme.replace('-beta.1.tgz', '-beta.2.tgz') }).join('\n'), /README\.en\.md install example/)
  assert.match(validateReleaseMetadata({ ...beta, readme: betaReadme.replace('@1.2.3-beta.1', '@1.2.3') }).join('\n'), /README\.md npm install example/)
  assert.match(validateReleaseMetadata({ ...beta, issueTemplate: 'placeholder: 1.2.3' }).join('\n'), /bug report template placeholder/)
  assert.match(validateReleaseMetadata({ ...fixture, releaseNotes: beta.releaseNotes }).join('\n'), /release notes heading/)
  assert.match(validateReleaseMetadata({ ...beta, pkg: { ...beta.pkg, publishConfig: {} } }).join('\n'), /npm beta tag/)
  assert.match(validateReleaseMetadata({ ...fixture, pkg: { ...fixture.pkg, publishConfig: { tag: 'beta' } } }).join('\n'), /clear the npm beta tag/)
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
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  const readmeEn = await readFile(join(ROOT, 'README.en.md'), 'utf8')
  let issueTemplate
  try {
    issueTemplate = await readFile(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'utf8')
  } catch {
    issueTemplate = undefined
  }
  const errors = validateReleaseMetadata({ pkg, manifest, changelog, releaseNotes, readme, readmeEn, issueTemplate, tag, expectedVersion })
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(`release metadata verified for dsh-knowledge@${version}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
