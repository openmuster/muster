// The home page's demo, as data: what is typed, what the board answers, and what the board looks like
// at each moment. Everything on screen is a function of the time since the chapter began, so the demo
// can be paused, scrubbed, tested, and shown finished to someone who has asked for less motion.

export type Line = { kind: 'cmd' | 'out'; text: string }
export type Reply = { by: string; text: string }
export type Board = { state: 'ready' | 'claimed' | 'blocked' | 'completed'; note: string; replies: Reply[] }

/**
 * A synced tool's own view of the same work, for the "With …" chapters: where a person put it, what it
 * is filed under, and the comments the board sent back. Only what sync really carries changes here:
 * people move cards and set statuses; the board sends replies.
 */
export type AppComment = { by: string; text: string; agent?: boolean }
export type App = { column: string; tags: string[]; checks?: 'failing' | 'pending' | 'passing'; comments: AppComment[]; note?: string }
export type View = 'linear' | 'github' | 'slack' | 'notion'

type Cue =
  | { at: number; type: string } // a command, typed a character at a time
  | { at: number; out: string } // a line the board prints
  | { at: number; board: Partial<Board> & { reply?: Reply } } // what changes on the board
  | { at: number; app: Partial<Omit<App, 'comments' | 'tags'>> & { comment?: AppComment; tag?: string } } // what changes in the tool

export type Chapter = {
  id: string
  label: string
  file: string
  title: string
  who: string
  cues: Cue[]
  code?: 'sdk'
  /** For a chapter about a synced tool: which one, the item's name there, and the board channel it maps to. */
  view?: View
  ref?: string
  channel?: string
  app?: App
}

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

/**
 * The same work arriving from the tools people already use, run by hand. Each follows its sync page: what
 * comes in becomes a thread with labels, `mu tasks create <id>` makes it a task, and the agent's replies go
 * back as comments (on GitHub, where the repository sets `mirror`). `mu wait` prints what it prints: the
 * event, credited as sync credits it (a Linear or Notion user's ID, a Slack member ID, a GitHub login).
 * The loop template does the waiting, and the In progress and Done moves, by itself.
 */
