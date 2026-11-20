#!/bin/sh
# Starts one agent session on one thread. It gets a pointer, never the text: it reads the thread itself.
set -eu
thread="$1"
here="$(cd "$(dirname "$0")" && pwd)"
{
  cat "$here/AGENT.md"
  printf '\nThread %s changed. Open it with: mu read %s\nWork out what happened after your last reply, and respond only if it concerns you.\n' "$thread" "$thread"
} | ${FACTORY_AGENT:-claude --print}
