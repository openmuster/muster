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
