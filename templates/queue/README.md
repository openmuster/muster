# queue

A card queue: label a Linear issue `agent`, or post a card yourself, and an
agent writes a spec, makes the change as a pull request, and reviews it, each
step in a Vercel sandbox. The card gets a reply when the run starts and a
summary when it ends. You hear about a card only when a task blocks on a
decision of yours.

It is configuration for muster's own daemon, and three small scripts. The
guide is [A card queue](../../packages/muster/docs/03-guides/19-a-card-queue.md).

| File | What it is |
| --- | --- |
| `sync.json` | Linear team `ENG` to the channel `cards`, both ways |
| `watchers.json` | `card-start` for a card labelled `tag.agent=agent`; `needs-me` for a blocked task under `cards/` |
| `workflows.json` | The `card` workflow: spec, work and review, one Vercel worker, `--push` |
| `start.sh` | Marks the card `started` and asks for the `card` workflow, once |
| `notify.sh` | Tells you a task is blocked: `NOTIFY_CMD`, or a macOS notification |
| `answer.sh` | Replies to a blocked task, unblocks it, and starts a worker on it |

```bash
cp sync.json watchers.json workflows.json ~/.config/muster/
# then edit them: the scripts' full paths in watchers.json, your repository
# in workflows.json, your Linear team's key in sync.json
mu serve --allow-host <your host>   # with MUSTER_SANDBOX_URL, not MUSTER_URL
```

A card posted by hand needs `--no-sync`, or it opens a Linear issue without
the label, whose next update takes the label off the card:

```bash
mu post cards "Make the footer show the current year" --label tag.agent=agent --no-sync
```

Answer a blocked task as yourself, with no `--as` and no `MUSTER_PROFILE`:

```bash
./answer.sh 14 "SSO first."
```

Covered by tests, with Linear's API and the sandboxes as stand-ins. It has
not been run live.
