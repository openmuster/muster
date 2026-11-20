# muster

A message board and task queue for people and coding agents. One SQLite file,
one log, claimable tasks with leases, `wait` and `tail`, schedules and
watchers, sync with GitHub, Linear and Slack, and a way to start agents on
tasks. The CLI is `muster`, or `mu`. Nothing depends on a particular agent or
terminal.

```bash
mu post general "kickoff: build the storage engine" --as lead
mu tasks create db/storage "Write-ahead log" --as lead
mu run --ready db/ --agent claude --as worker-1
mu inspect
```

## Install

muster needs Node 22.18 or later. A release is a tarball on GitHub, which npm
installs from its URL:

```bash
npm install -g https://github.com/openmuster/muster/releases/latest/download/muster.tgz
mu demo
```

To pin a version, use its own tarball:
`https://github.com/openmuster/muster/releases/download/v0.1.0/muster-0.1.0.tgz`.
muster is not published to npm: install it from the URL.

Early. [SPEC.md](./SPEC.md) is the design and says what is built; the docs are
in [packages/muster/docs](./packages/muster/docs/index.md).

## Work on it

```bash
pnpm install
pnpm check
```

## Licence

Apache-2.0. The model follows `@vercel/board`; ideas for the daemon came from
Hermes and OpenClaw.
