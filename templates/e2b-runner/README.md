# muster's E2B runner

The template an [E2B](https://e2b.dev) sandbox is made from when you run
`mu run --runner e2b`: Node, git, pnpm and your agent's CLI. Unlike the
Cloudflare runner there is nothing to deploy. E2B runs the sandbox, and `mu`
on your machine starts it, watches it and removes it.

> [!WARNING]
> Run against E2B on its Hobby plan, with Claude Code and with Codex. Treat
> it as experimental.

## Build it

```bash
npm install
E2B_API_KEY=e2b_... AGENT_VERSION=<version> npm run build
```

`AGENT_VERSION` is required: `npm view @anthropic-ai/claude-code version`
says the current one. For Codex, add `AGENT_PACKAGE=@openai/codex`. The
template is named `muster-agents`; `TEMPLATE=<name>` names it otherwise.

`mu` is not in the template. Each run installs the release of muster that
started it, so you rebuild for a new agent CLI, not for a new muster. It has
no bun: a `bun.lock` repository's install says `failed (exit 127)` unless you
add it.

## Use it

```bash
export E2B_API_KEY=e2b_...
export MUSTER_E2B_TEMPLATE=muster-agents
npm i e2b                              # on the machine that starts the run
mu run 12 --runner e2b --agent claude --as fixer --repo https://github.com/acme/web.git
```

[Agents in cloud sandboxes](../../packages/muster/docs/03-guides/06-sandboxed-agents.md#on-e2b)
says what differs on E2B: where the credentials are kept, what a model key
can be used for there, and how long a sandbox lives.
