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

## Docs

`packages/muster/docs` is plain markdown that ships in the package, so an
agent can read it offline. Two tests keep it honest:

- `test/docs.test.ts`: every `mu` command and flag a page shows exists, and
  every link resolves.
- `test/guides.test.ts`: every ```` ```bash steps ```` block in a guide is run
  as written, in order, on a new board. Put what a reader types in such a
  block when it is deterministic (no agent, nothing that waits), and keep IDs
  to what a new board really gives: tasks are 1, 3, 5.

`apps/docs` is the site at openmuster.ai (Next.js and Fumadocs). It renders
the same markdown, read from `packages/muster/docs`; nothing is copied.
`apps/docs/lib/markdown.ts` bridges the docs' conventions to the site, and its
test checks every relative link in the real docs lands on a page. Keep docs
prose plain markdown with no JSX. The site is dark only, on the inspector's
colours, in Geist Sans; Geist Mono is for code, terminal output and
technical values only, never to make something stand out. The home page's demo is data
(`apps/docs/components/story/cues.ts`): what it shows is a function of time, so
it is tested, pauses, and shows each scene finished to anyone who asked for
less motion. Its commands print what the CLI really prints, and its code is
run against the library before it is changed. `.github/workflows/deploy-docs.yml` deploys it to Cloudflare Workers
through OpenNext once the repository has the Cloudflare variable and secret.

A guide says who it is for, what it needs, the steps, what you see, when not
to do it, and what goes wrong. Diagrams are Mermaid, in the markdown.

## Releases

A release is `@openmuster/muster` on npm, and the same tarball attached to a
GitHub Release, which npm also installs from its URL (`src/version.ts` builds
that URL; the cloud runners install from it). Code imports it as
`@openmuster/muster`; a board module that still says `'muster'` is answered
too (`src/cli/module.ts`).

1. Set the version in `packages/muster/package.json`. The CLI reads it from
   there; nothing else holds a version number.
2. Merge that to `main`, then push the tag `v<version>`.
3. `.github/workflows/release.yml` checks that the tag matches the version,
   runs `pnpm check`, packs the package, installs the tarball and runs it,
   and attaches it as `muster-<version>.tgz` and as `muster.tgz`, with a
   `SHA256SUMS` file. Its `npm` job then publishes that tarball to npm, with
   no token: npm trusts this workflow (trusted publishing), once an owner of
   the npm org has added it as a trusted publisher on the package's page
   (repository `openmuster/muster`, workflow `release.yml`). npm drops a
   trusted publisher that hasn't published within 48 hours, so one added
   and never used has to be added again just before a release. If the job
   fails after the GitHub release was made, publish that release's tarball
   by hand, checked against its `SHA256SUMS`, and don't re-run the job.
   The release's notes are that version's section of
   `CHANGELOG.md`, so write it before tagging: for people who use muster,
   and for a security fix, which versions it affects.

Versions: there is one line, `main`, and each release from it is the one the
install line gives. Only the latest release gets fixes: a security fix is a
new release, never a patch to an old one. muster is still alpha, so releases
are patch-level alphas and betas (`0.3.1-alpha.1`, then `0.3.1-alpha.2`, then
a beta), never a jump of the minor version, and each one is "latest".

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
- The pages have their own suite, `pnpm test:browser`: it drives the built
  inspector and both templates under `next dev` in Chromium, through
  Playwright. It is not part of `pnpm check`, because it needs a browser:
  `pnpm --filter @openmuster/muster exec playwright install chromium` once. CI runs it on
  every pull request. Change a page, and run it.

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
| No commands in the database | What runs is code the operator wrote: watchers, sync and outgoing webhooks are declared in a board module, a file outside any board, with secrets named by `env()`. A row says what happened, never what to run or where to send it |
| Deadlines are stored, not timed | Nothing depends on a timer having gone off |
| Leave judgment to the model | No keyword or emoji triggers, no automatic decoration, no rules that guess what a message means. Pass on what was written and give agents tools |
| No favourite agent | The core reads no agent-specific environment variables and assumes no particular terminal or vendor |
| Erasable TypeScript | No enums, namespaces or parameter properties, so tests can run the CLI from source |
| The CLI is a product | Plain text in columns, a line per fact, errors as data, exit codes 0, 1, 2, 130 and 143. `--json` prints exactly one document |

## Credit

The board model follows `@vercel/board` (Apache-2.0). The daemon borrows ideas
from Hermes and OpenClaw. Any code taken from one of them keeps its licence
notice.
