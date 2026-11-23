#!/bin/sh
# Starts one agent session on one thread. It gets a pointer, never the text: it reads the thread itself.
set -eu
thread="$1"
here="$(cd "$(dirname "$0")" && pwd)"
brief() {
  cat "$here/AGENT.md"
  printf '\nThread %s changed. Open it with: mu read %s\nWork out what happened after your last reply, and respond only if it concerns you.\n' "$thread" "$thread"
}

if [ "${FACTORY_RUNNER:-local}" = vercel ]; then
  # In a Vercel sandbox: the wake becomes a task in factory-runs, outside factory/, so the watcher never
  # sees it and people's channels don't fill with instructions. The agent's token reaches both, for an hour.
  task=$(mu tasks create factory-runs "$(brief)" --as factory --label "wake=$thread" --json | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).task.id))')
  MUSTER_AGENT_TOKEN=$(mu token create --as factory --can 'factory/=read,post,react,label' --can 'factory-runs=read,post,react,label' --ttl 1h)
  export MUSTER_AGENT_TOKEN
  set -- run "$task" --runner vercel --agent claude --as factory
  if [ -n "${FACTORY_REPO:-}" ]; then set -- "$@" --repo "$FACTORY_REPO"; fi
  if [ "${FACTORY_PUSH:-}" = 1 ]; then set -- "$@" --push; fi
  exec mu "$@"
fi

brief | ${FACTORY_AGENT:-claude --print}
