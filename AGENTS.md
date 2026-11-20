# Working in this repository

muster ships as a single npm package, `packages/muster`. It contains the
store, the policy layer, the `board()` handle, and the `muster` CLI (short
name `mu`). The design is written down in [SPEC.md](./SPEC.md). Read that
before you change how anything behaves.

## Commands

```bash
pnpm install
pnpm check          # build, typecheck and test, in that order
pnpm test           # tests only
```

## Releases

muster is not on npm. A release is a tarball attached to a GitHub Release,
which npm installs from its URL (`src/version.ts` builds that URL).

1. Set the version in `packages/muster/package.json`. The CLI reads it from
   there; nothing else holds a version number.
2. Merge that to `main`, then push the tag `v<version>`.
3. `.github/workflows/release.yml` checks that the tag matches the version,
   runs `pnpm check`, packs the package, installs the tarball and runs it,
   and attaches it as `muster-<version>.tgz` and as `muster.tgz`, with a
   `SHA256SUMS` file. The release's notes are that version's section of
   `CHANGELOG.md`, so write it before tagging: for people who use muster,
   and for a security fix, which versions it affects.

Versions: `0.1.x` is for security fixes and for fixing claims that were
wrong. Everything else goes out as a pre-release, `0.2.0-alpha.N`; a version
with a `-` in it is marked as one and never becomes "latest".

`.github/workflows/check.yml` runs `pnpm check` on every pull request and on
`main`, on the oldest Node muster supports, on the current one, and on macOS.
Its `pack` job does what a release does without publishing (`scripts/release.mjs`),
so a broken release step fails on the pull request, not on the tag.

## How tests are written here

- Real SQLite in a temporary folder, with the clock injected.
- Nothing of muster's own is mocked. Only things outside it are faked:
  platform payloads, `launchctl`, cloud sandboxes, agent CLIs.
- After writing a test, break the behaviour it covers and confirm the test
  fails. A test that cannot fail is not checking anything.
- Assert on what a user can observe, not on internals.

## Structure

```text
store  <-  policy  <-  backend (file, http)  <-  board() handle  <-  CLI and UIs
```

- All rules sit in the policy layer, once, and apply to every backend.
- The CLI never touches the store or the network directly. It calls the
  handle.
- Request shapes are shared between the server and the handle.

## Rules the code keeps

| Rule | Meaning |
| --- | --- |
| A single log | Each fact on a board is one event. Tables are updated in the same transaction and can be rebuilt from the log alone |
| The board says who wrote it | Authorship, mentions and `board.*` labels come from the verified caller, never from a request body |
| No commands in the database | Watcher commands, sync mappings and secret names are operator configuration, outside any board |
| Deadlines are stored, not timed | Nothing depends on a timer having gone off |
| Leave judgment to the model | No keyword or emoji triggers, no automatic decoration, no rules that guess what a message means. Pass on what was written and give agents tools |
| No favourite agent | The core reads no agent-specific environment variables and assumes no particular terminal or vendor |
| Erasable TypeScript | No enums, namespaces or parameter properties, so tests can run the CLI from source |
| The CLI is a product | Plain text in columns, a line per fact, errors as data, exit codes 0, 1, 2, 130 and 143. `--json` prints exactly one document |

## Credit

The board model follows `@vercel/board` (Apache-2.0). The daemon borrows ideas
from Hermes and OpenClaw. Any code taken from one of them keeps its licence
notice.
