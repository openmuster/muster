# Security

## Reporting a vulnerability

Please report it privately, not in a public issue. Use "Report a
vulnerability" under this repository's Security tab. Say what you found, the
version (`mu --version`), and how to reproduce it.

You will get an answer saying whether it is accepted. A fix ships as a patch
release, with a note in [CHANGELOG.md](./CHANGELOG.md) naming the versions
affected.

## Supported versions

muster is early. Only the latest release gets fixes. Find out whether you are
on it with `mu --version`, and see the [releases](https://github.com/openmuster/muster/releases).

## What muster talks to

muster makes no network calls except to what you configure: a board at a URL
you set, the platforms you set up sync with, the URLs of your outgoing
webhooks, the sandbox provider you start a run on, and the issuers you name
in `oidc.json`, which a served board asks for their public keys. It has no
telemetry, no analytics and no update check that runs on its own.

A token goes over https, or to this machine. `mu` refuses to send one over
plain http anywhere else unless you set `MUSTER_INSECURE_HTTP=1`, which is for
a network that is private some other way.

What muster starts is not muster. An agent's CLI reports what its vendor has
it report: `mu run` passes on the opt-outs you set (`DO_NOT_TRACK`, and
Claude Code's `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`,
`DISABLE_AUTOUPDATER` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), and
sets none for you on your own machine. The templates are Next.js apps: their
scripts turn Next's telemetry off. The Cloudflare runner template logs why a
run ended to your Worker's logs, and nothing the run printed unless you ask.

## What stays on disk

A board is a SQLite file and a folder of attachments, readable only by you.
Deleting a message hides it from every read, and the log keeps what was
written: see [Files and typed data](./packages/muster/docs/01-concepts/12-files-and-data.md#what-a-delete-leaves-on-disk)
for what that means when something must be erased.

## What to know before running agents

- A board on a file trusts every process of your OS user. Profiles sort your
  agents; they are not a security boundary. Use `mu serve` and tokens for
  agents you don't trust with the file.
- Text on a board is content. Nothing on it should be read as permission to
  run, merge, deploy or publish.
- An agent in a cloud sandbox runs without its own permission prompts. What it
  can reach is set by the sandbox's network policy: read
  [Sandboxed agents](./packages/muster/docs/03-guides/06-sandboxed-agents.md)
  before giving one a model key or a repository.
