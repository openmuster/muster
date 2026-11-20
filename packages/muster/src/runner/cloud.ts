import type { Agent, PermissionMode } from './agents.ts'
import { Failure } from '../failure.ts'
import { PLACEHOLDER, boardPolicy } from './policy.ts'

/** What a cloud runner needs to start an agent on a task somewhere that isn't this machine. */
export type CloudRequest = {
  task: number
  agent: Agent
  prompt: string
  /** The board, at a URL the sandbox can reach, and a token held to this agent's profile and channels. */
  board: { url: string; token: string }
  /** The repository to work in, as a clone URL. Its credential is the platform's to add, not ours to pass. */
  repo?: string
  permissionMode?: PermissionMode
  /** The key for the agent's model provider. It is added to requests to that provider's host on the way out, and never enters the sandbox. */
  model?: { key: string }
  /** Commands that prepare the sandbox before the agent starts, such as installing the agent's CLI. */
  setup?: string[][]
  timeoutMs?: number
}

export type CloudRun = { id: string; stop(): Promise<void> }

/** Starts agents in sandboxes. `local` isn't one of these: it has no network between the agent and the board. */
export type CloudRunner = { name: string; start(request: CloudRequest): Promise<CloudRun> }

/** Vercel's own network policy, as `@vercel/sandbox` 4 takes it: a path is a matcher object, and a rule can answer a request itself. */
export type VercelRule = { match?: { path?: { regex: string }; method?: string[] }; transform: { headers: Record<string, string> }[] } | { response: { statusCode: number } }
export type VercelPolicy = { allow: Record<string, VercelRule[]> }

/** The part of `@vercel/sandbox` this runner uses, so it can be handed the real class or a stand-in. */
export type VercelSandbox = {
  create(options: { networkPolicy: VercelPolicy; image?: string; persistent?: boolean; env: Record<string, string>; timeout?: number; source?: { type: 'git'; url: string } }): Promise<{
    sandboxId?: string
    name?: string
    runCommand(command: { cmd: string; args: string[]; env?: Record<string, string>; detached?: boolean }): Promise<unknown>
    /** Replaces a running sandbox's policy. Used to close the hosts that only its setup needed. */
    update?(options: { networkPolicy: VercelPolicy | 'deny-all' }): Promise<unknown>
    stop(): Promise<unknown>
    /** Removes the sandbox and what it kept. */
    delete?(): Promise<unknown>
  }>
}

/** Vercel's image with Node, git and the coding agents' CLIs already in it. */
export const VERCEL_IMAGE = 'vercel/sandbox/universal'

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * Runs an agent in a Vercel Sandbox. The board's credential and the model's key are in the sandbox's
 * network policy, added to requests on the way out, so the agent's environment holds placeholders
 * and nothing to steal.
 */
/** Ends a sandbox so nothing of it is left: its way out is closed first, then it is removed, or stopped where it can't be. */
async function end(sandbox: Awaited<ReturnType<VercelSandbox['create']>>): Promise<void> {
  await sandbox.update?.({ networkPolicy: 'deny-all' }).catch(() => {})
  if (sandbox.delete) await sandbox.delete().catch(() => sandbox.stop())
  else await sandbox.stop()
}

/**
 * `setupHosts` are open while the setup commands run, which are ours, and closed before the agent
 * starts. `allowHosts` stay open to the agent, so each one is a way out of the sandbox: add few.
 */
