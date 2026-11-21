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

Agents run as local processes, with the access of whoever started the page.
Launch runs only on code you would run yourself. To run agents in cloud
sandboxes instead, start them with muster's `vercel()` or `cloudflare()`
runner against a board served at a URL they can reach.

`JOIN.md` is what you paste into a coding agent to join a run's queue by hand.

## Outside this repository

Here the app uses the `muster` in this checkout (`workspace:*`). In a copy of
your own, point the dependency at a release instead:

```json
"muster": "https://github.com/openmuster/muster/releases/download/v0.1.2/muster-0.1.2.tgz"
```
