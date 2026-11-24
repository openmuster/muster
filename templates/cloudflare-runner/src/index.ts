import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
import { authorized, usable } from './auth.ts'
import { type BoardProps, type ModelProps, type RepoProps, boardHeaders, modelPasses, repoPasses, repoProps } from './gates.ts'
import { capStream, decide, ended, execRequest, exitCode, readCapped } from './lifecycle.ts'

type Start = { task: number; command: string[]; prompt: string; env: Record<string, string>; board: BoardProps; model?: ModelProps; repo?: string; repoAuth?: string; setup: string[][]; timeoutMs?: number; attach?: boolean }
type Instance = 'lite' | 'basic' | 'standard-1' | 'standard-2' | 'standard-3' | 'standard-4'
type Env = { RUNNER_SECRET: string; RUNS: DurableObjectNamespace<Run>; INSTANCE?: Instance; LOG_TAIL?: string }

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

/** What `start` hands back: where the checkout started, so what the agent changed can be told from what was there. */
type Started = { checkout?: { sha: string; branch: string }; /** Why the run didn't start, for whoever asked: answered, never thrown, so it is in no log. */ failed?: string }
/** A run as the CLI sees it: `exited` while the container is kept to be read, `running` before. */
type Status = { state: 'running' | 'exited'; exitCode: number | null }

/** A call from the CLI into a kept container: how long it may take, and the most of its output that is read. */
const CALL_MS = 120_000
const OUTPUT_MAX = 64 * 1024
/** The biggest file read out of a container: it is held whole in the run's object, which has 128 MB. */
const FILE_MAX = 64 * 1024 * 1024
/** Git, read with none of the configuration a repository or its user could have set. */
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }

