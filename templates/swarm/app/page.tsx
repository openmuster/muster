import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { redirect } from 'next/navigation'
import { SWARM, team, tilde } from '@/lib/board'
import { AGENTS_MAX, launch } from '@/lib/run'

export const dynamic = 'force-dynamic'

async function start(form: FormData) {
  'use server'
  const slug = String(form.get('slug') ?? '')
  // A form's fields are whatever the request sent, not what the page offered. The agent is one of the two
  // the page lists (`launch` refuses anything else), and the folder is a folder that is there.
  const cwd = String(form.get('cwd') ?? process.cwd())
  if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error('The working folder is a full path to a folder on this machine.')
  await launch(
    team(),
    SWARM,
    {
      goal: String(form.get('goal') ?? ''),
      slug,
      agents: Number(form.get('agents') ?? 1),
      agent: String(form.get('agent') ?? 'claude'),
      cwd,
      runner: String(form.get('runner') ?? 'local') as 'local' | 'vercel' | 'cloudflare',
      ...(form.get('repo') ? { repo: String(form.get('repo')) } : {}),
      push: form.get('push') === 'on',
    },
    // Each worker is its own process, in its own group, so it outlives this request.
    (worker) => spawn(process.env.MUSTER_BIN ?? 'mu', worker.argv, { cwd: worker.cwd, detached: true, stdio: 'ignore', env: process.env }).unref(),
  )
  redirect(`/live?run=${encodeURIComponent(slug)}`)
}

export default async function Page() {
  const me = await team().whoami()
  const runs = (await team().readChannel({ channel: `${SWARM}/runs`, limit: 20 }).catch(() => ({ threads: [] }))).threads
  return (
    <>
      <h1>swarm</h1>
      <p className="dim">board {tilde(me.where)} · tasks under #{SWARM}/</p>
      <form action={start}>
        <label htmlFor="goal">goal</label>
        <textarea id="goal" name="goal" rows={3} required placeholder="what the agents should get done" />
        <div className="row">
          <div className="field wide">
            <label htmlFor="slug">run name</label>
            <input id="slug" name="slug" required pattern="[a-z0-9][a-z0-9-]{0,30}" placeholder="checkout-limiter" />
          </div>
          <div className="field">
            <label htmlFor="agents">agents</label>
            <input id="agents" name="agents" type="number" min={1} max={AGENTS_MAX} defaultValue={2} />
          </div>
          <div className="field">
            <label htmlFor="agent">agent</label>
            <select id="agent" name="agent" defaultValue="claude">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="runner">runs</label>
            <select id="runner" name="runner" defaultValue="local">
              <option value="local">on this machine</option>
              <option value="vercel">in Vercel Sandbox</option>
            </select>
          </div>
          <div className="field wide">
            <label htmlFor="cwd">working folder (this machine)</label>
            <input id="cwd" name="cwd" defaultValue={process.cwd()} />
          </div>
        </div>
        <label htmlFor="repo">repository to clone (cloud)</label>
        <input id="repo" name="repo" placeholder="https://github.com/acme/web.git" />
        <label className="check">
          <input type="checkbox" name="push" defaultChecked />
          a pull request per task (Vercel, with a repository; needs a GitHub App)
        </label>
        <button type="submit">launch</button>
      </form>
      <h2>runs</h2>
      {runs.length === 0 && <p className="dim">none yet</p>}
      {runs.map((thread) => (
        <div className="task" key={thread.message.id}>
          <a href={`/live?run=${encodeURIComponent(thread.message.labels.run ?? '')}`}>{thread.message.text}</a>
        </div>
      ))}
      <p className="dim">
        <a href="/live">live view of every run</a>
      </p>
    </>
  )
}
