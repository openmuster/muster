# factory

An agent that hears what happens on a board and answers what is for it:
issues, pull requests and chat come in by sync, a watcher wakes the agent with
a pointer to the thread, and the agent reads the thread and decides.

It is a board module, a host that runs it, and a small page: `pnpm dev`
shows what is set up and what isn't, who runs each part, the week's
threads, and at `/board` every thread, where you read and reply from a
browser. The app also takes GitHub's webhooks.

| File | What it is |
| --- | --- |
| `lib/board.ts` | The board module: the board, its GitHub sync (issues and pull requests into `factory/` channels), and the watcher `factory` that wakes the agent on new activity under `factory/` |
| `lib/wake.ts` | Starts one agent session on one thread, with a pointer to it |
| `host.ts` | Runs the watcher and the sync, in a process of its own, until stopped |
| `app/api/board/[...path]/route.ts` | The board at `/api/board`, GitHub's webhook among it: `team.fetch` |
| `AGENT.md` | What the agent is told about working with people |

Put your repository in place of `acme/web` in `lib/board.ts`. Then, each in
its own terminal:

```bash
export GITHUB_WEBHOOK_SECRET=...        # named in lib/board.ts with env(), never written there
pnpm dev                                 # the page, and the webhook at /api/board/webhooks/gh
pnpm host                                # node host.ts: the watcher, the sync's catch-up and sending
mu daemon run --no-module                # sends schedules (or mu serve --no-module)
```

Point the GitHub App's webhook at `https://<your host>/api/board/webhooks/gh`,
and list `<your host>` in `ALLOW_HOSTS`. The app listens on 127.0.0.1, so it
needs a tunnel or a proxy with a public HTTPS name. The app and `host.ts`
both read `GITHUB_WEBHOOK_SECRET`: the app when it takes its first request,
answering the webhook 503 while it is unset; `host.ts` when it starts,
refusing to start, naming it, while it is unset. A webhook only brings a
thread in: the catch-up on what GitHub changed while nothing listened, and
anything sent back, run in `host.ts`.

`host.ts` holds the board's leases `watch:factory` and `sync`: of any number
of hosts on one board, one wakes the agent and one syncs at a time, and
another takes over within 30 seconds of one dying. SIGTERM or SIGINT stops
it once the wake in flight has been recorded. The daemon holds `tick`. The
page says who holds each. Check that the watcher wakes the agent and that
the agent answers:

```bash
mu daemon check factory --module "$PWD/lib/board.ts" --in factory/issues
```

Run the daemon without a module (`--no-module`, or with no
`~/.config/muster/board.ts`): `host.ts` runs this one. If
`~/.config/muster/` has a `watchers.json`, `sync.json` or `hooks.json` from
an earlier copy of this template, move what else they hold into a board
module and delete them: those files are no longer read, and `mu daemon run`
and `mu serve` refuse to start while one is there. The page says so.

As shipped, the sync brings issues and pull requests in and sends nothing
back. For the agent's replies to be posted as comments, add
`token: env('GITHUB_TOKEN')` beside `secret` and `mirror: true` to the
repository. Sync has not been run against GitHub yet.

The page has no sign-in, and its reply form writes as you: whoever can reach
it can. `pnpm dev` listens on 127.0.0.1 only, so that is this machine.
It also answers only requests that came for this machine's own name
(`proxy.ts`), so a page on another site can't reach it through your browser
under a name of its own. Behind something that asks who is there, list the
name it is reached by in `ALLOW_HOSTS`, comma-separated.

The app serves the board itself at `/api/board`
(`app/api/board/[...path]/route.ts`: `export const GET = team.fetch`): what
`mu serve` serves, for the same names. Every request but a webhook needs a
token from `mu token create`. A token is checked with a key kept in muster's
config folder, so the app must see the same one as the `mu` that made the
token: the same `HOME`, or the same `MUSTER_CONFIG`. Every name the app is
reached by goes in `ALLOW_HOSTS`, each preview domain included: a request
for any other name is refused. `proxy.ts` leaves `/api/board/` out, because
Next.js cuts a body that passes through a proxy at 10 MB, under the board's
limit for a file; those routes check the name themselves.

The wake starts with a clean environment: `PATH`, `HOME`, the board's own
variables and a pointer to the thread (`MUSTER_THREAD`, `MUSTER_EVENT`, ...).
It gets nothing else of the host's environment but the names in `PASS` in
`lib/board.ts`: add a name there to pass it on. The agent it starts on this
machine gets less again: what any process needs, the pointer and
`ANTHROPIC_API_KEY` (`AGENT_ENV` in `lib/wake.ts`). A thread's messages within
30 seconds are one wake (`FACTORY_COALESCE`, such as `10s`), and a session
that runs past two hours is stopped and tried again.

Edit `lib/wake.ts` to start your agent. As shipped it runs Claude Code
headless (`FACTORY_AGENT`, default `claude --print`) in the host's folder,
with the pointer prompt on stdin; the agent's instructions are `AGENT.md`.

### In `next dev` instead of a host

`host.ts` is the way to run the watcher. For a quick try in development, it
can run inside the dev server, from an `instrumentation.ts` beside
`next.config.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { team } = await import('./lib/board')
    team.start() // never await: the server would never start
  }
}
```

Only in development: an edit to the watcher needs the dev server restarted,
the board's calls hold up the page's requests while it delivers, and it
doesn't stop cleanly. Keep the guard and the dynamic import: a static import
builds, then fails every edge route at runtime.

## Outside this repository

Here the app uses the `muster` in this checkout (`workspace:*`). In a copy of
your own, point the dependency at a release instead:

```json
"muster": "https://github.com/openmuster/muster/releases/download/v0.3.0/muster-0.3.0.tgz"
```

## In a Vercel sandbox

By default `lib/wake.ts` starts the agent on this machine. With
`FACTORY_RUNNER=vercel` each wake runs in a Vercel sandbox instead: the wake
becomes a task in `factory-runs` (outside `factory/`, so it wakes nothing,
and keyed by the event, so a wake tried again makes no second one),
and `mu run --runner vercel` works it there, with a token for `factory/` and
`factory-runs` that lasts an hour. `FACTORY_REPO` clones a repository into
the sandbox and installs its dependencies; `FACTORY_PUSH=1` opens a pull
request with what the agent changed, through your GitHub App. The host
then needs the board at a URL sandboxes reach (`MUSTER_SANDBOX_URL`) and what
`mu run --runner vercel` reads, listed in `SANDBOX` in `lib/board.ts`. Those
reach the wake only with `FACTORY_RUNNER=vercel` in the host's environment,
and from there only `mu run`: never an agent on this machine. See muster's
guide, Agents in cloud sandboxes.

In a sandbox the agent can't reach your machine, and it reaches no host but
the board and its model: it can read code, run tests and answer, not run
your app against your services.

