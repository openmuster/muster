import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { authorized, usable } from './auth.ts'
import { type BoardProps, type ModelProps, type RepoProps, boardHeaders, modelPasses, repoPasses, repoProps } from './gates.ts'

type Start = { task: number; command: string[]; prompt: string; env: Record<string, string>; board: BoardProps; model?: ModelProps; repo?: string; repoAuth?: string; setup: string[][]; timeoutMs?: number }
type Instance = 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4'
type Env = { RUNNER_SECRET: string; RUNS: DurableObjectNamespace<Run>; INSTANCE?: Instance }

/** Where Cloudflare puts the certificate its intercepts present. It exists once an HTTPS intercept is registered. */
const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt'
/**
 * What every process in the container is given: `exec` passes on none of `start`'s environment but PATH.
 * Every HTTPS request leaves through an intercept, so the intercepts' certificate is the only one needed.
 */
const BASE_ENV = { HOME: '/root', NODE_EXTRA_CA_CERTS: CA, SSL_CERT_FILE: CA, GIT_SSL_CAINFO: CA }
/** Where the agent's output and exit code go: the run is checked on, not held open by a request. */
const LOG = '/workspace/.muster-run.log'
const EXIT = '/workspace/.muster-run.exit'
/** How often the run is checked. Each check keeps the container running, and the idle timeout covers the gap between two. */
const CHECK_MS = 60_000
const IDLE_MS = 5 * 60_000
/**
 * The container's size when `INSTANCE` names none. Cloudflare's own default, `lite`, has 256 MiB: an agent's CLI
 * and `mu` run out of memory in it and stall, with nothing failing.
 */
const DEFAULT_INSTANCE: Instance = 'standard-1'
/** The longest a run lasts when it is given no timeout. */
const DEFAULT_TIMEOUT_MS = 60 * 60_000

/** The only way to the board: its own routes, with the token added here. */
export class BoardGate extends WorkerEntrypoint<Env, BoardProps> {
  fetch(request: Request): Promise<Response> | Response {
    const headers = boardHeaders(request, this.ctx.props)
    if (!headers) return new Response('Forbidden', { status: 403 })
    const out = new Request(request.url, request)
    for (const [name, value] of Object.entries(headers)) out.headers.set(name, value)
    // A redirect is handed back to the container, so the token never follows one to another host.
    return fetch(out, { redirect: 'manual' })
  }
}

/** The way to the agent's model: requests to the provider's host, with its key added here and nowhere else. */
export class ModelGate extends WorkerEntrypoint<Env, ModelProps> {
  fetch(request: Request): Promise<Response> | Response {
    if (!modelPasses(request, this.ctx.props)) return new Response('Forbidden', { status: 403 })
    const out = new Request(request.url, request)
    for (const [name, value] of Object.entries(this.ctx.props.headers)) out.headers.set(name, value)
    return fetch(out, { redirect: 'manual' })
  }
}

/** The repository, read only, while it is cloned: a private one's credential is added here, on its clone routes alone. */
export class RepoGate extends WorkerEntrypoint<Env, RepoProps> {
  fetch(request: Request): Promise<Response> | Response {
    if (!repoPasses(request, this.ctx.props)) return new Response('Forbidden', { status: 403 })
    const out = new Request(request.url, request)
    if (this.ctx.props.auth) out.headers.set('authorization', this.ctx.props.auth)
    return fetch(out, { redirect: 'manual' })
  }
}

/** What a host is left with once its part is done: nothing gets through. */
export class Closed extends WorkerEntrypoint<Env> {
  fetch(): Response {
    return new Response('Forbidden', { status: 403 })
  }
}

