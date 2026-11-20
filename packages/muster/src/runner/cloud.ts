import type { Agent, PermissionMode } from './agents.ts'
import { boardPolicy, type NetworkPolicy } from './policy.ts'

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
  /** Commands that prepare the sandbox before the agent starts, such as installing the agent's CLI. */
  setup?: string[][]
  timeoutMs?: number
}

export type CloudRun = { id: string; stop(): Promise<void> }

/** Starts agents in sandboxes. `local` isn't one of these: it has no network between the agent and the board. */
export type CloudRunner = { name: string; start(request: CloudRequest): Promise<CloudRun> }

/** The part of `@vercel/sandbox` this runner uses, so it can be handed the real class or a stand-in. */
export type VercelSandbox = {
  create(options: { networkPolicy: NetworkPolicy; env: Record<string, string>; timeout?: number; source?: { type: 'git'; url: string } }): Promise<{
    sandboxId: string
    runCommand(command: { cmd: string; args: string[]; env?: Record<string, string>; detached?: boolean; stdin?: string }): Promise<unknown>
    stop(): Promise<unknown>
  }>
}

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * Runs an agent in a Vercel Sandbox. The board's credential is in the sandbox's network policy, added
 * to requests on the way out, so the agent's environment holds a placeholder and nothing to steal.
 */
export function vercel(options: { Sandbox: VercelSandbox; allowHosts?: Record<string, never[]> }): CloudRunner {
  return {
    name: 'vercel',
    async start(request) {
      const { networkPolicy, env } = boardPolicy(request.board)
      const sandbox = await options.Sandbox.create({
        networkPolicy: { allow: { ...options.allowHosts, ...networkPolicy.allow } },
        env: { ...env, MUSTER_TASK: String(request.task) },
        ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
        ...(request.repo ? { source: { type: 'git', url: request.repo } } : {}),
      })
      for (const [cmd, ...args] of request.setup ?? []) await sandbox.runCommand({ cmd: cmd!, args })
      const { bin, args } = request.agent.command({ permissionMode: request.permissionMode ?? 'safe' })
      // The prompt goes in on stdin through a shell, so no part of it is ever read as a flag.
      await sandbox.runCommand({ cmd: 'sh', args: ['-c', `printf %s ${shellQuote(request.prompt)} | ${[bin, ...args].map(shellQuote).join(' ')}`], detached: true })
      return { id: sandbox.sandboxId, stop: async () => void (await sandbox.stop()) }
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
        env: { ...env, MUSTER_TASK: String(request.task) },
        // The Worker enforces this itself: the board's host with these routes, and the token it adds.
        board: { host: new URL(request.board.url).host, rules: networkPolicy.allow[new URL(request.board.url).host], token: request.board.token },
        ...(request.repo ? { repo: request.repo } : {}),
        setup: request.setup ?? [],
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      })
      return { id: made.id, stop: async () => void (await call(`/runs/${made.id}/stop`, {})) }
    },
  }
}
