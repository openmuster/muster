// The loop's board module: feedback from anywhere becomes a card, an agent works it as a pull request, and
// a trusted reply on the card starts another round on the same pull request. `mu serve --module <this file>`
// runs it, with the `triage` and `card` workflows from workflows.json. Importing it opens, reads and starts
// nothing: who is trusted, and the secrets, are read when a watcher runs or the board starts.
//
// A card is a thread in a source's channel under `cards/` (`cards/slack`, `cards/linear`, `cards/github`,
// `cards/notion`, `cards/app`), and a task. A card's runs are in channels under its own (`cards/slack/card-12`). Its hold says
// where it is:
//
//   triage     an agent is turning the report into a spec (the `triage` workflow)
//   approval   the spec is on the card, and the report's author isn't trusted: a trusted person labels it approved=yes
//   working    the `card` workflow is making the change (spec, work, review), as a pull request
//   edited     its author changed the report: it is triaged again
//
// Nothing here reads what a message means. The triage agent decides what the change is; people decide who
// is trusted and what is approved; the board says who wrote what.
import { spawn, spawnSync } from 'node:child_process'
import { board, env, github, linear, loadWorkflows, notion, slack, workflowResult, workflowsPath, type Board, type By, type Message, type Watch } from 'muster'

/** The sync keys below whose authors are named by a login someone else could take later: `gh`, GitHub's. */
const LOGIN_KEYED = new Set(['gh'])

/** The profiles this module writes as. What they write never starts anything here. */
const OURS = new Set(['intake', 'triage', 'shots', 'workflows'])

/** An actor as the board names it: `slack:user:U123`, `local:user:ada+pino-app`. */
const actorId = (by: By) => (by.profile ? `${by.principal}+${by.profile}` : by.principal)

/**
 * Whether an actor may start work without an approval, and approve a card: the board's owner, as yourself
 * with no profile, and the actor IDs in LOOP_TRUSTED (comma separated), read each time. A Slack, Linear or
 * GitHub author is `<sync key>:user:<their ID>`; an app posting with a token you made is `<your principal>+<its
 * profile>`, trusted only if everyone who can use that app is. An author sync couldn't name is never trusted.
 */
export function trusted(by: By, owner: string): boolean {
  if (by.principal === owner && by.profile === null) return true
  if (/:user:unknown$/.test(by.principal) || !by.principal.includes(':')) return false
  // GitHub's sync names an author by login, which can be renamed and taken by someone else: never trusted by it.
  if (LOGIN_KEYED.has(by.principal.slice(0, by.principal.indexOf(':')))) return false
  const list = (process.env.LOOP_TRUSTED ?? '').split(',').map((each) => each.trim()).filter(Boolean)
  return list.includes(actorId(by))
}

/** A card's channel: one source's, right under `cards/`. A run's channel is a level below, and holds no cards. */
const isCardChannel = (channel: string) => /^cards\/[a-z0-9][a-z0-9_.-]*$/.test(channel)

/** Whether something was written by this module itself, or by the daemon for a run. */
const ours = (by: By, owner: string) => by.principal === owner && by.profile !== null && OURS.has(by.profile)

/** The board as its owner, with no profile: holding and releasing a card is its owner's to do. */
const asOwner = (team: Board) => team.as(null)
const ownerOf = async (team: Board) => (await team.whoami()).principal

/**
 * Agent text on its way to a card, which Slack, Linear and GitHub mirror: it mentions nobody, pings no channel
 * and makes no link or image, as the daemon's own quotes don't. The words stay as written.
 */
const defused = (text: string) =>
  text
    .replaceAll('@', '\uFF20')
    .replaceAll('<', '\uFF1C')
    .replaceAll('>', '\uFF1E')
    .replaceAll('](', '] (')
    .replaceAll('![', '\uFF01[')
    // A bare address unfurls in Slack and links everywhere: `https: //host` reads the same and fetches nothing.
    .replaceAll('://', ': //')
    // A reference-style link definition (`[x]: https://…`) makes a link of any `[x]` above it.
    .replace(/^(\s*)\[([^\]\n]+)\]:/gm, '$1[$2] :')

