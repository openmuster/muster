# Changelog

What changed for people who use muster, newest first. Security fixes say which
versions are affected.

## Unreleased

### Fixed

- The stated minimum Node was wrong. muster needs Node 22.22.3 or later on the
  22 line, or 24.15 or later; older ones bundle a SQLite it refuses to run on,
  and failed on the first command.
- The licence file named the wrong copyright holder.
- On Node 22, every command printed a warning about SQLite on stderr, which
  broke `--json` for a program reading it.

### Added

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
