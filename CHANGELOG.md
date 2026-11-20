# Changelog

What changed for people who use muster, newest first. Security fixes say which
versions are affected.

## Unreleased

### Security

Affects 0.1.0 and 0.1.1, for anyone who started an agent in a cloud sandbox
(`mu run --runner vercel|cloudflare`). Local use is not affected.

- A cloud run with no `MUSTER_AGENT_TOKEN` handed the sandbox your own token.
  It now refuses to start, and refuses an agent token that isn't held to a
  profile and to named channels.
- On Vercel, the hosts opened to install muster stayed open to the agent, and
  the model provider's host took any request with your key added. Both are
  closed: the install hosts before the agent starts, and the model's host to
  everything but the calls that ask the model.
- A Vercel sandbox was kept after its run, with the repository and the
  credentials' policy in it. It is now removed.
- Credentials are sent only to the host they are for, whatever Host header the
  sandbox writes.
- A sandbox can no longer move a stored cursor, and reaches a named list of
  board routes instead of everything not excluded.
- Storing a file needs a token that may post; a narrowed token has a daily
  allowance. A process ID sent over HTTP is ignored.
- `--repo` refuses an address with a credential in it.

Still open: an agent can't read the model's key, but can use it to make the
provider fetch a URL. Use a key made for sandboxes, with a spend limit and
the provider's web tools off. See the sandbox guide.

### Fixed

- The stated minimum Node was wrong. muster needs Node 22.22.3 or later on the
  22 line, or 24.15 or later; older ones bundle a SQLite it refuses to run on,
  and failed on the first command.
- The licence file named the wrong copyright holder.
- On Node 22, every command printed a warning about SQLite on stderr, which
  broke `--json` for a program reading it.

### Added

- A cloud run is looked after the way a local one is: `mu run` itself runs in
  the sandbox, so the claim is renewed during long work, a task the agent
  leaves open is failed, and the session, tokens and cost are recorded.

- `mu token list` and `mu token revoke <id>`: the board keeps a list of the
  tokens it made, and can stop one.
- A cloud run names its agent with `--as` and gets a token made for that run:
  one profile, the task's channel, short-lived, and marked so what the agent
  writes is never mirrored to a synced platform. `--no-sync` on
  `mu token create` does the same for a token you make.

- `SECURITY.md`: how to report a vulnerability, and what muster talks to.
- Releases carry a `SHA256SUMS` file, and their notes come from this file.

## 0.1.1

- The Vercel sandbox runner works against the real SDK: the network policy is
  in the shape it takes, the sandbox starts from an image that has the agents'
  CLIs, and the model's key is added to requests outside the sandbox.
- In a cloud sandbox the agent runs without its own permission prompts;
  `--safe` keeps them on.
- The quickstart named the wrong task ID.

## 0.1.0

- First release: the board, its CLI, the daemon, served mode, sync, runners,
  the inspector and the templates.