export const SYNC_CHAPTERS: Chapter[] = [
  {
    id: 'linear',
    label: 'With Linear',
    file: 'terminal',
    title: TASK,
    who: 'ada',
    view: 'linear',
    ref: 'ENG-42',
    channel: 'eng',
    app: { column: 'Backlog', tags: [], comments: [] },
    cues: [
      { at: 300, type: 'mu wait eng --label tag.agent=agent --timeout 1h' },
      { at: 2400, app: { column: 'Todo', tag: 'agent', note: 'maya moved it to Todo and labelled it agent' } },
      { at: 2400, out: '12      labels.changed    #7      5b1e0c3a-9d2f-4a6e-8c71-2f4b9e0d7a13 · 0s' },
      { at: 2400, out: '    state=todo tag.agent=agent' },
      { at: 2400, out: '' },
      { at: 2400, out: 'next: mu wait eng --after 12' },
      { at: 2900, type: 'mu tasks create 7' },
      { at: 3500, out: 'created  #7  ready' },
      { at: 3900, type: 'mu run 7 --agent claude --as worker-1' },
      { at: 5300, app: { column: 'In Progress', note: 'maya moved it to In Progress', comment: { by: 'worker-1', text: 'plan: check the origin before redirecting', agent: true } } },
      { at: 6900, app: { comment: { by: 'worker-1', text: 'fixed in a1b2c3, tests pass', agent: true } } },
      { at: 6900, out: 'completed  #7  claude ok' },
      { at: 8100, app: { column: 'Done', note: 'maya moved it to Done: state=done on the board' } },
    ],
  },
  {
    id: 'github',
    label: 'With GitHub',
    file: 'terminal',
    title: TASK,
    who: 'ada',
    view: 'github',
    ref: 'acme/web#7',
    channel: 'web/prs',
    app: { column: 'open', tags: ['bug'], checks: 'pending', comments: [], note: 'maya pushed 9f8e7d6' },
    cues: [
      { at: 300, type: "mu wait web/prs --label 'ci.ci=failure' --timeout 1h" },
      { at: 1900, app: { checks: 'failing', note: 'ci failed on maya\'s push' } },
      { at: 1900, out: '18      labels.changed    #12     maya · 0s' },
      { at: 1900, out: '    ci.ci=failure' },
      { at: 1900, out: '' },
      { at: 1900, out: 'next: mu wait web/prs --after 18' },
      { at: 2400, type: 'mu tasks create 12' },
      { at: 3000, out: 'created  #12  ready' },
      { at: 3400, type: 'mu run 12 --agent claude --as worker-1' },
      { at: 4800, app: { comment: { by: 'worker-1', text: 'the test expects a relative path; fixing the redirect, not the test', agent: true } } },
      { at: 6000, app: { checks: 'pending', note: 'worker-1 pushed a1b2c3' } },
      { at: 7400, app: { checks: 'passing', note: 'ci.ci=success on the board' } },
      { at: 7400, out: 'completed  #12  claude ok' },
    ],
  },
  {
    id: 'slack',
    label: 'With Slack',
    file: 'terminal',
    title: 'the login redirect loops on Safari again',
    who: 'ada',
    view: 'slack',
    ref: '#support',
    channel: 'support',
    app: { column: '', tags: [], comments: [] },
    cues: [
      { at: 300, type: 'mu wait support --timeout 1h' },
      { at: 1900, app: { comment: { by: 'maya', text: 'the login redirect loops on Safari again' } } },
      { at: 1900, out: '21      message.posted    #21     U07MAYA4K2 · 0s' },
      { at: 1900, out: '    the login redirect loops on Safari again' },
      { at: 1900, out: '' },
      { at: 1900, out: 'next: mu wait support --after 21' },
      { at: 2400, type: 'mu tasks create 21' },
      { at: 3000, out: 'created  #21  ready' },
      { at: 3400, type: 'mu run 21 --agent claude --as worker-1' },
      { at: 4800, app: { comment: { by: 'worker-1', text: 'reproduced: Safari drops the cookie on the 302', agent: true } } },
      { at: 6400, app: { comment: { by: 'worker-1', text: 'fixed in a1b2c3, tests pass', agent: true } } },
      { at: 6400, out: 'completed  #21  claude ok' },
      { at: 7400, app: { comment: { by: 'maya', text: 'confirmed on my phone, thanks' } } },
    ],
  },
  {
    id: 'notion',
    label: 'With Notion',
    file: 'terminal',
    title: 'Write the Q4 launch notes',
    who: 'ada',
    view: 'notion',
    ref: 'Launch notes',
    channel: 'docs',
    app: { column: 'Not started', tags: [], comments: [] },
    cues: [
      { at: 300, type: 'mu wait docs --label state=ready-for-agent --timeout 1h' },
      { at: 2600, app: { column: 'Ready for agent', note: 'maya set its Status' } },
      { at: 2600, out: '33      labels.changed    #30     8c4f2e91-3a6b-4d0e-b7c5-1f9a2d6e3b48 · 0s' },
      { at: 2600, out: '    state=ready-for-agent' },
      { at: 2600, out: '' },
      { at: 2600, out: 'next: mu wait docs --after 33' },
      { at: 3100, type: 'mu tasks create 30' },
      { at: 3700, out: 'created  #30  ready' },
      { at: 4100, type: 'mu run 30 --agent claude --as writer' },
      { at: 5400, app: { column: 'In progress', note: 'maya set its Status', comment: { by: 'writer', text: 'outline: what shipped, what changed, what is next', agent: true } } },
      { at: 6900, app: { comment: { by: 'writer', text: 'draft done: three sections, each linked to its changelog entry', agent: true } } },
      { at: 6900, out: 'completed  #30  claude ok' },
      { at: 8000, app: { column: 'Done', note: 'maya set its Status: state=done on the board' } },
    ],
  },
]

/** Every chapter, in the order the demo plays them. */
export const ALL_CHAPTERS: Chapter[] = [...CHAPTERS, ...SYNC_CHAPTERS]

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

export type Frame = { lines: (Line & { typing: boolean })[]; board: Board | null; app: App | null; done: boolean }

/** What the demo shows `t` milliseconds into a chapter. */
export function frameAt(chapter: Chapter, t: number): Frame {
  const lines: Frame['lines'] = []
  let board: Board | null = null
  let app: App | null = chapter.app ? { ...chapter.app, tags: [...chapter.app.tags], comments: [...chapter.app.comments] } : null
  for (const cue of chapter.cues) {
    if (cue.at > t) continue
    if (typed(cue)) {
      const shown = Math.min(cue.type.length, Math.floor((t - cue.at) / CHAR_MS))
      lines.push({ kind: 'cmd', text: cue.type.slice(0, shown), typing: shown < cue.type.length })
    } else if ('out' in cue) lines.push({ kind: 'out', text: cue.out, typing: false })
    else if ('app' in cue) {
      const { comment, tag, ...rest } = cue.app
      const before: App = app ?? { column: '', tags: [], comments: [] }
      app = { ...before, ...rest, tags: tag ? [...before.tags, tag] : before.tags, comments: comment ? [...before.comments, comment] : before.comments }
    } else {
      const { reply, ...rest } = cue.board
      const before: Board = board ?? { state: 'ready', note: '', replies: [] }
      board = { ...before, ...rest, replies: reply ? [...before.replies, reply] : before.replies }
    }
  }
  return { lines, board, app, done: t >= chapterMs(chapter) - REST_MS }
}
