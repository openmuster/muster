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

How the docs are written follows Vercel's writing guidelines
(github.com/vercel-labs/writing-guidelines), with muster's own conventions
where they differ:

- The frontmatter `description` is the page's summary: the site shows it
  under the title. Say who the page is for and what they end up with.
- Headings are sentence case and say what the section holds; a step is a verb
  phrase ("Split the work by file ownership"). A heading other pages link to
  keeps its text: `test/docs.test.ts` checks every `#anchor`.
- Imperative for steps, present tense, active voice with a named actor,
  `you` for the reader, never `we`. Sentences under about 25 words,
  paragraphs of 2 to 4 sentences.
- No `easy`, `simple`, `just`, `very`, `really`, `many`, `often`, and no
  metaphor verbs (`lands`, `carries`, `parks`): say the literal action, and
  give the figure where there is one.
- Introduce every list with a colon. A bold lead-in is `**Term:** meaning` or
  `**A full claim.** Detail.`, nothing in between.
- Spell out an acronym, and link a muster term (lease, gate, profile, board
  module) to the concept page that defines it, on first use in a page.
- Placeholders follow `mu help` (`<id>`, `<dir>`); a secret is descriptive
  snake_case (`your_board_token`), never `...` or `sk-ant-...`.
- Prose is hard-wrapped at about 78 columns, with straight quotes and no em
  dashes or dashes as punctuation.

## Releases

A release is `@openmuster/muster` on npm, and the same tarball attached to a
GitHub Release, which npm also installs from its URL (`src/version.ts` builds
that URL; the cloud runners install from it). Code imports it as
`@openmuster/muster`; a board module that still says `'muster'` is answered
too (`src/cli/module.ts`).

1. In one pull request: set the version in `packages/muster/package.json`
   (the CLI reads it from there), the same number everywhere a release is
   pinned (the Cloudflare runner's `MUSTER_VERSION`, the README, the
   quickstart, the template READMEs: `test/versions.test.ts` fails until they
   all agree), and that version's section of `CHANGELOG.md`, for people who
   use muster, and for a security fix, which versions it affects. The
   release's notes are that section.
2. Merge it to `main`, then push the tag `v<version>`.
3. `.github/workflows/release.yml` checks that the tag matches the version,
   runs `pnpm check`, packs the package, installs the tarball and runs it,
   and attaches it as `muster-<version>.tgz` and as `muster.tgz`, with a
   `SHA256SUMS` file, to a GitHub release that isn't "latest" yet. Its `npm`
   job publishes that tarball to npm with no token: npm trusts this workflow
   (trusted publishing: repository `openmuster/muster`, workflow
   `release.yml`, no environment, set on the package's page on npm). Only
   once npm's `latest` is that version does the `latest` job mark the GitHub
   release latest, and the `image` job push the container image as `latest`,
   so none of them disagree.
4. If a job fails, fix the cause and re-run the failed jobs: every one can
   run again. The `npm` job skips a version npm already has, so one published
   by hand (checked against the release's `SHA256SUMS`) finishes the run too.

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