/** Moves a card from one hold to another. The task is ready for a moment between: no worker takes from `cards`. */
async function rehold(team: Board, card: number, kind: string, reason: string): Promise<void> {
  const owner = asOwner(team)
  await owner.taskUnblock({ id: card })
  await owner.taskBlock({ id: card, kind, reason })
}

/** The latest triage spec on a card: a reply this module wrote as `triage`. Never a reply anyone else wrote. */
async function latestSpec(team: Board, card: number, owner: string): Promise<Message | null> {
  const { replies } = await team.readThread({ id: card })
  return replies.findLast((reply) => !reply.deleted && reply.by.principal === owner && reply.by.profile === 'triage') ?? null
}

/**
 * The runs of `name` this module asked for on a card, oldest first, from the board's own record of each
 * request: what they were asked on, never a label. A watcher tried again reads these to know what it did.
 */
async function requestsOn(team: Board, card: number, owner: string, name: string): Promise<{ seq: number; on: number }[]> {
  const found: { seq: number; on: number }[] = []
  for (let after = 0; ; ) {
    const page = await team.events({ after, filter: { re: card, types: ['workflow.requested'] }, limit: 200 })
    for (const event of page.events) {
      const data = event.data as { name?: unknown; on?: unknown }
      if (data.name === name && event.by.principal === owner && event.by.profile === 'intake') found.push({ seq: event.seq, on: typeof data.on === 'number' ? data.on : card })
    }
    if (page.events.length < 200 || page.cursor <= after) break
    after = page.cursor
  }
  return found
}

/** Asks for a triage of the card, unless one was asked for after `since` (a retry of the same wake). */
async function askTriage(team: Board, card: number, owner: string, since: number): Promise<void> {
  if ((await requestsOn(team, card, owner, 'triage')).some((request) => request.seq > since)) return
  await team.as('intake').workflowRequest({ name: 'triage', on: card })
}

/**
 * Starts the card's change on the spec reply: the `card` workflow quotes it with `{on.text}`. Asked for once
 * per spec, then the card held as working, so a watcher tried again half way finishes what it began.
 */
async function startWork(team: Board, card: number, spec: number, owner: string): Promise<void> {
  if (!(await requestsOn(team, card, owner, 'card')).some((request) => request.on === spec)) await team.as('intake').workflowRequest({ name: 'card', on: spec })
  await rehold(team, card, 'working', 'the card workflow is making the change')
}

/** A line to you, by NOTIFY_CMD when the daemon has it (a command, given one line), and nothing else. */
function notify(line: string): void {
  const command = process.env.NOTIFY_CMD
  if (!command) return
  const [bin, ...args] = command.split(' ').filter(Boolean)
  spawn(bin!, [...args, line], { stdio: 'ignore', detached: true }).unref()
}

const ENDED = new Set(['completed', 'failed', 'canceled'])

/**
 * A card's newest `card` run, from the board's record of the request: its channel, request and tasks by step.
 * Found by the request on the card's thread, never by a label, which anyone who may label could change.
 */
