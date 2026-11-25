# factory

An agent that hears what happens on a board and answers what is for it:
issues, pull requests and chat come in by sync, a watcher wakes the agent with
a pointer to the thread, and the agent reads the thread and decides.

It is a board module, a host that runs its watcher, and a small page:
`pnpm dev` shows what is set up and what isn't, who runs each part, the
week's threads, and at `/board` every thread, where you read and reply from
a browser.

| File | What it is |
| --- | --- |
| `lib/board.ts` | The board module: the board, and the watcher `factory` that wakes the agent on new activity under `factory/` |
| `lib/wake.ts` | Starts one agent session on one thread, with a pointer to it |
| `host.ts` | Runs the watcher, in a process of its own, until stopped |
| `sync.json` | GitHub issues and pull requests into `factory/` channels, read by `mu serve` |
| `AGENT.md` | What the agent is told about working with people |

```bash
cp sync.json ~/.config/muster/
export GITHUB_WEBHOOK_SECRET=...        # named in sync.json, never written there
mu serve --allow-host <your host>        # takes the webhooks, syncs, sends schedules
pnpm host                                # node host.ts: runs the watcher
```

`host.ts` holds the board's lease `watch:factory`: of any number of hosts on
one board, one wakes the agent at a time, and another takes over within 30
seconds of it dying. SIGTERM or SIGINT stops it once the wake in flight has
been recorded. `mu serve` holds `tick`. The page says who holds each. Check
that the watcher wakes the agent and that the agent answers:

```bash
mu daemon check factory --module "$PWD/lib/board.ts" --in factory/issues
```

If `~/.config/muster/watchers.json` still has a `factory` watcher from an
earlier copy of this template, remove it: `host.ts` refuses to run a watcher
that is in that file and in code under one name.

Point the GitHub App's webhook at `https://<your host>/api/board/webhooks/gh`.
`mu serve` listens on 127.0.0.1, so it needs a tunnel or a proxy with a public
HTTPS name, passed with `--allow-host <name>`.

TODO: sync moves into `lib/board.ts` once `board({ sync })` lands, and the
app's `/api/board` takes the webhooks. Until then `sync.json` stays in the
config folder for `mu serve`, which runs without a module. Don't give `mu
serve` this module: with one it doesn't read `sync.json` (it warns, and
syncs nothing).

As shipped, `sync.json` brings issues and pull requests in and sends nothing
back. For the agent's replies to be posted as comments, add
`"token": "env:GITHUB_TOKEN"` beside `secret` and `"mirror": true` to the
repository. Sync has not been run against GitHub yet.

The page has no sign-in, and its reply form writes as you: whoever can reach
it can. `pnpm dev` listens on 127.0.0.1 only, so that is this machine.
It also answers only requests that came for this machine's own name
(`proxy.ts`), so a page on another site can't reach it through your browser
under a name of its own. Behind something that asks who is there, list the
name it is reached by in `ALLOW_HOSTS`, comma-separated.

The app also serves the board itself at `/api/board`
(`app/api/board/[...path]/route.ts`: `export const GET = team.fetch`): what
`mu serve` serves, for the same names, and every request needs a token from
`mu token create`. Its handle has no `sync` yet, so point webhooks at
`mu serve` as above. A token is checked with a key kept in muster's config
folder, so the app must see the same one as the `mu` that made the token:
the same `HOME`, or the same `MUSTER_CONFIG`. Every name the app is reached
by goes in `ALLOW_HOSTS`, each preview domain included: a request for any
other name is refused. `proxy.ts` leaves `/api/board/` out, because Next.js
cuts a body that passes through a proxy at 10 MB, under the board's limit for
a file; those routes check the name themselves.

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