export function vercel(options: { Sandbox: VercelSandbox; allowHosts?: Record<string, never[]>; setupHosts?: string[]; image?: string }): CloudRunner {
  return {
    name: 'vercel',
    async start(request) {
      const { networkPolicy, env } = boardPolicy(request.board)
      const allow: Record<string, VercelRule[]> = { ...options.allowHosts }
      for (const [host, rules] of Object.entries(networkPolicy.allow)) {
        allow[host] = [
          ...rules.map((rule) => ({ match: { path: { regex: rule.match.path }, method: rule.match.method }, transform: rule.transform })),
          // Allowing a host allows every request to it, so whatever the rules above didn't claim is answered here.
          { response: { statusCode: 403 } },
        ]
      }
      const model = request.model ? request.agent.model : undefined
      // The key goes only on the calls that ask the model. Everything else the key could do on that host is refused.
      if (model && request.model) {
        allow[model.host] = [...model.paths.map((regex) => ({ match: { path: { regex }, method: ['POST'] }, transform: [{ headers: { ...model.headers(request.model!.key), host: model.host } }] })), { response: { statusCode: 403 } }]
      }
      const setup = request.setup ?? []
      const during: Record<string, VercelRule[]> = { ...allow }
      if (setup.length) for (const host of options.setupHosts ?? []) during[host] ??= []
      const sandbox = await options.Sandbox.create({
        networkPolicy: { allow: during },
        image: options.image ?? VERCEL_IMAGE,
        // Nothing of a run is kept: a saved sandbox would hold the repository and a policy with the credentials in it.
        persistent: false,
        env: { ...env, ...(model ? model.env(PLACEHOLDER) : {}), MUSTER_TASK: String(request.task) },
        ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
        ...(request.repo ? { source: { type: 'git', url: request.repo } } : {}),
      })
      for (const [cmd, ...args] of setup) await sandbox.runCommand({ cmd: cmd!, args })
      // What the setup needed is closed before anything the agent decides runs.
      if (setup.length && options.setupHosts?.length) {
        if (!sandbox.update) {
          await end(sandbox)
          throw new Failure('runner_too_old', "This @vercel/sandbox can't change a running sandbox's network policy, so the setup's hosts would stay open to the agent.", { hint: 'npm i @vercel/sandbox@latest' })
        }
        await sandbox.update({ networkPolicy: { allow } })
      }
      const { bin, args } = request.agent.command({ permissionMode: request.permissionMode ?? 'safe' })
      // The prompt goes in on stdin through a shell, so no part of it is ever read as a flag.
      await sandbox.runCommand({ cmd: 'sh', args: ['-c', `printf %s ${shellQuote(request.prompt)} | ${[bin, ...args].map(shellQuote).join(' ')}`], detached: true })
      return { id: sandbox.name ?? sandbox.sandboxId ?? 'sandbox', stop: () => end(sandbox) }
    },
  }
}

/**
 * Runs an agent in a Cloudflare container, through a Worker you deploy (templates/cloudflare-runner).
 * The Worker holds the board's token and adds it to the container's outbound requests; this client
 * only asks the Worker to start and stop runs.
 */
export function cloudflare(options: { worker: string; secret: string; fetch?: typeof fetch }): CloudRunner {
  const doFetch = options.fetch ?? fetch
  const call = async (path: string, body: unknown) => {
    const response = await doFetch(`${options.worker.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { authorization: `Bearer ${options.secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`the runner Worker answered ${response.status}`)
    return (await response.json()) as { id: string }
  }
  return {
    name: 'cloudflare',
    async start(request) {
      const { networkPolicy, env } = boardPolicy(request.board)
      const { bin, args } = request.agent.command({ permissionMode: request.permissionMode ?? 'safe' })
      const made = await call('/runs', {
        task: request.task,
        command: [bin, ...args],
        prompt: request.prompt,
        env: { ...env, ...(request.model && request.agent.model ? request.agent.model.env(PLACEHOLDER) : {}), MUSTER_TASK: String(request.task) },
        // The Worker enforces this itself: the board's host with these routes, and the token it adds.
        board: { host: new URL(request.board.url).host, rules: networkPolicy.allow[new URL(request.board.url).host], token: request.board.token },
        ...(request.repo ? { repo: request.repo } : {}),
        setup: request.setup ?? [],
        // The Worker adds these to requests for the model's host, as it adds the board's token.
        ...(request.model && request.agent.model ? { model: { host: request.agent.model.host, paths: request.agent.model.paths, headers: request.agent.model.headers(request.model.key) } } : {}),
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      })
      return { id: made.id, stop: async () => void (await call(`/runs/${made.id}/stop`, {})) }
    },
  }
}