async function latestRun(team: Board, card: Message, owner: string) {
  let found: { seq: number } | null = null
  for (let after = 0; ; ) {
    const page = await team.events({ after, filter: { re: card.id, types: ['workflow.requested'] }, limit: 200 })
    for (const event of page.events) if ((event.data as { name?: unknown }).name === 'card' && event.by.principal === owner && event.by.profile === 'intake') found = { seq: event.seq }
    if (page.events.length < 200 || page.cursor <= after) break
    after = page.cursor
  }
  if (found === null) return null
  const channel = `${card.channel}/card-${found.seq}`
  const tasks = (await team.taskList({ channel, state: 'all' })).tasks.filter((task) => task.by.principal === owner && task.by.profile === 'workflows')
  // Which task is which step, as the daemon made it: a run's agents may label in its channel.
  const steps = new Map<string, (typeof tasks)[number]>()
  for (const task of tasks) {
    const key = await madeStep(team, task.id, owner)
    if (key !== undefined && !steps.has(key)) steps.set(key, task)
  }
  const step = (key: string) => steps.get(key)
  // Ended when nothing in it can go on by itself: every task ended, waiting on one that failed or was canceled,
  // or held because a change wasn't pushed (`push_conflict`, `push_failed`), which a round can fix.
  const stuck = (task: (typeof tasks)[number]) =>
    (task.state === 'waiting' && task.needs.some((need) => ['failed', 'canceled'].includes(tasks.find((each) => each.id === need)?.state ?? ''))) ||
    (task.state === 'blocked' && (task.hold?.kind ?? '').startsWith('push_'))
  return { channel, request: found.seq, work: step('work'), review: step('review'), ended: tasks.length > 0 && tasks.every((task) => ENDED.has(task.state) || stuck(task)) }
}

/** A task's step as the daemon made it, from the task's first event: never its labels now. */
async function madeStep(team: Board, id: number, owner: string): Promise<string | undefined> {
  const made = (await team.events({ after: id - 1, filter: { types: ['message.posted'] }, limit: 1 })).events[0]
  if (made === undefined || made.seq !== id || made.by.principal !== owner || made.by.profile !== 'workflows') return undefined
  return (made.data as { labels?: Record<string, string> }).labels?.['workflow.step']
}

/** The most a screenshot copied to a card may weigh. */
const SHOT_MAX = 5 * 1024 * 1024

