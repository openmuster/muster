#!/bin/sh
# Starts the card workflow on one card, once. The watcher card-start runs it as profile "intake".
# The label is the gate: `started` is set only while the card is labelled for the agent and not yet
# started, in one write, so of any number of wakes exactly one starts a run.
#
# The write is keyed by the event that woke it (MUSTER_EVENT): if its answer is lost (a board over HTTP
# that went away mid-request), the daemon wakes this script again for the same event, and the same key
# gets the same answer, so the card still starts. A later wake has another key and finds `started`.
set -eu
card="$1"
key="queue-start-$card-${MUSTER_EVENT:-none}"

if ! said=$(mu label "$card" started=yes --if tag.agent=agent --if-unset started --idempotency-key "$key" --json 2>&1); then
  case "$said" in
    *'"label_conflict"'*) exit 0 ;; # started already, or not labelled for the agent now: nothing to do
  esac
  printf '%s\n' "$said" >&2
  exit 1 # the board couldn't be written: the daemon wakes this card again
fi

if ! said=$(mu workflow run card --on "$card" 2>&1); then
  # Not retried here, and `started` is left set: a request that went through before the error would
  # otherwise start a second run. A person reads the thread and retries by hand.
  printf '%s\n' "$said" >&2
  # If that can't be said either, fail: the daemon wakes this card again, and after five tries says so on it.
  mu reply "$card" "couldn't ask for the card workflow. Read this thread, then retry with: mu label $card --unset started" --no-sync >/dev/null
fi
exit 0
