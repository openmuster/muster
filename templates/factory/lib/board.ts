// The factory's board module: the board, its GitHub sync, the watcher that wakes the agent, and how
// `/api/board` serves it. Importing it opens, reads and starts nothing, so the pages and the route share it:
// the route takes GitHub's webhooks (`team.fetch`), and `host.ts`, in a process of its own, runs the watcher
// and the sync's catch-up and sending (`team.start()`).
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { board, command, env, github, http, type Duration } from 'muster'

export const FACTORY = process.env.FACTORY_CHANNEL ?? 'factory'

/** What `mu run --runner vercel` reads: passed to the wake only when it runs in a sandbox (FACTORY_RUNNER=vercel). */
export const SANDBOX = ['MUSTER_SANDBOX_URL', 'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID', 'VERCEL_OIDC_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_KEY_FILE']

/**
 * What the wake gets of the host's environment, beside PATH, HOME and the board's own. Nothing else of it is
 * passed on: add a name here to pass it. The sandbox's settings only in a sandbox, where `lib/wake.ts` hands
 * them to `mu run` and nothing else; an agent on this machine never gets them (see `agentEnv`).
 */
export const PASS = ['FACTORY_RUNNER', 'FACTORY_AGENT', 'FACTORY_REPO', 'FACTORY_PUSH', 'ANTHROPIC_API_KEY', ...(process.env.FACTORY_RUNNER === 'vercel' ? SANDBOX : [])]

/** `lib/wake.ts`, by its full path: worked out when the watcher runs, in `host.ts`, never in a page. */
const wakeScript = () => join(dirname(fileURLToPath(import.meta.url)), 'wake.ts')

const url = process.env.MUSTER_URL
// `/api/board` answers for the names the page does (ALLOW_HOSTS, as `proxy.ts` reads it), and for no other.
// Where ALLOW_HOSTS isn't set, it takes `mu serve`'s MUSTER_ALLOW_HOSTS.
const allowed = process.env.ALLOW_HOSTS

/**
 * GitHub issues and pull requests into `factory/` channels. Put your repository in place of `acme/web`. The
 * webhook's secret is read from GITHUB_WEBHOOK_SECRET when the board starts or takes its first request; with
 * it unset, `host.ts` refuses to start and `/api/board/webhooks/gh` answers 503. Nothing goes back to GitHub:
 * for the agent's replies as comments, add `token: env('GITHUB_TOKEN')` and give the repository `mirror: true`.
 */
export const sync = {
  gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), repos: { 'acme/web': { issues: `${FACTORY}/issues`, pulls: `${FACTORY}/prs` } } }),
}

/**
 * The factory's board: the default board on this machine, with its sync. At MUSTER_URL when set, it has no
 * sync, and `host.ts` can't run its watcher: both run where a board's file is.
 */
export const team = board({
  ...(url ? { backend: http({ url, token: process.env.MUSTER_TOKEN ?? '' }) } : { sync }),
  serve: allowed === undefined ? {} : { hosts: allowed.split(',').map((name) => name.trim()).filter(Boolean) },
  watch: {
    // New activity under factory/ wakes the agent on its thread, as `factory`. A thread's messages within
    // 30 seconds (FACTORY_COALESCE) are one wake: the agent reads the whole thread anyway. A session may
    // take up to two hours before it is stopped and counted as failed.
    factory: {
      tail: { channel: `${FACTORY}/`, types: ['message.posted'] },
      as: 'factory',
      coalesce: (process.env.FACTORY_COALESCE ?? '30s') as Duration,
      timeout: '2h',
      run: command(({ event }) => [process.execPath, wakeScript(), String(event.thread)], { env: PASS }),
    },
  },
})