/** Whether a file's bytes are a PNG, JPEG, GIF or WebP image, whatever type it was stored with. */
const isImage = (bytes: Buffer) =>
  bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
  (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
  ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1')) ||
  (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP')

/**
 * The screenshots the run's own workers' agents attached to the work this round, attached again on the card:
 * the card is what Slack and Linear mirror, and a run's channel isn't, so this is how they reach your phone.
 * Only images, by their bytes and not the type they were stored with, under SHOT_MAX, ten at most: an agent
 * steered by a report could attach anything, and the card is read outside the board. Once a round.
 */
async function shareScreenshots(team: Board, card: Message, work: number | undefined, owner: string): Promise<void> {
  if (work === undefined) return
  const workers = loadWorkflows(workflowsPath()).find((each) => each.name === 'card')?.workers.as
  if (!workers) return
  const { replies, task } = await team.readThread({ id: work })
  const since = replies.findLastIndex((reply) => reply.by.principal === owner && reply.by.profile === 'intake')
  const shown: Message['attachments'] = []
  for (const reply of replies.slice(since + 1)) {
    if (reply.by.principal !== owner || !reply.by.profile?.startsWith(`${workers}-`)) continue
    for (const file of reply.attachments) {
      if (shown.length >= 10 || file.size > SHOT_MAX) continue
      const got = await team.fileGet({ message: reply.id, id: file.id }).catch(() => null)
      if (got && isImage(Buffer.from(got.data, 'base64'))) shown.push(file)
    }
  }
  if (shown.length === 0) return
  const round = (task?.rounds ?? 0) + 1
  await team.as('shots').reply({ to: card.id, text: `Screenshots from round ${round} of #${work}`, attachments: shown, idempotencyKey: `loop-shots-${work}-${round}` })
}

/** Runs going on from here, so one card's round never gets two workers from this process. */
const going = new Set<string>()

/**
 * A worker on a run's ready tasks, as the card workflow's own workers are: its runner, agent, repository and
 * `--push` from workflows.json, taking only that run's tasks. They stop after ten idle minutes, so a round
 * that starts later has none: this starts one, in the background, and the watcher goes on.
 */
function startWorker(run: { channel: string; request: number }, owner: string, name = 'card'): void {
  // One of the run's own workers may still be waiting for work: it takes the round, and a second would race it.
  if (going.has(run.channel) || spawnSync('pgrep', ['-f', `run --ready ${run.channel} --loop`], { stdio: 'ignore' }).status === 0) return
  const workflow = loadWorkflows(workflowsPath()).find((each) => each.name === name)
  if (!workflow) throw new Error(`no ${name} workflow in workflows.json`)
  const k = workflow.workers
  const args = ['run', '--ready', run.channel, '--loop', '--wait', '2m', ...(k.runner ? ['--runner', k.runner] : ['--cwd', k.cwd!]), '--agent', k.agent, '--as', `${k.as}-round`, ...(k.repo ? ['--repo', k.repo] : []), ...(k.push || workflow.steps.some((step) => step.push === true) ? ['--push'] : []), ...(k.timeout ? ['--timeout', k.timeout] : []), '--by', `${owner}+workflows`, '--label', `workflow=${name}`, '--label', `request=${run.request}`]
  going.add(run.channel)
  const child = spawn(process.env.LOOP_MU ?? 'mu', args, { stdio: 'ignore', detached: true, env: process.env })
  child.on('exit', () => going.delete(run.channel))
  child.on('error', () => going.delete(run.channel))
  child.unref()
}

/**
 * Another round of a card whose run has ended: the trusted comments on it since the last round go to the
 * work task, the work and then the review are sent back (`reopen --round`), and a worker takes them. The
 * work starts from its branch, so the pull request is the same one. Comments made while a round runs wait
 * for it to end; a round's own marker on the card says which comments it took.
 */
async function nextRound(team: Board, cardId: number): Promise<void> {
  const owner = await ownerOf(team)
  const { message: card, replies, task } = await team.readThread({ id: cardId })
  if (!isCardChannel(card.channel) || task?.state !== 'blocked' || task.hold?.kind !== 'working') return
  const run = await latestRun(team, card, owner)
  if (!run?.ended || !run.work || !run.review) return
  // What the round that ended showed goes on the card before the next one starts, whichever watcher got here first.
  await shareScreenshots(team, card, run.work.id, owner)
  const marker = (reply: Message) => reply.by.principal === owner && reply.by.profile === 'intake'
  const since = replies.findLastIndex(marker)
  const asked = replies.slice(since + 1).filter((reply) => !reply.deleted && !ours(reply.by, owner) && trusted(reply.by, owner))
  if (asked.length === 0) return
  const round = run.work.rounds + 2
  const last = asked.at(-1)!.id
  const quoted = asked.map((reply) => `Comment #${reply.id} by ${actorId(reply.by)}:\n${'`'.repeat(4)}\n${reply.text}\n${'`'.repeat(4)}`).join('\n\n')
  await team.as('intake').reply({ to: run.work.id, text: `Round ${round}: what was asked on card #${card.id} since the last round. Do this on top of the work on your branch.\n\n${quoted}`.slice(0, 10_000), idempotencyKey: `loop-ask-${run.work.id}-${last}` })
  // The work first: a review reopened first would be ready before the work it reviews. Each only while it is
  // still ended, so two watchers here at once, or a retry, send it back once.
  const owned = asOwner(team)
  const again = async (id: number) => {
    const now = (await team.readThread({ id })).task
    if (now?.state === 'completed' || now?.state === 'failed') await owned.taskReopen({ id, round: true }).catch(() => {})
    else if (now?.state === 'blocked' && (now.hold?.kind ?? '').startsWith('push_')) await owned.taskUnblock({ id }).catch(() => {})
  }
  await again(run.work.id)
  await again(run.review.id)
  startWorker(run, owner)
  // Last: the marker says these comments were taken, so a retry before it takes them again rather than losing them.
  await team.as('intake').reply({ to: card.id, text: `round ${round}: taking ${asked.map((reply) => `#${reply.id}`).join(', ')}`, idempotencyKey: `loop-round-${card.id}-${last}` })
}

export const watch = {
  // A new report, from anywhere sync or a token brings one: a card held for triage, and the triage workflow asked for.
  intake: {
    tail: { channel: 'cards/', types: ['message.posted'], root: true },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      const message = event.message!
      if (message.re !== null || !isCardChannel(message.channel) || ours(message.by, owner)) return
      // A thread someone else made a task of isn't a card; one this made, a retry carries on with.
      const task = (await team.readThread({ id: message.id })).task
      if (task !== null && !(task.owner.principal === owner && task.owner.profile === 'intake')) return
      if (task === null) await team.taskCreate({ thread: message.id, hold: { kind: 'triage', reason: 'an agent is turning this into a spec' }, idempotencyKey: `loop-card-${message.id}` })
      await askTriage(team, message.id, owner, message.id)
    },
  },

  // A triage run's agent finished: its spec goes on the card, and the change starts, or waits for an approval.
  promote: {
    tail: { channel: 'cards/', types: ['task.completed'] },
    as: 'triage',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      // Only a result the triage run's own worker completed: an agent that completed it with its sandbox's token gets nothing.
      const done = await workflowResult(team, event.task!.id, owner)
      if (done === null || done.workflow !== 'triage' || !done.result) return
      const card = await team.readThread({ id: done.thread })
      if (card.task?.state !== 'blocked' || card.task.hold?.kind !== 'triage') return
      // Only the newest triage: one asked for before the report was last changed read text that isn't there now.
      if ((await requestsOn(team, done.thread, owner, 'triage')).at(-1)?.seq !== done.request) return
      const spec = await team.reply({ to: done.thread, text: defused(done.result), idempotencyKey: `loop-spec-${event.task!.id}` })
      // Trusted only as first written: an edit since was someone's, and the board holds the card as edited then.
      if (trusted(card.message.by, owner) && card.message.revision === 1) return startWork(team, done.thread, spec.id, owner)
      await rehold(team, done.thread, 'approval', 'waiting for a trusted person to label it approved=yes')
      notify(`card #${done.thread} needs your approval: mu read ${done.thread}, then mu label ${done.thread} approved=yes`)
    },
  },

  // A trusted person approved a card: the change starts on the latest spec. Anyone else's label does nothing.
  approve: {
    tail: { channel: 'cards/', types: ['labels.changed'], root: true },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      const set = (event.data as { set?: Record<string, string> }).set ?? {}
      if (set.approved !== 'yes' || !trusted(event.by, owner)) return
      const card = await team.readThread({ id: event.thread! })
      if (!isCardChannel(card.message.channel) || card.task?.state !== 'blocked' || card.task.hold?.kind !== 'approval') return
      const spec = await latestSpec(team, card.message.id, owner)
      // A spec older than the report's last change is about text that isn't there now: it waits for the new triage.
      if (spec === null || (card.message.editedAt !== null && card.message.editedAt > spec.at)) return
      await startWork(team, card.message.id, spec.id, owner)
    },
  },

  // Its author changed the report while it waited: triaged again, from the new text.
  edited: {
    tail: { channel: 'cards/', types: ['task.blocked'], kinds: ['edited'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const card = event.task!
      if (!isCardChannel(card.channel)) return
      const now = (await team.readThread({ id: card.id })).task
      if (now?.hold?.kind === 'edited') await rehold(team, card.id, 'triage', 'the report changed: an agent is turning it into a spec again')
      await askTriage(team, card.id, await ownerOf(team), event.seq)
    },
  },

  // A trusted comment on a card whose run has ended: another round on the same pull request.
  round: {
    tail: { channel: 'cards/', types: ['message.posted'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const message = event.message!
      if (message.re === null || !isCardChannel(message.channel)) return
      await nextRound(team, message.thread)
    },
  },

  // A card's run ended: you hear so once, and comments that came while it ran start the next round.
  settled: {
    tail: { channel: 'cards/', types: ['task.completed', 'task.failed', 'task.canceled'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      const runTask = event.task!
      // The label only says where to look: the request it names is checked against the board's own record below.
      const request = Number((await team.readThread({ id: runTask.id })).message.labels.request)
      if (!/\/card-\d+$/.test(runTask.channel) || !Number.isSafeInteger(request)) return
      const asked = (await team.events({ after: request - 1, filter: { types: ['workflow.requested'] }, limit: 1 })).events[0]
      if (asked?.seq !== request || asked.thread === null || runTask.channel !== `${asked.channel}/card-${request}`) return
      const card = (await team.readThread({ id: asked.thread })).message
      const run = await latestRun(team, card, owner)
      if (run?.channel !== runTask.channel || !run.ended) return
      await shareScreenshots(team, card, run.work?.id, owner)
      notify(`card #${card.id}'s change is done for now: mu read ${card.id}`)
      await nextRound(team, card.id)
    },
  },

  // A task of a run that waited for a person was answered and unblocked: a worker takes it, unless one of the run's is
  // still going. The run's own stopped after ten idle minutes, so an answer that came later would otherwise wait.
  resume: {
    tail: { channel: 'cards/', types: ['task.ready'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      if ((event.data as { from?: unknown }).from !== 'blocked') return
      const task = event.task!
      const run = /^(cards\/[a-z0-9][a-z0-9_.-]*)\/(triage|card)-(\d+)$/.exec(task.channel)
      if (!run) return
      // Only a run this module asked for: the request it names is checked against the board's own record.
      const request = Number(run[3])
      const owner = await ownerOf(team)
      const asked = (await team.events({ after: request - 1, filter: { types: ['workflow.requested'] }, limit: 1 })).events[0]
      if (asked?.seq !== request || asked.channel !== run[1] || (asked.data as { name?: unknown }).name !== run[2] || asked.by.principal !== owner || asked.by.profile !== 'intake') return
      startWorker({ channel: task.channel, request }, owner, run[2])
    },
  },

  // A task of a card's run waits for a person: you are told its ID, and nothing it says.
  'needs-me': {
    tail: { channel: 'cards/', types: ['task.blocked'], kinds: ['!triage', '!approval', '!working'] },
    run: ({ event }) => notify(`task #${event.task!.id} is blocked: mu read ${event.task!.id}`),
  },
} satisfies Record<string, Watch>

/**
 * Where reports come from, each into its own channel under `cards/`. Keep the ones you use, with your own IDs
 * and keys. A thread started in any of them is a report; a reply in it is a comment on the card, both ways. An
 * app posts its reports to `cards/app` with a token you make for it (see the README), and the inspector
 * posts wherever you choose.
 */
export const sync = {
  // A Slack channel, by its ID: the one people send feedback in.
  slack: slack({ secret: env('SLACK_SIGNING_SECRET'), token: env('SLACK_BOT_TOKEN'), channels: { C0123456789: 'cards/slack' } }),
  // A Linear team, by its key: issues filed there are reports, and the card's replies are comments on them.
  lin: linear({ secret: env('LINEAR_WEBHOOK_SECRET'), token: env('LINEAR_API_KEY'), teams: { ENG: 'cards/linear' } }),
  // GitHub issues on your repository, with the card's replies sent back as comments.
  gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), token: env('GITHUB_TOKEN'), repos: { 'your-org/your-repo': { issues: 'cards/github', mirror: true } } }),
  // A Notion database, by its data source ID: its pages are reports, and the card's replies are comments on them.
  // NOTION_WEBHOOK_SECRET is `pending` until Notion has sent its verification token: see the Notion sync page.
  nt: notion({ secret: env('NOTION_WEBHOOK_SECRET'), token: env('NOTION_TOKEN'), databases: { '00000000000040008000000000000000': 'cards/notion' } }),
}

export const team = board({ sync, watch })
