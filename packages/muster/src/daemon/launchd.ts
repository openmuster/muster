import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const label = (board: string) => `dev.muster.daemon.${board}`
export const plistPath = (board: string, home = homedir()) => join(home, 'Library', 'LaunchAgents', `${label(board)}.plist`)

const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The LaunchAgent that keeps a board's daemon running. It restarts after a crash but not after a clean
 * exit, so a daemon that stops on a config error stays stopped instead of respawning forever.
 */
export function plist(options: { board: string; program: string[]; dir?: string; log: string; env?: Record<string, string> }): string {
  const env = { ...(options.dir ? { MUSTER_DIR: options.dir } : {}), ...options.env }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label(options.board))}</string>
  <key>ProgramArguments</key>
  <array>
${options.program.map((part) => `    <string>${xml(part)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(options.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.log)}</string>
</dict>
</plist>
`
}

const launchctl = (args: string[]) => execFileSync(process.env.MUSTER_LAUNCHCTL ?? 'launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

export function install(options: { board: string; program: string[]; dir?: string; log: string; home?: string; uid?: number; env?: Record<string, string> }): string {
  const path = plistPath(options.board, options.home)
  mkdirSync(dirname(path), { recursive: true })
  mkdirSync(dirname(options.log), { recursive: true, mode: 0o700 })
  // It holds the value of every secret passed with --env, so it is yours alone to read, whatever the folder allows.
  writeFileSync(path, plist(options), { mode: 0o600 })
  chmodSync(path, 0o600)
  const domain = `gui/${options.uid ?? process.getuid!()}`
  try {
    launchctl(['bootout', `${domain}/${label(options.board)}`])
  } catch {
    // Not loaded yet.
  }
  launchctl(['bootstrap', domain, path])
  return path
}

export function uninstall(options: { board: string; home?: string; uid?: number }): { path: string; wasLoaded: boolean } {
  const path = plistPath(options.board, options.home)
  let wasLoaded = true
  try {
    launchctl(['bootout', `gui/${options.uid ?? process.getuid!()}/${label(options.board)}`])
  } catch {
    wasLoaded = false
  }
  rmSync(path, { force: true })
  return { path, wasLoaded }
}

export function loaded(board: string, uid = process.getuid!()): boolean {
  try {
    launchctl(['print', `gui/${uid}/${label(board)}`])
    return true
  } catch {
    return false
  }
}
