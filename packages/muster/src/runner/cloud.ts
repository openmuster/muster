import type { Agent, PermissionMode } from './agents.ts'
import { Failure } from '../failure.ts'
import { gitRules, githubRepo } from './github.ts'
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
  /** More for the sandbox's environment: settings, never secrets. */
  env?: Record<string, string>
  /** Commands that prepare the sandbox before the agent starts, such as installing the agent's CLI. */
  setup?: string[][]
  /** Install the repository's dependencies from its lockfile, with no install scripts, before the agent starts. */
  install?: boolean
  /** A GitHub token for the repository: added to its git routes while it is cloned, before anything of it runs, and never after. */
  github?: { token: string }
  timeoutMs?: number
}

export type CloudRun = {
  id: string
  /** Closes the run's way out and removes what is left of it. */
  stop(): Promise<void>
  /**
   * Resolves when what runs in the sandbox exits, with its exit code. It can reject on a dropped
   * connection while the run goes on, so it may be asked again. Absent where the platform can't tell.
   */
  wait?(): Promise<{ exitCode: number | null }>
  /** How the repository's dependencies were installed, when asked: `pnpm`, `npm`, `yarn` or `bun`, `none` without a lockfile, or `failed (exit n)`. */
  installed?: string
  /** Where the repository's checkout started: its commit and branch. */
  checkout?: { sha: string; branch: string }
  /** Runs one command in the sandbox, in the checkout when there is one, and waits for it. */
  exec?(command: { cmd: string; args: string[]; env?: Record<string, string> }): Promise<{ exitCode: number | null; stdout: string }>
  /** A file in the sandbox, read no further than `max` bytes: null when there is none, or it is bigger. */
  readFile?(path: string, max: number): Promise<Buffer | null>
  /** Replaces the sandbox's network policy: these hosts' rules, or none reached at all. */
  setPolicy?(rules: Record<string, VercelRule[]> | 'deny-all'): Promise<void>
}

/** Starts agents in sandboxes. `local` isn't one of these: it has no network between the agent and the board. */
export type CloudRunner = { name: string; start(request: CloudRequest): Promise<CloudRun> }

/** Vercel's own network policy, as `@vercel/sandbox` 4 takes it: a path is a matcher object, and a rule can answer a request itself. */
export type VercelRule = { match?: { path?: { regex: string }; method?: string[] }; transform: { headers: Record<string, string> }[] } | { response: { statusCode: number } }
export type VercelPolicy = { allow: Record<string, VercelRule[]> }

/** A Vercel access token with the team and project it is for. The SDK takes these only as arguments, never from the environment. */
export type VercelCredentials = { token: string; teamId: string; projectId: string }

/** A command as the SDK hands it back: finished, with its output to read, or detached, to wait on. */
type Finished = {
  exitCode?: number | null
  stdout?(): Promise<string>
  logs?(): AsyncIterable<{ stream: string; data: string }> & { close?(): void }
  wait?(): Promise<{ exitCode: number | null }>
}

/** The most of a command's output this side reads: what runs in a sandbox decides how much it prints. */
const OUTPUT_MAX = 64 * 1024

/** A finished command's stdout, read no further than `OUTPUT_MAX`. */
async function stdoutOf(done: Finished | void): Promise<string> {
  if (!done) return ''
  if (typeof done.logs === 'function') {
    const lines = done.logs()
    let out = ''
    try {
      for await (const line of lines) {
        if (line.stream !== 'stdout') continue
        out += line.data
        if (out.length >= OUTPUT_MAX) break
      }
    } finally {
      lines.close?.()
    }
    return out.slice(0, OUTPUT_MAX)
  }
  return typeof done.stdout === 'function' ? String(await done.stdout()).slice(0, OUTPUT_MAX) : ''
}

/** A commit's full ID and a branch's name, as git would never read them as an option. */
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

/** The part of `@vercel/sandbox` this runner uses, so it can be handed the real class or a stand-in. */
export type VercelSandbox = {
  create(options: { networkPolicy: VercelPolicy; image?: string; persistent?: boolean; env: Record<string, string>; timeout?: number; source?: { type: 'git'; url: string } } & Partial<VercelCredentials>): Promise<{
    sandboxId?: string
    name?: string
    /** A finished command has its `exitCode`; a detached one can be waited on. Older stand-ins return nothing. */
    runCommand(command: { cmd: string; args: string[]; env?: Record<string, string>; detached?: boolean; cwd?: string }): Promise<Finished | void>
    /** A file in the sandbox, as a stream, or null when there is none. */
    readFile?(file: { path: string }): Promise<NodeJS.ReadableStream | null>
    /** Replaces a running sandbox's policy. Used to close the hosts that only its setup needed. */
    update?(options: { networkPolicy: VercelPolicy | 'deny-all' }): Promise<unknown>
    stop(): Promise<unknown>
    /** Removes the sandbox and what it kept. */
    delete?(): Promise<unknown>
  }>
}

