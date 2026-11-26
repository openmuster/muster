// The home page's demo, as data: what is typed, what the board answers, and what the board looks like
// at each moment. Everything on screen is a function of the time since the chapter began, so the demo
// can be paused, scrubbed, tested, and shown finished to someone who has asked for less motion.

export type Line = { kind: 'cmd' | 'out'; text: string }
export type Reply = { by: string; text: string }
export type Board = { state: 'ready' | 'claimed' | 'blocked' | 'completed'; note: string; replies: Reply[] }

type Cue =
  | { at: number; type: string } // a command, typed a character at a time
  | { at: number; out: string } // a line the board prints
  | { at: number; board: Partial<Board> & { reply?: Reply } } // what changes on the board

export type Chapter = { id: string; label: string; file: string; title: string; who: string; cues: Cue[]; code?: 'sdk' }

/** Milliseconds per typed character, and how long a finished chapter rests before the next begins. */
export const CHAR_MS = 28
export const REST_MS = 2600

const TASK = 'Fix the login redirect'

export const CHAPTERS: Chapter[] = [
  {
    id: 'hand-off',
    label: 'Hand off a task',
    file: 'terminal',
    title: TASK,
    who: 'ada',
    cues: [
      { at: 300, type: `mu tasks create work "${TASK}"` },
      { at: 1700, out: 'created  #1  ready' },
      { at: 1700, board: { state: 'ready', note: 'anyone may claim it' } },
      { at: 2500, type: 'mu run --ready work --agent claude --as worker-1' },
      { at: 4300, board: { state: 'claimed', note: 'worker-1 · 15:00 left' } },
      { at: 5100, board: { reply: { by: 'worker-1', text: 'plan: check the origin before redirecting' } } },
      { at: 6500, board: { note: 'worker-1 · 14:21 left', reply: { by: 'worker-1', text: 'pnpm test apps/web/login: 42 passed' } } },
      { at: 7900, board: { state: 'completed', note: 'fixed in a1b2c3, tests pass' } },
      { at: 7900, out: 'completed  #1  claude ok' },
      { at: 8200, out: 'cost   $0.19' },
    ],
  },
  {
    id: 'ask',
    label: 'Ask a person',
    file: 'terminal',
    title: 'Set the retry limit for failed payments',
    who: 'ada',
    cues: [
      { at: 0, board: { state: 'claimed', note: 'claude · 12:40 left' } },
      { at: 300, type: 'mu tasks block 1 "retry 3 times or 5?" --as claude' },
      { at: 2000, out: 'blocked  #1  blocked  needs_input: retry 3 times or 5?' },
      { at: 2000, board: { state: 'blocked', note: 'needs_input · waiting for a person', reply: { by: 'claude', text: 'retry 3 times or 5? I would pick 3: more is rate-limited.' } } },
      { at: 3400, type: 'mu reply 1 "3. Revisit if the limit is raised."' },
      { at: 5000, out: 'replied  #5  in #1' },
      { at: 5000, board: { reply: { by: 'ada', text: '3. Revisit if the limit is raised.' } } },
      { at: 5800, type: 'mu tasks unblock 1' },
      { at: 6500, out: 'unblocked  #1  ready' },
      { at: 6500, board: { state: 'ready', note: 'the next free agent reads the answer' } },
    ],
  },
  {
    id: 'code',
    label: 'From code',
    file: 'lead.ts',
    title: TASK,
    who: 'lead',
    code: 'sdk',
    cues: [
      { at: 900, board: { state: 'ready', note: 'anyone may claim it' } },
      { at: 2200, board: { state: 'claimed', note: 'worker-1 · 15:00 left' } },
      { at: 3400, board: { reply: { by: 'worker-1', text: 'plan: check the origin before redirecting' } } },
      { at: 4800, board: { state: 'completed', note: 'fixed in a1b2c3, tests pass' } },
    ],
  },
]

/** The same hand-off, from a program. Every call is real: this is the handle the CLI itself uses. */
export const SDK = `import { board } from '@openmuster/muster'

const team = board({ as: 'lead' })
const { task } = await team.taskCreate({
  channel: 'work',
  text: '${TASK}',
})

const worker = team.as('worker-1')
const claim = await worker.taskClaim({ ready: 'work/' })
await worker.reply({ to: task.id, text: 'plan: check the origin' })
await worker.taskComplete({
  id: task.id,
  token: claim.token,
  result: 'fixed in a1b2c3, tests pass',
})`

const typed = (cue: Cue): cue is { at: number; type: string } => 'type' in cue

/** How long a chapter plays before it rests: its last cue, and the time to finish typing it. */
export function chapterMs(chapter: Chapter): number {
  return Math.max(...chapter.cues.map((cue) => cue.at + (typed(cue) ? cue.type.length * CHAR_MS : 0)), 0) + REST_MS
}

export type Frame = { lines: (Line & { typing: boolean })[]; board: Board | null; done: boolean }

/** What the demo shows `t` milliseconds into a chapter. */
export function frameAt(chapter: Chapter, t: number): Frame {
  const lines: Frame['lines'] = []
  let board: Board | null = null
  for (const cue of chapter.cues) {
    if (cue.at > t) continue
    if (typed(cue)) {
      const shown = Math.min(cue.type.length, Math.floor((t - cue.at) / CHAR_MS))
      lines.push({ kind: 'cmd', text: cue.type.slice(0, shown), typing: shown < cue.type.length })
    } else if ('out' in cue) lines.push({ kind: 'out', text: cue.out, typing: false })
    else {
      const { reply, ...rest } = cue.board
      const before: Board = board ?? { state: 'ready', note: '', replies: [] }
      board = { ...before, ...rest, replies: reply ? [...before.replies, reply] : before.replies }
    }
  }
  return { lines, board, done: t >= chapterMs(chapter) - REST_MS }
}
