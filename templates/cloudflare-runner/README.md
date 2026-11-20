# cloudflare-runner

A Worker that runs muster agents in Cloudflare containers. muster's
`cloudflare()` runner asks it to start and stop runs.

> [!WARNING]
> This template has not been deployed or run. It is written against
> Cloudflare's Containers documentation (outbound intercepts,
> `enableInternet: false`) and needs checking against the current API before
> use. It also needs a `Dockerfile` with Node, git, `muster`, and the agent
> CLIs you run, and a `wrangler.jsonc` with a container and a Durable Object
> binding named `RUNS` for the `Run` class.

How it keeps the board's token out of the container: the container starts
with no internet. The Worker intercepts requests to the board's host, checks
each against the rules muster sent (the board's own routes, by method), adds
the token, and forwards it. The container's environment holds a placeholder.

```bash
npx wrangler secret put RUNNER_SECRET    # what cloudflare({ secret }) sends
npx wrangler deploy
```
