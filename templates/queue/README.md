# queue

A card queue: label a Linear issue `agent`, or post a card yourself, and an
agent writes a spec, makes the change as a pull request, and reviews it, each
step in a Vercel sandbox. The card gets a reply when the run starts and a
summary when it ends. You hear about a card only when a task blocks on a
decision of yours.

It is a board module for muster's own daemon, a workflow file, and three
small scripts. The guide is
[A card queue](../../packages/muster/docs/03-guides/19-a-card-queue.md).

| File | What it is |
| --- | --- |
| `board.ts` | The board module: Linear team `ENG` to the channel `cards`, both ways; `card-start` for a card labelled `tag.agent=agent`; `needs-me` for a blocked task under `cards/` |
| `workflows.json` | The `card` workflow: spec, work and review, one Vercel worker, `--push` for the work step only |
| `start.sh` | Marks the card `started` and asks for the `card` workflow, once |
| `notify.sh` | Tells you a task is blocked: `NOTIFY_CMD`, or a macOS notification |
| `answer.sh` | Unblocks a blocked task, posts your answer, and starts a worker on the rest of its run |

```bash
cp workflows.json ~/.config/muster/
# then edit: your repository in workflows.json, your Linear team's key in board.ts
export LINEAR_WEBHOOK_SECRET=... LINEAR_API_KEY=lin_api_...   # named in board.ts with env(), never written there
mu serve --module "$PWD/board.ts" --allow-host <your host>   # with MUSTER_SANDBOX_URL, not MUSTER_URL
```

Point Linear's webhook at `https://<your host>/api/board/webhooks/lin`.
`board.ts` names the scripts beside it by their full paths, wherever it is
run from. If `~/.config/muster/` has a `watchers.json`, `sync.json` or
`hooks.json` from an earlier copy of this template, move anything else in
them into a board module and delete them: those files are no longer read,
and `mu serve` refuses to start while one is there.

A card posted by hand needs `--no-sync`, or it opens a Linear issue without
the label, whose next update takes the label off the card:

```bash
mu post cards "Make the footer show the current year" --label tag.agent=agent --no-sync
```

Answer a blocked task as yourself, with no `--as` and no `MUSTER_PROFILE`:

```bash
./answer.sh 14 "SSO first."
```

What a card can reach: anyone who can label an issue in the team, or post in
`cards`, starts a run, as `intake`, whatever `who` says. The worker reads
the work step's change out of its sandbox, then pushes a branch and opens a
pull request in the repository from its own machine (spec and review set
`push: false`; the sandbox never holds the GitHub token). That pull request runs your CI on the agent's code,
and task results go back to the issue as a comment. The spec's result reaches
the later steps quoted and fenced, as the card does. The guide has the rest.

Covered by tests, `mu serve --module` with Linear's webhook among them, with
Linear's API and the sandboxes as stand-ins. It has
not been run live.
