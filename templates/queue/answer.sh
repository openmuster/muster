#!/bin/sh
# Answers a blocked card task: your answer as a reply on it, the task unblocked, and a worker started on
# it in a Vercel sandbox, as the card workflow's own are. The run's workers stop after ten idle minutes,
# so an unblocked task may have nobody left to take it; if one still is and takes it first, that's fine.
#
# Run it as yourself, with no --as and no MUSTER_PROFILE: the run's tasks belong to the daemon, and only
# the board's owner, with no profile, may unblock them. It stays until the sandbox's run ends, as
# `mu run --push` does, since the change is pushed from here.
set -eu
if [ $# -ne 2 ]; then
  echo 'usage: answer.sh <task> "<your answer>"' >&2
  exit 2
fi
task="$1"
answer="$2"

state=$(mu read "$task" --json | node -e 'const t = JSON.parse(require("fs").readFileSync(0, "utf8")).task; process.stdout.write(t ? t.state : "not a task")')
if [ "$state" != blocked ]; then
  echo "task $task is $state, not blocked: nothing done" >&2
  exit 1
fi

# The workers' settings, from the card workflow in this machine's workflows.json.
settings=$(mu workflow list --json | node -e '
const w = JSON.parse(require("fs").readFileSync(0, "utf8")).workflows.find((each) => each.name === "card")
if (!w) { console.error("answer.sh: no card workflow in workflows.json"); process.exit(1) }
const k = w.workers
const out = ["--agent", k.agent, "--as", `${k.as}-answer`]
if (k.repo) out.push("--repo", k.repo)
if (k.push) out.push("--push")
if (k.timeout) out.push("--timeout", k.timeout)
process.stdout.write(out.join(" "))')

mu reply "$task" "$answer" >/dev/null
mu tasks unblock "$task" >/dev/null

# Split on spaces on purpose: each is a flag, or a value with no space in it.
set -- $settings
if ! said=$(mu run "$task" --runner vercel "$@" --json 2>&1); then
  case "$said" in
    *'"task_claimed"'*)
      echo "answered #$task; a worker of its run took it first"
      exit 0
      ;;
  esac
  printf '%s\n' "$said" >&2
  exit 1
fi
echo "answered #$task, and ran it"