/** One run: its container, and the checks that keep it alive while the agent works and end it after. */
export class Run extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The idle timeout doesn't survive a restart of this object, a deploy among them.
    const container = ctx.container
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(IDLE_MS))
  }

  async start(input: Start): Promise<Started> {
    const container = this.ctx.container!
    if (container.running || (await this.ctx.storage.get('started'))) throw new Error('this run has already started')
    const repo = input.repo ? repoProps(input.repo, input.repoAuth) : undefined
    // What is opened is written down first, so it can all be closed again; the credentials stay in the gates' props alone.
    const hosts = [input.board.host, ...(input.model ? [input.model.host] : []), ...(repo ? [repo.host] : [])]
    await this.ctx.storage.put({ started: true, hosts, attach: input.attach === true, repo: Boolean(repo), deadline: Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
    // Registered before start, so the certificate is there when the first process runs.
    await container.interceptOutboundHttps(input.board.host, this.ctx.exports.BoardGate({ props: input.board }))
    if (input.model) await container.interceptOutboundHttps(input.model.host, this.ctx.exports.ModelGate({ props: input.model }))
    if (repo) await container.interceptOutboundHttps(repo.host, this.ctx.exports.RepoGate({ props: repo }))
    container.start({ image: container.images.base, instance: this.env.INSTANCE || DEFAULT_INSTANCE, enableInternet: false, entrypoint: ['sleep', 'infinity'], env: { ...BASE_ENV, ...input.env } })
    await container.setInactivityTimeout(IDLE_MS)
    await this.ctx.storage.setAlarm(Date.now() + CHECK_MS)
    let checkout: Started['checkout']
    try {
      for (const command of input.setup) await this.run(command, '/workspace', input.env)
      if (input.repo) {
        await this.run(['git', 'clone', '--depth', '1', '--', input.repo, 'repo'], '/workspace', input.env)
        // Read before anything the agent decides runs, with none of the repository's own git configuration.
        const head = await this.capture(['sh', '-c', 'git rev-parse HEAD && git symbolic-ref --short -q HEAD'], '/workspace/repo', GIT_ENV)
        const [sha, branch] = head.trim().split('\n')
        if (sha && branch) checkout = { sha, branch }
      }
    } catch (error) {
      // What the command printed goes back to whoever started the run, as the answer: thrown, it would be an
      // exception in the Worker's logs.
      await this.end('setup failed')
      return { failed: (error as Error).message }
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
    return checkout ? { checkout } : {}
  }

  /** The run as it is now, null when there is none. The agent's exit is checked here too, so the CLI doesn't wait for the next check. */
  async status(): Promise<Status | null> {
    if (!(await this.ctx.storage.get('started'))) return null
    if (!this.ctx.container!.running) return null
    // Exited means closed too: nothing reads the container before that, and a run that couldn't be closed has ended.
    if (!(await this.exited())) return (await this.ctx.storage.get('started')) ? { state: 'running', exitCode: null } : null
    return { state: 'exited', exitCode: (await this.ctx.storage.get<number | null>('exitCode')) ?? null }
  }

  /** Every minute: end the run once its agent is done and nobody reads it, or its time is up, and keep it alive until then. */
  async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get('started'))) return
    const container = this.ctx.container!
    if (container.running) await this.exited()
    const stored = await this.ctx.storage.get(['deadline', 'attach', 'exitedAt', 'busyUntil'])
    const verdict = decide({
      now: Date.now(),
      running: container.running,
      deadline: (stored.get('deadline') as number | undefined) ?? 0,
      attach: stored.get('attach') === true,
      exitedAt: stored.get('exitedAt') as number | undefined,
      busyUntil: stored.get('busyUntil') as number | undefined,
    })
    if (verdict === 'end') return void (await this.end(stored.get('exitedAt') === undefined ? 'timed out' : 'done'))
    await container.setInactivityTimeout(IDLE_MS)
    // stop() may have ended the run while this one waited on the container: an ended run gets no new alarm.
    if (await this.ctx.storage.get('started')) await this.ctx.storage.setAlarm(Date.now() + CHECK_MS)
  }

  /** Whether the run's way out is closed: the agent's exit closes it, and a CLI asking makes sure that happened. */
  async close(): Promise<boolean> {
    if (!(await this.ctx.storage.get('started'))) return false
    // Closed once, when the agent exited; a run still working is not closed under it.
    return this.exited()
  }

  /** Runs one command in the kept container, after the agent exited and everything was closed: its exit code and the start of its output. */
  async exec(command: { cmd: string; args: string[]; env?: Record<string, string> }): Promise<{ exitCode: number | null; stdout: string } | null> {
    if (!(await this.ready())) return null
    await this.busy()
    {
      const process = await this.ctx.container!.exec(['timeout', '--kill-after=5', String(CALL_MS / 1000), command.cmd, ...command.args], {
        cwd: (await this.ctx.storage.get('repo')) ? '/workspace/repo' : '/workspace',
        env: { ...BASE_ENV, ...(command.env ?? {}) },
        stderr: 'ignore',
      })
      // Read no further than the limit, whatever the command prints: then it is stopped.
      const stdout = await readCapped(process.stdout, OUTPUT_MAX, () => process.kill())
      return { exitCode: await process.exitCode, stdout: new TextDecoder().decode(stdout) }
    }
  }

  /**
   * A regular file in the kept container, streamed, no bigger than `max` bytes: null when there is none, it is
   * something else, or it is bigger. A stream, because a whole bundle is more than one call to this object may carry.
   */
  async file(path: string, max: number): Promise<ReadableStream<Uint8Array> | null> {
    if (!(await this.ready())) return null
    await this.busy()
    const container = this.ctx.container!
    // A link, a pipe or a device is not a file to hand out; nothing of the agent's still runs to swap it after this.
    const size = Number((await this.capture(['sh', '-c', '[ -f "$1" ] && [ ! -L "$1" ] && stat -c %s -- "$1"', 'sh', path])).trim())
    if (!Number.isSafeInteger(size) || size > max) return null
    const process = await container.exec(['timeout', '--kill-after=5', String(CALL_MS / 1000), 'head', '-c', String(max + 1), '--', path], { env: BASE_ENV, stderr: 'ignore' })
    return process.stdout ? capStream(process.stdout, max) : null
  }

  async stop(): Promise<void> {
    if (await this.ctx.storage.get('started')) await this.end('stopped')
  }

  /** Whether the CLI may reach into the container: only once the agent has exited and its way out is closed. */
  private async ready(): Promise<boolean> {
    if (!(await this.ctx.storage.get('started')) || !this.ctx.container!.running) return false
    return this.exited()
  }

  /** A call from the CLI holds the container this long at least; calls only ever push it later, never clear it. */
  private async busy(): Promise<void> {
    const until = Date.now() + CALL_MS + 60_000
    const before = (await this.ctx.storage.get<number>('busyUntil')) ?? 0
    if (until > before) await this.ctx.storage.put('busyUntil', until)
  }

  /**
   * Whether the agent has exited and the run is closed, by the file the agent's shell writes. The first caller to
   * see it closes everything the run opened and stops whatever was left running; every other caller waits for that
   * same closing, so nothing reads the container, or is killed, while it happens.
   * The file is the agent's to write too: writing it early only ends its own run sooner.
   */
  private async exited(): Promise<boolean> {
    if ((await this.ctx.storage.get('closed')) === true) return true
    if (!this.shutting) {
      const marker = await this.capture(['sh', '-c', `cat ${EXIT} 2>/dev/null`]).catch(() => '')
      if (marker.trim() === '') return false
      this.shutting ??= (async () => {
        if ((await this.ctx.storage.get('exitedAt')) === undefined) await this.ctx.storage.put({ exitedAt: Date.now(), exitCode: exitCode(marker) })
        await this.shut()
      })().finally(() => {
        this.shutting = undefined
      })
    }
    await this.shutting
    return (await this.ctx.storage.get('closed')) === true
  }

  private shutting: Promise<void> | undefined

  /** Every host the run opened gets the handler that refuses all, then every process but the container's own is killed. */
  private async shut(): Promise<void> {
    const container = this.ctx.container!
    if (!container.running) return
    try {
      for (const host of (await this.ctx.storage.get<string[]>('hosts')) ?? []) await container.interceptOutboundHttps(host, this.ctx.exports.Closed)
      // `kill -1` reaches every process but init and the one sending it.
      await this.capture(['sh', '-c', 'kill -KILL -1 2>/dev/null; true'])
      await this.ctx.storage.put('closed', true)
    } catch (error) {
      // A run that can't be closed is never read from: it ends.
      await this.end('closing failed')
    }
  }

  /** Runs one setup command and waits for it: a failed one ends the run, not the agent's start. */
  private async run(command: string[], cwd: string, env: Record<string, string>): Promise<void> {
    const process = await this.ctx.container!.exec(command, { cwd, env: { ...BASE_ENV, ...env } })
    const output = await process.output()
    if (output.exitCode !== 0) throw new Error(`${command[0]} exited ${output.exitCode}: ${new TextDecoder().decode(output.stderr).slice(-500)}`)
  }

  private async capture(command: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
    const process = await this.ctx.container!.exec(command, { ...(cwd ? { cwd } : {}), env: { ...BASE_ENV, ...env }, stderr: 'ignore' })
    const stdout = await readCapped(process.stdout, OUTPUT_MAX, () => process.kill())
    await process.exitCode
    return new TextDecoder().decode(stdout)
  }

  /** Ends the run: why and the agent's exit code go to the Worker's logs (and the tail of its output with LOG_TAIL=1), then the container and this object's state go. */
  private async end(why: string): Promise<void> {
    const container = this.ctx.container!
    const code = (await this.ctx.storage.get<number | null>('exitCode')) ?? null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    let tail = ''
    if (this.env.LOG_TAIL === '1' && container.running) tail = await this.capture(['sh', '-c', `tail -c 2000 ${LOG} 2>/dev/null`]).catch(() => '')
    console.log(JSON.stringify(ended(why, code, tail, this.env.LOG_TAIL)))
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
      const started = await env.RUNS.get(env.RUNS.idFromName(id)).start((await request.json()) as Start)
      // Why a run didn't start is for whoever asked, who holds the secret.
      if (started.failed !== undefined) return new Response(`The run didn't start: ${started.failed}`, { status: 502 })
      return Response.json({ id, ...started })
    }
    // A run is named by the ID start gave it, and nothing else reaches one.
    const route = /^\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(stop|close|exec|file))?$/.exec(url.pathname)
    if (!route) return new Response('Not found', { status: 404 })
    const run = env.RUNS.get(env.RUNS.idFromName(route[1]!))
    const action = route[2]
    const gone = () => new Response('No such run, or it has ended', { status: 404 })
    if (request.method === 'GET' && action === undefined) {
      const status = await run.status()
      return status ? Response.json(status) : gone()
    }
    if (request.method === 'POST' && action === 'stop') {
      await run.stop()
      return Response.json({ id: route[1] })
    }
    if (request.method === 'POST' && action === 'close') return (await run.close()) ? Response.json({ closed: true }) : gone()
    // These two reach into the container, and only once its agent has exited and its way out is closed.
    if (request.method === 'POST' && action === 'exec') {
      const command = execRequest(await request.json().catch(() => null))
      if (!command) return new Response('exec takes { cmd, args, env } of strings', { status: 400 })
      const done = await run.exec(command)
      return done ? Response.json(done) : new Response('The run is not exited and closed', { status: 409 })
    }
    if (request.method === 'GET' && action === 'file') {
      const path = url.searchParams.get('path') ?? ''
      const max = Number(url.searchParams.get('max'))
      if (!path.startsWith('/') || !Number.isSafeInteger(max) || max < 0 || max > FILE_MAX) return new Response(`file takes an absolute path and a max of at most ${FILE_MAX}`, { status: 400 })
      const stream = await run.file(path, max)
      return stream ? new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }) : new Response('No such file, or it is bigger than max', { status: 404 })
    }
    return new Response('Not found', { status: 404 })
  },
}
