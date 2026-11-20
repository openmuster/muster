// What a release does, in one place, so a pull request can run it without publishing.
//   node scripts/release.mjs pack <dir>      pack the package, install the tarball, run it, write checksums
//   node scripts/release.mjs notes <version> print that version's section of CHANGELOG.md
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const version = JSON.parse(readFileSync(join(root, 'packages/muster/package.json'), 'utf8')).version

/** The changelog's text for one version: from its heading to the next one. */
export function notes(changelog, wanted) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${wanted}`)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

const [command, arg] = process.argv.slice(2)
if (command === 'pack') {
  const out = resolve(arg ?? 'out')
  mkdirSync(out, { recursive: true })
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: join(root, 'packages/muster'), stdio: 'inherit' })
  const tarball = join(out, `muster-${version}.tgz`)
  copyFileSync(tarball, join(out, 'muster.tgz'))
  // The packed CLI has to install and run, from a path npm can't mistake for a GitHub repository.
  const prefix = mkdtempSync(join(tmpdir(), 'muster-release-'))
  execFileSync('npm', ['install', '-g', '--prefix', prefix, tarball], { stdio: 'inherit' })
  const mu = join(prefix, 'bin', 'mu')
  const printed = execFileSync(mu, ['--version'], { encoding: 'utf8' }).trim()
  if (printed !== version) throw new Error(`the packed CLI says ${printed}, not ${version}`)
  execFileSync(mu, ['post', 'general', `packed ${version}`], { env: { ...process.env, MUSTER_DIR: join(prefix, 'board') }, stdio: 'inherit' })
  const sums = ['muster.tgz', `muster-${version}.tgz`].map((name) => `${createHash('sha256').update(readFileSync(join(out, name))).digest('hex')}  ${name}`)
  writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  console.log(sums.join('\n'))
} else if (command === 'notes') {
  const found = notes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), arg ?? version)
  // A pull request runs this for a version that is still "Unreleased": that section stands in.
  const text = found ?? notes(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), 'Unreleased')
  if (!text) throw new Error(`CHANGELOG.md has no section for ${arg ?? version} and nothing under Unreleased`)
  console.log(text)
} else if (command !== undefined) {
  throw new Error('use: release.mjs pack <dir> | notes <version>')
}
