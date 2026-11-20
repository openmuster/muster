import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The version in the package's own package.json, found from wherever this file ended up (src or dist). */
function read(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      const found = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string }
      if (found.name === 'muster' && found.version) return found.version
    }
    dir = dirname(dir)
  }
  return '0.0.0'
}

export const VERSION = read()

/** Where releases live. A release is a tarball on GitHub, which npm installs from its URL. */
export const RELEASES = 'https://github.com/openmuster/muster/releases'

/** The tarball of one release: `npm install -g <this>` puts `mu` on the path. */
export const releaseTarball = (version: string = VERSION): string => `${RELEASES}/download/v${version}/muster-${version}.tgz`

/** The hosts npm talks to when it installs a release tarball: GitHub, and where it keeps release files. */
export const RELEASE_HOSTS = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']
