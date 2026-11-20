import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the CLI keeps what only it needs: claim tokens, and later credentials. */
export const configDir = () => process.env.MUSTER_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'muster')

type Kept = { token: string; until: string }

const folder = (where: string) => join(configDir(), 'claims', createHash('sha256').update(where).digest('hex').slice(0, 16))
const fileOf = (where: string, task: number, profile: string | null) => join(folder(where), `${task}-${profile ?? '_'}.json`)

/** Keeps a claim's secret for the profile that took it: one 0600 file per board, task and profile. */
export function keepClaim(where: string, task: number, profile: string | null, claim: Kept) {
  mkdirSync(folder(where), { recursive: true, mode: 0o700 })
  writeFileSync(fileOf(where, task, profile), JSON.stringify(claim), { mode: 0o600 })
  prune(where)
}

export function heldClaim(where: string, task: number, profile: string | null): string | undefined {
  try {
    return (JSON.parse(readFileSync(fileOf(where, task, profile), 'utf8')) as Kept).token
  } catch {
    return undefined
  }
}

export function dropClaim(where: string, task: number, profile: string | null) {
  rmSync(fileOf(where, task, profile), { force: true })
}

/** Forgets claims whose lease ended more than a day ago. */
function prune(where: string) {
  const dir = folder(where)
  const cutoff = Date.now() - 86_400_000
  for (const name of readdirSync(dir)) {
    try {
      const path = join(dir, name)
      const kept = JSON.parse(readFileSync(path, 'utf8')) as Kept
      if (Date.parse(kept.until) < cutoff && statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    } catch {
      // A file that isn't a claim is left alone.
    }
  }
}