/**
 * What a sandbox sets for the programs in it that the agent must still see: where the certificate for
 * its intercepted connections is, and that it is a sandbox. `mu run` gives an agent a small, clean
 * environment, so these are named for it to pass on.
 */
export const SANDBOX_ENV = ['NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'IS_SANDBOX']

/** Vercel's image with Node, git and the coding agents' CLIs already in it. */
export const VERCEL_IMAGE = 'vercel/sandbox/universal'

/** A command's word as an error may show it: a URL without the credential or query it may carry. */
const bare = (word: string) => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return word
  try {
    const url = new URL(word)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return '<url>'
  }
}

/** Where Vercel clones `source`: beside the sandbox's home, under the repository's own name. */
export const repoDir = (url: string) => `/vercel/${new URL(url).pathname.split('/').filter(Boolean).pop()!.replace(/\.git$/, '')}`

/** What cloning a repository from GitHub reaches, at the sandbox's creation. */
const CLONE_HOSTS = ['github.com', 'codeload.github.com']

/**
 * Installs a repository's dependencies the way its lockfile says, with the package manager it pins
 * (a plain version) or the one in the image. No install script runs, the repository's dependencies'
 * included: those are anyone's code, and setup reaches every host. Its last line says which it used.
 */
export const INSTALL = `set -e
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
pinned() { node -p "const m = (require('./package.json').packageManager || '').split('+')[0]; /^$1@\\d+\\.\\d+\\.\\d+$/.test(m) ? m : ''" 2>/dev/null || true; }
if [ -f pnpm-lock.yaml ]; then
  v=$(pinned pnpm); if [ -n "$v" ]; then pm="npx -y $v"; else pm=pnpm; fi
  $pm install --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false; echo installed pnpm
elif [ -f yarn.lock ]; then
  if [ -f .yarnrc.yml ]; then YARN_ENABLE_SCRIPTS=false corepack yarn install --immutable; else npx -y yarn@1 install --frozen-lockfile --ignore-scripts; fi; echo installed yarn
elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci --ignore-scripts --no-audit --no-fund; echo installed npm
elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile --ignore-scripts; echo installed bun
else echo installed none; fi`

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
export function vercel(options: { Sandbox: VercelSandbox; allowHosts?: Record<string, never[]>; setupHosts?: string[]; image?: string; credentials?: VercelCredentials }): CloudRunner {
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
      const dir = request.repo ? repoDir(request.repo) : undefined
      const install = Boolean(dir && request.install)
      // Setting up needs the network, and the credentials have no part in it: it runs under a policy with
      // none of them, and the agent's replaces it before the agent starts. Installing a repository's
      // dependencies needs whatever registries it names, so then every host is open, for the setup alone.
      const preparing = setup.length > 0 || Boolean(dir)
      const hosts = (names: string[]) => Object.fromEntries(names.map((host) => [host, [] as VercelRule[]]))
      // GitHub's token, when there is one, is in the policy only while Vercel clones the repository, before
      // anything of the repository's runs, and then only for that repository's git routes, to read.
      const github = dir && request.github ? githubRepo(request.repo!) : null
      const cloning: Record<string, VercelRule[]> | null = github ? { ...hosts(options.setupHosts ?? []), 'codeload.github.com': [], ...gitRules(github, request.github!.token) } : null
      const during: Record<string, VercelRule[]> = install ? { '*': [] } : hosts([...(options.setupHosts ?? []), ...(dir ? CLONE_HOSTS : [])])
      const sandbox = await options.Sandbox.create({
        // Without these the SDK signs in with VERCEL_OIDC_TOKEN. They go to Vercel's API, never into the sandbox.
        ...options.credentials,
        networkPolicy: { allow: cloning ?? (preparing ? during : allow) },
        image: options.image ?? VERCEL_IMAGE,
        // Nothing of a run is kept: a saved sandbox would hold the repository and a policy with the credentials in it.
        persistent: false,
        env: { ...env, ...(model ? model.env(PLACEHOLDER) : {}), ...request.env, MUSTER_TASK: String(request.task) },
        ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
        ...(request.repo ? { source: { type: 'git', url: request.repo } } : {}),
      })
      if (preparing && !sandbox.update) {
        await end(sandbox)
        throw new Failure('runner_too_old', "This @vercel/sandbox can't change a running sandbox's network policy, so the setup's hosts would stay open to the agent.", { hint: 'npm i @vercel/sandbox@latest' })
      }
      if (cloning) await sandbox.update!({ networkPolicy: { allow: during } })
      for (const [cmd, ...args] of setup) {
        const done = await sandbox.runCommand({ cmd: cmd!, args })
        // What it printed stays in the sandbox: an install's output can name private packages and registries.
        if (done && typeof done.exitCode === 'number' && done.exitCode !== 0) {
          await end(sandbox)
          throw new Failure('runner_setup_failed', `Setting up the sandbox failed: \`${[cmd!, ...args].map(bare).join(' ')}\` exited ${done.exitCode}.`, { hint: 'The sandbox was removed. MUSTER_INSTALL names another muster to install.' })
        }
      }
      // A failed install costs the agent its tests, not the run: it is said, and the agent starts.
      let installed: string | undefined
      if (install) {
        const done = await sandbox.runCommand({ cmd: 'sh', args: ['-c', INSTALL], cwd: dir })
        const said = (await stdoutOf(done)).trim().split('\n').pop() ?? ''
        installed = done && typeof done.exitCode === 'number' && done.exitCode !== 0 ? `failed (exit ${done.exitCode})` : /^installed \w+$/.test(said) ? said.slice('installed '.length) : 'none'
      }
      // What the setup needed is closed before anything the agent decides runs.
      // Where the checkout started, so what the agent changed can be told from what was there.
      let checkout: { sha: string; branch: string } | undefined
      if (dir) {
        const head = await sandbox.runCommand({ cmd: 'sh', args: ['-c', 'git rev-parse HEAD && git rev-parse --abbrev-ref HEAD'], cwd: dir })
        // Read after the repository's install ran, so it is checked as anything from the sandbox is.
        const [sha, branch] = (await stdoutOf(head)).trim().split('\n')
        if (sha && branch && SHA.test(sha) && BRANCH.test(branch)) checkout = { sha, branch }
      }
      if (preparing) await sandbox.update!({ networkPolicy: { allow } })
      const { bin, args } = request.agent.command({ permissionMode: request.permissionMode ?? 'safe' })
      // The prompt goes in on stdin through a shell, so no part of it is ever read as a flag. The agent starts in the repository.
      const agent = await sandbox.runCommand({ cmd: 'sh', args: ['-c', `printf %s ${shellQuote(request.prompt)} | ${[bin, ...args].map(shellQuote).join(' ')}`], detached: true, ...(dir ? { cwd: dir } : {}) })
      const wait = agent && typeof agent.wait === 'function' ? agent.wait.bind(agent) : undefined
      const exec = async (command: { cmd: string; args: string[]; env?: Record<string, string> }) => {
        const done = await sandbox.runCommand({ ...command, ...(dir ? { cwd: dir } : {}) })
        return { exitCode: done && typeof done.exitCode === 'number' ? done.exitCode : null, stdout: await stdoutOf(done) }
      }
      // Read no further than `max` bytes, whatever the file says it is: null when there is none, or it is bigger.
      const readFile = async (path: string, max: number): Promise<Buffer | null> => {
        const stream = await sandbox.readFile!({ path })
        if (!stream) return null
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of stream as AsyncIterable<Buffer | string>) {
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          size += buffer.length
          if (size > max) {
            ;(stream as { destroy?(): void }).destroy?.()
            return null
          }
          chunks.push(buffer)
        }
        return Buffer.concat(chunks)
      }
      return {
        id: sandbox.name ?? sandbox.sandboxId ?? 'sandbox',
        stop: () => end(sandbox),
        exec,
        ...(sandbox.readFile ? { readFile } : {}),
        ...(sandbox.update ? { setPolicy: async (rules: Record<string, VercelRule[]> | 'deny-all') => void (await sandbox.update!({ networkPolicy: rules === 'deny-all' ? rules : { allow: rules } })) } : {}),
        ...(checkout ? { checkout } : {}),
        ...(installed ? { installed } : {}),
        ...(wait ? { wait: async () => ({ exitCode: (await wait()).exitCode ?? null }) } : {}) }
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
        // In a container the agent runs as root, and Claude Code skips its prompts as root only when told it is sandboxed.
        env: { ...env, ...(request.model && request.agent.model ? request.agent.model.env(PLACEHOLDER) : {}), IS_SANDBOX: '1', ...request.env, MUSTER_TASK: String(request.task) },
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
