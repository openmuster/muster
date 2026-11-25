// The queue's board module: its two watchers, in code. `mu serve --module <this file>` runs them, with
// the card workflow from workflows.json and the board's other work. Importing it opens and starts nothing.
//
// Each watcher runs a script beside this file, as the profile it names, in a clean environment: PATH,
// HOME and the board's own variables, the names in `env`, and a pointer to what happened (MUSTER_EVENT,
// MUSTER_THREAD, ...). Never the card's text: the script reads the board itself.
import { fileURLToPath } from 'node:url'
import { board, command, type Watch } from 'muster'

/** A script in this folder, by its full path, wherever the module is run from. */
const script = (name: string) => fileURLToPath(new URL(name, import.meta.url))

export const watch = {
  // A card labelled for the agent: start.sh marks it `started` and asks for the card workflow, once. The
  // label is its gate, and its write is keyed by MUSTER_EVENT, so a retry of one event gets one answer.
  'card-start': {
    tail: { channel: 'cards', labels: ['tag.agent=agent'], types: ['message.posted', 'labels.changed'] },
    as: 'intake',
    run: command(({ event }) => [script('./start.sh'), String(event.thread)]),
  },
  // A task of a card's run blocked: notify.sh tells you its ID, and nothing it says.
  'needs-me': {
    tail: { channel: 'cards/', types: ['task.blocked'] },
    run: command(({ event }) => [script('./notify.sh'), String(event.thread)], { env: ['NOTIFY_CMD'] }),
  },
} satisfies Record<string, Watch>

export const team = board({ watch })
