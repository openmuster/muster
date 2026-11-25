#!/bin/sh
# Answers a blocked task of a card's run: the task unblocked, your answer as a reply on it, and, unless one
# is still going, a worker that takes the run's ready tasks one after another until none is left, as the
# card workflow's own workers do. Those stop after ten idle minutes, so a run blocked longer has none.
#
# Run it as yourself, where `mu serve` runs and with its settings, and with no --as and no MUSTER_PROFILE:
# the run's tasks belong to the daemon, and only the board's owner, with no profile, may unblock them.
# It stays until the worker ends, since a --push run's change is pushed from here.
set -euf
if [ $# -ne 2 ]; then
  echo 'usage: answer.sh <task> "<your answer>"' >&2
  exit 2
fi
task="$1"
answer="$2"
case "$task" in '' | *[!0-9]*) echo "answer.sh: not a task ID: $task" >&2; exit 2 ;; esac

# Read before anything is written: the task's run, and the card workflow's workers from this machine's
# workflows.json. Each value is one word: a flag, a channel, a name, an address.
run=$(mu read "$task" --json | node -e '
const t = JSON.parse(require("fs").readFileSync(0, "utf8"))
const l = t.message.labels
if (!t.task || l.workflow !== "card" || !l.request) { console.error("answer.sh: #" + t.message.id + " is not a task of a card run"); process.exit(1) }
const by = t.message.by
process.stdout.write([t.message.channel, by.principal + "+" + by.profile, l.request].join(" "))')
worker=$(mu workflow list --json | node -e '
const w = JSON.parse(require("fs").readFileSync(0, "utf8")).workflows.find((each) => each.name === "card")
if (!w) { console.error("answer.sh: no card workflow in workflows.json"); process.exit(1) }
const k = w.workers
const cloud = k.runner === "vercel" || k.runner === "cloudflare"
const out = [...(cloud ? ["--runner", k.runner] : ["--cwd", k.cwd]), "--agent", k.agent, "--as", k.as + "-answer"]
if (k.repo) out.push("--repo", k.repo)
if (k.push) out.push("--push")
if (k.timeout) out.push("--timeout", k.timeout)
if (out.some((each) => /\s/.test(each))) { console.error("answer.sh: a worker setting in workflows.json has a space in it"); process.exit(1) }
process.stdout.write(out.join(" "))')
set -- $run
channel="$1"
owner="$2"
request="$3"

# The gate: of any number of answers to one task, only the one whose unblock changed it goes on.
unblocked=$(mu tasks unblock "$task" --json | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"))
process.stdout.write(d.outcome === "unblocked" ? "yes" : d.task.state)')
if [ "$unblocked" != yes ]; then
  echo "task $task is $unblocked, not blocked: nothing done" >&2
  exit 1
fi

# The answer, read from stdin so nothing in it is taken for a flag. A worker starts a task in a sandbox
# that takes far longer to come up than this reply takes to land, and reads the thread there.
if ! printf '%s' "$answer" | mu reply "$task" --file - >/dev/null; then
  mu tasks block "$task" "answer.sh couldn't post the answer: run it again" --kind needs_input >/dev/null || true
  echo "answer.sh: your answer wasn't posted, so #$task is blocked again" >&2
  exit 1
fi

# One worker per run: none while a worker of the run is still going, the daemon's or another answer's.
lock="${TMPDIR:-/tmp}/muster-queue-$(printf '%s' "$channel" | tr '/' '-').lock"
if pgrep -f "run --ready $channel --loop" >/dev/null 2>&1 || ! mkdir "$lock" 2>/dev/null; then
  echo "answered #$task; a worker of $channel is still going and takes it (if none is, remove $lock)"
  exit 0
fi
trap 'rmdir "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set -- $worker
set -- run --ready "$channel" --loop --wait 2m "$@" --by "$owner" --label workflow=card --label "request=$request"
echo "answered #$task; starting a worker on $channel"
if ! mu "$@"; then
  echo "answer.sh: #$task is answered, but the worker didn't finish cleanly. To run what is left of $channel: mu $*" >&2
  exit 1
fi