/** One run: its container, and the checks that keep it alive while the agent works and end it after. */
export class Run extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The idle timeout doesn't survive a restart of this object, a deploy among them.
    const container = ctx.container
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(IDLE_MS))
  }

  async start(input: Start): Promise<void> {
    const container = this.ctx.container!
    if (container.running) throw new Error('this run has already started')
    const repo = input.repo ? repoProps(input.repo, input.repoAuth) : undefined
    // Registered before start, so the certificate is there when the first process runs.
    await container.interceptOutboundHttps(input.board.host, this.ctx.exports.BoardGate({ props: input.board }))
    if (input.model) await container.interceptOutboundHttps(input.model.host, this.ctx.exports.ModelGate({ props: input.model }))
    if (repo) await container.interceptOutboundHttps(repo.host, this.ctx.exports.RepoGate({ props: repo }))
    container.start({ image: container.images.base, instance: this.env.INSTANCE || DEFAULT_INSTANCE, enableInternet: false, entrypoint: ['sleep', 'infinity'], env: { ...BASE_ENV, ...input.env } })
    await container.setInactivityTimeout(IDLE_MS)
    await this.ctx.storage.put('deadline', Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    await this.ctx.storage.setAlarm(Date.now() + CHECK_MS)
    try {
      for (const command of input.setup) await this.run(command, '/workspace', input.env)
      if (input.repo) await this.run(['git', 'clone', '--depth', '1', '--', input.repo, 'repo'], '/workspace', input.env)
    } catch (error) {
      await this.end(`setup failed: ${(error as Error).message}`)
      throw error
    }
    // The clone is done: the repository's host is closed before anything of it runs.
    if (repo) await container.interceptOutboundHttps(repo.host, this.ctx.exports.Closed)
    // The prompt goes in on stdin, so no part of it is read as a flag. The output goes to a file, and the exit code after it.
    await container.exec(['sh', '-c', `printf %s "$MUSTER_PROMPT" | "$@" > ${LOG} 2>&1; echo $? > ${EXIT}`, 'agent', ...input.command], {
      cwd: input.repo ? '/workspace/repo' : '/workspace',
      env: { ...BASE_ENV, ...input.env, MUSTER_PROMPT: input.prompt },
      stdout: 'ignore',
      stderr: 'ignore',
    })
  }

  /** Every minute: end the run once the agent has exited or its time is up, and keep it alive until then. */
  async alarm(): Promise<void> {
    const container = this.ctx.container!
    if (!container.running) return void (await this.end('the container stopped'))
    const deadline = (await this.ctx.storage.get<number>('deadline')) ?? 0
    const done = await this.capture(['sh', '-c', `cat ${EXIT} 2>/dev/null`])
    if (done.trim() !== '') return void (await this.end(`exit ${done.trim()}`))
    if (Date.now() > deadline) return void (await this.end('timed out'))
    await container.setInactivityTimeout(IDLE_MS)
    await this.ctx.storage.setAlarm(Date.now() + CHECK_MS)
  }

  async stop(): Promise<void> {
    await this.end('stopped')
  }

  /** Runs one setup command and waits for it: a failed one ends the run, not the agent's start. */
  private async run(command: string[], cwd: string, env: Record<string, string>): Promise<void> {
    const process = await this.ctx.container!.exec(command, { cwd, env: { ...BASE_ENV, ...env } })
    const output = await process.output()
    if (output.exitCode !== 0) throw new Error(`${command[0]} exited ${output.exitCode}: ${new TextDecoder().decode(output.stderr).slice(-500)}`)
  }

  private async capture(command: string[]): Promise<string> {
    const process = await this.ctx.container!.exec(command, { env: BASE_ENV })
    return new TextDecoder().decode((await process.output()).stdout)
  }

  /** Ends the run: the tail of the agent's output goes to the Worker's logs, then the container and this object's state go. */
  private async end(why: string): Promise<void> {
    const container = this.ctx.container!
    let tail = ''
    if (container.running) tail = await this.capture(['sh', '-c', `tail -c 2000 ${LOG} 2>/dev/null`]).catch(() => '')
    console.log(JSON.stringify({ event: 'run.ended', why, tail }))
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    if (container.running) await container.destroy()
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Whoever holds the secret starts containers that run a command of their choosing: a runner with none set starts nothing.
    if (!usable(env.RUNNER_SECRET)) return new Response('This runner has no RUNNER_SECRET of 16 characters or more: set one with wrangler secret put.', { status: 500 })
    if (!(await authorized(request.headers.get('authorization'), env.RUNNER_SECRET))) return new Response('Unauthorized', { status: 401 })
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/runs') {
      const id = crypto.randomUUID()
      await env.RUNS.get(env.RUNS.idFromName(id)).start((await request.json()) as Start)
      return Response.json({ id })
    }
    const stop = /^\/runs\/([^/]+)\/stop$/.exec(url.pathname)
    if (request.method === 'POST' && stop) {
      await env.RUNS.get(env.RUNS.idFromName(stop[1]!)).stop()
      return Response.json({ id: stop[1] })
    }
    return new Response('Not found', { status: 404 })
  },
}
