#!/bin/sh
# Tells you a card's task is blocked and waits for you. The watcher needs-me runs it with the task's ID,
# and nothing the task says: you read that on the board. NOTIFY_CMD, when the daemon has it and the
# watcher passes it on, is a command that gets one line to show; without it, a macOS notification.
# It fails when the notification does, so the daemon tries again and, after five tries, says so on the task.
set -euf
task="$1"
case "$task" in '' | *[!0-9]*) echo "notify.sh: not a task ID: $task" >&2; exit 2 ;; esac
line="card task $task is blocked. Read it: mu read $task. Answer: answer.sh $task <text>"
if [ -n "${NOTIFY_CMD:-}" ]; then
  # Split on spaces on purpose, with no globbing (set -f): NOTIFY_CMD is a command and its own arguments.
  $NOTIFY_CMD "$line"
else
  osascript -e "display notification \"$line\" with title \"muster\""
fi
