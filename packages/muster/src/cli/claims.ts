import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the CLI keeps what only it needs: claim tokens, and later credentials. */
export const configDir = () => process.env.MUSTER_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'muster')

type Kept = { token: string; until: string }

/**
 * Who holds a claim: the board, and the principal and profile that took it, as the board said. A claim
 * is kept per principal, so a process that runs commands for several callers, as `mu serve` does for
 * MCP, never hands one caller's claim to another who happens to use the same profile name.
 */
export type Holder = { where: string; principal: string; profile: string | null }

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
const folder = (holder: Holder) => join(configDir(), 'claims', hash(`${holder.where}\n${holder.principal}`))
const fileOf = (holder: Holder, task: number) => join(folder(holder), `${task}-${holder.profile ?? '_'}.json`)
/** Where muster 0.2.0-alpha.1 and older kept a claim, by board alone: read for a board on a file, so an upgrade mid-task keeps it. */
const legacyFileOf = (holder: Holder, task: number) => join(configDir(), 'claims', hash(holder.where), `${task}-${holder.profile ?? '_'}.json`)

/** Keeps a claim's secret for the principal and profile that took it: one 0600 file per board, task and holder. */
export function keepClaim(holder: Holder, task: number, claim: Kept) {
  mkdirSync(folder(holder), { recursive: true, mode: 0o700 })
  writeFileSync(fileOf(holder, task), JSON.stringify(claim), { mode: 0o600 })
  prune(folder(holder))
}

export function heldClaim(holder: Holder, task: number): string | undefined {
  const paths = holder.where.includes('://') ? [fileOf(holder, task)] : [fileOf(holder, task), legacyFileOf(holder, task)]
  for (const path of paths) {
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as Kept).token
    } catch {
      // Not kept here.
    }
  }
  return undefined
}

export function dropClaim(holder: Holder, task: number) {
  rmSync(fileOf(holder, task), { force: true })
  if (!holder.where.includes('://')) rmSync(legacyFileOf(holder, task), { force: true })
}

/** Forgets claims whose lease ended more than a day ago. */
function prune(dir: string) {
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
