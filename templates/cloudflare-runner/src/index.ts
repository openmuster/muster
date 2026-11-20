// NOT RUN. Written against Cloudflare's Containers docs; check each call against the current API.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'

type Rule = { match: { path: string; method: string[] }; transform: { headers: Record<string, string> }[] }
type Start = { task: number; command: string[]; prompt: string; env: Record<string, string>; board: { host: string; rules: Rule[]; token: string }; model?: { host: string; headers: Record<string, string> }; repo?: string; setup: string[][] }
type Env = { RUNNER_SECRET: string; RUNS: DurableObjectNamespace<Run> }

/** The only way out of the container: requests to the board, on the board's own routes, with the token added here. */
export class BoardGate extends WorkerEntrypoint<Env, { host: string; rules: Rule[]; token: string }> {
  fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url)
    const { host, rules, token } = this.ctx.props
    // The intercept matches the TLS server name; the URL comes from a header the container controls.
    if (url.protocol !== 'https:' || url.host !== host) return new Response('Forbidden', { status: 403 })
    if (/%2f|%5c|\\|\/\.\.?(\/|$)/i.test(request.url)) return new Response('Forbidden', { status: 403 })
    const rule = rules.find((candidate) => candidate.match.method.includes(request.method) && new RegExp(candidate.match.path).test(url.pathname))
    if (!rule) return new Response('Forbidden', { status: 403 })
    const out = new Request(url, request)
    out.headers.set('authorization', `Bearer ${token}`)
    // A redirect is handed back to the container, so the token never follows one to another host.
    return fetch(out, { redirect: 'manual' })
  }
}

/** The way to the agent's model: requests to the provider's host, with its key added here and nowhere else. */
export class ModelGate extends WorkerEntrypoint<Env, { host: string; headers: Record<string, string> }> {
  fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url)
    const { host, headers } = this.ctx.props
    if (url.protocol !== 'https:' || url.host !== host) return new Response('Forbidden', { status: 403 })
    const out = new Request(url, request)
    for (const [name, value] of Object.entries(headers)) out.headers.set(name, value)
    // A redirect is handed back to the container, so the key never follows one to another host.
    return fetch(out, { redirect: 'manual' })
  }
}

export class Run extends DurableObject<Env> {
  async start(input: Start): Promise<void> {
    const container = this.ctx.container!
    if (container.running) return
    await container.interceptOutboundHttps(input.board.host, this.ctx.exports.BoardGate({ props: input.board }))
    if (input.model) await container.interceptOutboundHttps(input.model.host, this.ctx.exports.ModelGate({ props: input.model }))
    container.start({ image: container.images.base, enableInternet: false, env: input.env })
    for (const command of input.setup) await (await container.exec(command, { cwd: '/workspace' })).output()
    if (input.repo) await (await container.exec(['git', 'clone', '--depth', '1', '--', input.repo, 'repo'], { cwd: '/workspace' })).output()
    // The prompt goes in on stdin, so no part of it is read as a flag.
    await container.exec(['sh', '-c', 'printf %s "$MUSTER_PROMPT" | "$@"', 'agent', ...input.command], {
      cwd: input.repo ? '/workspace/repo' : '/workspace',
      env: { ...input.env, MUSTER_PROMPT: input.prompt },
    })
  }

  async stop(): Promise<void> {
    await this.ctx.container!.destroy()
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${env.RUNNER_SECRET}`) return new Response('Unauthorized', { status: 401 })
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
