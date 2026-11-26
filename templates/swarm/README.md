# swarm

A page to launch a swarm of agents on one goal, and a live view of their
queue. The queue is a muster board's tasks: a run is a thread, its plan is one
task, and each agent is a `mu run` process that takes the next ready task.

```bash
pnpm install
pnpm dev            # the launcher at http://localhost:3000, the live view at /live
pnpm test
```

It uses the default board on this machine, or the one at `MUSTER_URL` with
`MUSTER_TOKEN`. `SWARM_CHANNEL` names the prefix its tasks live under
(default `swarm`). `MUSTER_BIN` names the `mu` to start workers with.

The page has no sign-in: whoever can reach it can launch agents as you.
`pnpm dev` listens on 127.0.0.1 only, so that is this machine. Don't put it
on a network without something in front that asks who is there.
It also answers only requests that came for this machine's own name
(`proxy.ts`), so a page on another site can't reach it through your browser
under a name of its own. Behind something that asks who is there, list the
name it is reached by in `ALLOW_HOSTS`, comma-separated.

Agents run as local processes, with the access of whoever started the page,
or in cloud sandboxes when you pick a runner. Launch runs only on code you
would run yourself.

- **Vercel:** each agent is a worker on this machine that gives every task a
  sandbox of its own: a fresh clone of the repository, its dependencies
  installed, the agent's changes pushed to `mu/task-<id>` and a pull request
  opened, one per task. It needs the board at a URL the sandboxes reach
  (`MUSTER_URL`, or `MUSTER_SANDBOX_URL` when this machine has the board),
  the Vercel and model credentials `mu run --runner vercel` reads, and for
  pull requests a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_KEY_FILE`).
- **E2B:** as Vercel, a sandbox and a pull request per task, with what
  `mu run --runner e2b` reads: `E2B_API_KEY`, `MUSTER_E2B_TEMPLATE`, and
  `MUSTER_E2B_KEY_ANY_PATH=1` to use a model key there. See muster's guide,
  Agents in cloud sandboxes.
- **Cloudflare:** each agent is a sandbox that takes tasks itself, with a
  token you make for it in `MUSTER_AGENT_TOKEN`. It makes no pull requests.

`JOIN.md` is what you paste into a coding agent to join a run's queue by hand.

## Registered workflows

`workflows.json` here is an example for `~/.config/muster/workflows.json`: an
`implement` workflow (plan, then work, then review) and a `review` workflow,
each started with `mu workflow run <name> --on <thread>` instead of this page.
Change `who`, `channels` and `repo` before you copy it. See
[Workflows](../../packages/muster/docs/01-concepts/16-workflows.md).

## Outside this repository

Here the app uses the muster in this checkout (`workspace:*`). In a copy of
your own, point the dependency at a release instead:

```json
"@openmuster/muster": "0.3.1-alpha.2"
```
