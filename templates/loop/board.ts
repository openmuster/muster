// The loop's board module: feedback from anywhere becomes a card, an agent works it as a pull request, and
// a trusted reply on the card starts another round on the same pull request. `mu serve --module <this file>`
// runs it, with the `triage` and `card` workflows from workflows.json. Importing it opens, reads and starts
// nothing: who is trusted, and the secrets, are read when a watcher runs or the board starts.
//
// A card is a thread in a source's channel under `cards/` (`cards/slack`, `cards/linear`, `cards/github`,
// `cards/notion`, `cards/app`), and a task. A card's runs are in channels under its own (`cards/slack/card-12`). Its hold says
// where it is:
//
//   backlog    parked: nothing runs until it is moved to ready
//   planning   an agent shapes it with the people who asked (the `planning` workflow): it answers with questions
//              and a draft card, and each trusted reply is another round. Nothing is built until it is ready
//   triage     an agent is turning the report into a spec (the `triage` workflow)
//   approval   the spec is on the card, and the report's author isn't trusted: a trusted person labels it approved=yes
//   working    the `card` workflow is making the change (spec, work, review), as a pull request
//   edited     its author changed the report: it is triaged again, or parked again where it was
//   duplicate  the triage found the same request on another card: approved=yes from someone trusted works it anyway
//   declined   the triage made no card (nothing to change here, or its agent stopped): edit the report, or move
//              it to ready again, to try again
//
// A card's stage follows its status where its source has one (a Notion page's Status, a Linear issue's state:
// SOURCES below), and otherwise a `stage` label a trusted person sets (backlog, planning or ready; ready when
// there is none). The loop writes In progress back when the work starts, and Done when the review approves it,
// and then the card is completed: a trusted reply on it after that starts another round, as before.
//
// Nothing here reads what a message means. The triage agent decides what the change is; people decide who
// is trusted and what is approved; the board says who wrote what.
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { board, env, fenced, github, linear, LINEAR_SCOPES, loadWorkflows, notion, slack, workflowResult, workflowsPath, type Board, type By, type Message, type Watch } from '@openmuster/muster'
import { readProjects, type Project } from './projects.ts'

/** The sync keys below whose authors are named by a login someone else could take later: `gh`, GitHub's. */
const LOGIN_KEYED = new Set(['gh'])

/** The profiles this module writes as. What they write never starts anything here. */
const OURS = new Set(['intake', 'triage', 'shots', 'workflows', 'loop', 'cards', 'planner'])

/** An actor as the board names it: `slack:user:U123`, `local:user:ada+pino-app`. */
const actorId = (by: By) => (by.profile ? `${by.principal}+${by.profile}` : by.principal)

/** loop-projects.json as last read, by where it is and when it last changed. */
let read: { key: string; projects: Record<string, Project> } | undefined

/**
 * The projects in loop-projects.json, beside workflows.json, read again when it changes. None without the file:
 * every card is then right under `cards/`, as before projects. A file that is wrong throws, rather than run a
 * project's cards on the template's repository.
 */
function projects(): Record<string, Project> {
  const path = join(dirname(workflowsPath()), 'loop-projects.json')
  let key: string
  try {
    const stat = statSync(path)
    key = `${path}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return {}
  }
  if (read?.key !== key) read = { key, projects: readProjects(JSON.parse(readFileSync(path, 'utf8'))) }
  return read.projects
}

/** The project a channel is under (`cards/acme/linear` is acme's), or null for a card right under `cards/`. */
function projectOf(channel: string): string | null {
  const name = /^cards\/([a-z0-9][a-z0-9_-]*)\//.exec(channel)?.[1]
  return name !== undefined && Object.hasOwn(projects(), name) ? name : null
}

/** A workflow's name for a project's cards: `triage.acme`. Right under `cards/`, the template's own. */
const flow = (name: string, project: string | null) => (project === null ? name : `${name}.${project}`)

/**
 * Whether an actor may start work without an approval, and approve a card: the board's owner, as yourself
 * with no profile, and the actor IDs in LOOP_TRUSTED (comma separated), read each time, or on a project's cards
 * its own `trusted` list when it has one. A Slack, Linear or GitHub author is `<sync key>:user:<their ID>`; an
 * app posting with a token you made is `<your principal>+<its profile>`, trusted only if everyone who can use
 * that app is. An author sync couldn't name is never trusted.
 */
export function trusted(by: By, owner: string, project: string | null): boolean {
  if (by.principal === owner && by.profile === null) return true
  if (/:user:unknown$/.test(by.principal) || !by.principal.includes(':')) return false
  // GitHub's sync names an author by login, which can be renamed and taken by someone else: never trusted by it.
  if (LOGIN_KEYED.has(by.principal.slice(0, by.principal.indexOf(':')))) return false
  const own = project === null ? undefined : projects()[project]?.trusted
  const list = own ?? (process.env.LOOP_TRUSTED ?? '').split(',').map((each) => each.trim()).filter(Boolean)
  return list.includes(actorId(by))
}

/**
 * A card's channel: one source's, right under `cards/`, or right under a project's `cards/<project>/`. A run's
 * channel is a level below a card's, and holds no cards.
 */
function isCardChannel(channel: string): boolean {
  const project = projectOf(channel)
  if (project !== null) return new RegExp(`^cards/${project}/[a-z0-9][a-z0-9_.-]*$`).test(channel)
  // `cards/acme` is a project's subtree, never a source's channel.
  const segment = /^cards\/([a-z0-9][a-z0-9_.-]*)$/.exec(channel)?.[1]
  return segment !== undefined && !Object.hasOwn(projects(), segment)
}

/** A run's channel as the daemon names it, under its card's (`cards/acme/linear/card.acme-41`), or null. */
function runOf(channel: string): { card: string; base: string; name: string; request: number } | null {
  const run = /^(.+)\/(triage|planning|card)(?:\.([a-z0-9][a-z0-9_-]*))?-(\d+)$/.exec(channel)
  if (!run || !isCardChannel(run[1]!) || (run[3] ?? null) !== projectOf(run[1]!)) return null
  return { card: run[1]!, base: run[2]!, name: flow(run[2]!, run[3] ?? null), request: Number(run[4]) }
}

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

/**
 * Asks for a triage of the card, unless one was asked for after `since` (a retry of the same wake). It is
 * asked on a list of the other cards, kept on the board alone (never sent to Slack, Linear or Notion), which
 * the triage quotes with `{on.text}`, so it can say which are related, or the same request.
 */
async function askTriage(team: Board, card: number, owner: string, since: number): Promise<void> {
  const name = flow('triage', projectOf((await team.readThread({ id: card })).message.channel))
  if ((await requestsOn(team, card, owner, name)).some((request) => request.seq > since)) return
  await request(team, card, owner, name, 'its triage', `${since}`, async () => (await team.as('cards').reply({ to: card, text: await triageContext(team, card, owner), noSync: true, idempotencyKey: `loop-cards-${card}-${since}` })).id)
}

/** How much a triage is shown besides the report: a run quotes a message up to 2,000 characters. */
const CONTEXT_MAX = 1_900

/**
 * What a triage is shown besides the report: the newest plan made in planning, when there is one and the
 * report hasn't changed since, then as many of the other cards as fit, newest first.
 */
async function triageContext(team: Board, card: number, owner: string): Promise<string> {
  const { message, replies } = await team.readThread({ id: card })
  const plan = replies.findLast((reply) => !reply.deleted && reply.by.principal === owner && reply.by.profile === 'planner')
  // Only a plan made since the report last changed: by the board's order, which a clock can't tie.
  const changed = message.editedAt === null ? 0 : ((await team.events({ after: card, filter: { re: card, types: ['message.edited'] }, limit: 1000 })).events.filter((event) => (event.data as { id?: unknown }).id === card).at(-1)?.seq ?? 0)
  const fresh = plan !== undefined && plan.id > changed
  // What the people who asked said after the planner's last answer: an answer it didn't get to see goes to the triage.
  const since = fresh ? replies.filter((reply) => reply.id > plan.id && !reply.deleted && !ours(reply.by, owner) && trusted(reply.by, owner, projectOf(message.channel))).map((reply) => `${actorId(reply.by)}: ${reply.text.slice(0, 300)}`).join('\n').slice(0, 600) : ''
  const planned = fresh ? `The card as planned with the people who asked, in #${plan.id}:\n${plan.text.slice(0, 1_000)}\n\n${since ? `Said on the card since:\n${since}\n\n` : ''}` : ''
  const [heading, ...lines] = await otherCards(team, card, owner)
  let out = planned + heading!
  for (const line of lines) {
    if (out.length + line.length + 1 > CONTEXT_MAX) break
    out += `\n${line}`
  }
  return out
}

/**
 * Whether anyone can read a card channel where its cards come from (a public repository's issues): a triage of
 * a card from one is shown only cards from these, since what it writes is mirrored there and could repeat another
 * card's words. `cards/github` by default; LOOP_PUBLIC (comma separated) replaces the list. On a project's cards,
 * its own sources by name (`public`), or the same sources LOOP_PUBLIC names.
 */
function isPublic(channel: string): boolean {
  const project = projectOf(channel)
  const open = (process.env.LOOP_PUBLIC ?? 'cards/github').split(',').map((each) => each.trim())
  if (project === null) return open.includes(channel)
  // A project's sources by name, or the ones LOOP_PUBLIC names under `cards/`: `cards/github` is `cards/acme/github`.
  const sources = projects()[project]?.public ?? open.map((each) => each.replace(/^cards\//, ''))
  return sources.some((source) => channel === `cards/${project}/${source}`)
}

/** The other cards of the same project, newest first, after a heading: `#id  stage  first line`. Canceled ones aren't. */
async function otherCards(team: Board, card: number, owner: string): Promise<string[]> {
  const mine = (await team.readThread({ id: card })).message.channel
  const channels = (await team.channels()).channels.map((each) => each.path).filter((path) => isCardChannel(path) && projectOf(path) === projectOf(mine) && (!isPublic(mine) || isPublic(path)))
  const found: { id: number; line: string }[] = []
  for (const channel of channels) {
    const { tasks } = await team.taskList({ channel, state: 'all', latest: true, limit: 1000 })
    for (const task of tasks) {
      if (task.id === card || task.channel !== channel || task.owner.principal !== owner || task.owner.profile !== 'intake' || task.state === 'canceled') continue
      const where = task.state === 'blocked' ? (task.hold?.kind ?? 'blocked') : task.state
      found.push({ id: task.id, line: `#${task.id}  ${where}  ${(task.text.split('\n')[0] ?? '').slice(0, 80)}` })
    }
  }
  const lines = found.sort((a, b) => b.id - a.id).map((each) => each.line)
  return lines.length ? ['Other cards on this board, newest first:', ...lines] : ['There are no other cards on this board.']
}

/** Asks for the card's planning run, unless one was asked for after `since`. */
async function askPlan(team: Board, card: number, owner: string, since: number): Promise<void> {
  const name = flow('planning', projectOf((await team.readThread({ id: card })).message.channel))
  if ((await requestsOn(team, card, owner, name)).some((request) => request.seq > since)) return
  await request(team, card, owner, name, 'its planning', `${since}`, async () => card)
}

/**
 * Another round of planning: the trusted comments on a card in planning, since its planner last answered,
 * go to the plan task, which is sent back, and a worker takes it. One run per card: the agent reads its own
 * thread for the rounds before. Comments made while it works wait for its answer.
 */
async function nextPlanRound(team: Board, cardId: number): Promise<boolean> {
  const owner = await ownerOf(team)
  const { message: card, replies, task } = await team.readThread({ id: cardId })
  if (!isCardChannel(card.channel) || task?.state !== 'blocked' || task.hold?.kind !== 'planning') return false
  const run = await latestRun(team, card, owner, 'planning')
  if (!run?.ended || !run.plan) return false
  const project = projectOf(card.channel)
  const waiting = takenSince(replies, owner, run.request, project)
  if (waiting.length === 0) return false
  const round = run.plan.rounds + 2
  const { text: quoted, taken: asked } = quote(waiting)
  const last = asked.at(-1)!.id
  // Past a cap the round waits, with the card still held for planning: a run that ends starts it.
  const full = await serial(async () => {
    const full = await busy(team, owner, project)
    if (full !== null) return full
    await team.as('intake').reply({ to: run.plan!.id, text: `Round ${round}: what was said on card #${card.id} since your last answer. Answer it, and give the card as it stands now.\n\n${quoted}`, idempotencyKey: `loop-ask-${run.plan!.id}-${last}` })
    const now = (await team.readThread({ id: run.plan!.id })).task
    if (now?.state === 'completed' || now?.state === 'failed') await asOwner(team).taskReopen({ id: run.plan!.id, round: true }).catch(() => {})
    return null
  })
  if (full !== null) {
    await note(team, card.id, `waiting: ${full}, so planning round ${round} starts when one ends`, `wait-plan-round-${last}`)
    return true
  }
  startWorker(run, owner, flow('planning', project))
  await team.as('intake').reply({ to: card.id, text: `planning round ${round}: taking ${asked.map((reply) => `#${reply.id}`).join(', ')}`, idempotencyKey: `loop-plan-round-${card.id}-${last}` })
  return true
}

/**
 * What a triage said about other cards, on lines before its card: `related: #36, #16` and `duplicate-of: #36`.
 * Only cards of this loop count, never this one; anything else is left out. The rest is the card.
 */
async function linksIn(team: Board, result: string, card: number, owner: string): Promise<{ spec: string; related: Message[]; duplicate: Message | null }> {
  const lines = result.split('\n')
  const related: Message[] = []
  let duplicate: Message | null = null
  const project = projectOf((await team.readThread({ id: card })).message.channel)
  const cardOf = async (id: number) => {
    if (id === card || !Number.isSafeInteger(id)) return null
    const read = await team.readThread({ id }).catch(() => null)
    if (!read || read.message.re !== null || !isCardChannel(read.message.channel) || projectOf(read.message.channel) !== project || read.task?.owner.principal !== owner || read.task.owner.profile !== 'intake') return null
    return read.message
  }
  while (lines.length > 0) {
    const line = /^\s*(related|duplicate-of)\s*:\s*(.*)$/i.exec(lines[0]!)
    if (!line) break
    lines.shift()
    for (const [, id] of line[2]!.matchAll(/#?(\d+)/g)) {
      const found = await cardOf(Number(id))
      if (found === null) continue
      if (line[1]!.toLowerCase() === 'duplicate-of') duplicate ??= found
      else if (related.length < 10 && !related.some((each) => each.id === found.id)) related.push(found)
    }
  }
  while (lines[0]?.trim() === '') lines.shift()
  return { spec: lines.join('\n'), related, duplicate }
}

/** Linear issues of two cards marked related in Linear too, when both came from the same Linear sync. Best effort. */
async function relateInLinear(team: Board, card: number, others: Message[]): Promise<void> {
  const made = await madeOf(team, card)
  const source = made?.key ? sources()[made.key] : undefined
  if (source?.type !== 'linear' || !made?.external?.startsWith('issue:')) return
  const api = process.env.LOOP_LINEAR_API ?? 'https://api.linear.app/graphql'
  for (const other of others) {
    const theirs = await madeOf(team, other.id)
    if (theirs?.key !== made.key || !theirs.external?.startsWith('issue:')) continue
    const variables = { a: made.external.slice(6), b: theirs.external.slice(6) }
    const relate = async (authorization: string) => answer(await fetch(api, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation($a: String!, $b: String!) { issueRelationCreate(input: { issueId: $a, relatedIssueId: $b, type: related }) { success } }', variables }) }))
    await signed(source, relate).catch(() => null)
  }
}

/**
 * Starts the card's change on the spec reply: the `card` workflow quotes it with `{on.text}`. Asked for once
 * per spec, then the card held as working, so a watcher tried again half way finishes what it began.
 */
async function startWork(team: Board, card: number, spec: number, owner: string): Promise<void> {
  const { message, task } = await team.readThread({ id: card })
  const name = flow('card', projectOf(message.channel))
  if (!(await requestsOn(team, card, owner, name)).some((request) => request.on === spec)) {
    const waiting = await request(team, card, owner, name, 'the change', `${spec}`, async () => spec)
    if (waiting !== null) {
      if (task?.hold?.kind !== 'queued') await rehold(team, card, 'queued', `waiting: ${waiting}`)
      return
    }
  }
  await rehold(team, card, 'working', 'the card workflow is making the change')
  await setStatus(team, card, 'working', spec)
}

/** Where a card is. backlog and planning are parked; ready goes to triage; working and done are the loop's. */
type Stage = 'backlog' | 'planning' | 'ready' | 'working' | 'done' | 'canceled'

/**
 * The sources with a status, by their sync's key in `sync` below: what each status means (by its name as the
 * board labels it, `state=in-progress` for "In progress"), the statuses the loop writes back, and the variables
 * that hold what it writes with: a token, or for Linear the same OAuth app's client ID and secret its sync
 * uses. A status not listed parks the card. LOOP_STAGES, JSON in the same shape, replaces an entry:
 * `{"nt":{"type":"notion","token":"NOTION_TOKEN","stages":{"inbox":"ready"}}}`. Notion's integration needs
 * "Update content" to write a status; with nothing to write with, the loop writes none. A Linear app's token is
 * asked for with its sync's scopes (`scopes`, the sync's default unless you gave the sync others): Linear ends an
 * app's earlier tokens when one is asked for with different scopes, and the sync's would be among them.
 */
type Source = { type: 'notion' | 'linear'; token: string; clientId?: string; clientSecret?: string; scopes?: readonly string[]; stages: Record<string, Stage>; write?: { working?: string; done?: string } }
const SOURCES: Record<string, Source> = {
  nt: { type: 'notion', token: 'NOTION_TOKEN', stages: { 'not-started': 'backlog', planning: 'planning', ready: 'ready', 'in-progress': 'working', done: 'done' }, write: { working: 'in-progress', done: 'done' } },
  lin: { type: 'linear', token: 'LINEAR_API_KEY', clientId: 'LINEAR_CLIENT_ID', clientSecret: 'LINEAR_CLIENT_SECRET', stages: { triage: 'planning', backlog: 'backlog', todo: 'ready', 'in-progress': 'working', done: 'done', canceled: 'canceled', duplicate: 'canceled' }, write: { working: 'in-progress', done: 'done' } },
}
const sources = (): Record<string, Source> => {
  try {
    return { ...SOURCES, ...(JSON.parse(process.env.LOOP_STAGES || '{}') as Record<string, Source>) }
  } catch {
    return SOURCES
  }
}

/** A status's name as the board labels it, as sync makes a `state` label. */
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

/** The holds a card's stage moves it out of. Not `working`, nor a hold a person or an agent put it in. */
const MOVABLE = new Set(['backlog', 'planning', 'triage', 'approval', 'edited', 'declined', 'duplicate', 'queued'])

/** A card held `queued` for its next round, not for its first change: the reason tells the two apart. */
const ROUND_WAITS = 'the next round waits for a run to end'
const waitsForRound = (hold: { kind: string; reason: string | null } | null | undefined) => hold?.kind === 'queued' && hold.reason === ROUND_WAITS
const PARKED: Record<string, string> = {
  backlog: 'in the backlog: move it to ready to start it',
  planning: 'in planning: an agent shapes it with you, and it is built once it is moved to ready',
}

/**
 * How a card came in, from the board's own record of its first message: the sync it came from and its ID
 * there, written by sync alone, and never a label (`source` and `ref` are anyone's to set).
 */
async function madeOf(team: Board, card: number): Promise<{ by: By; labels: Record<string, string>; key: string | null; external: string | null } | null> {
  const made = (await team.events({ after: card - 1, filter: { types: ['message.posted'] }, limit: 1 })).events[0]
  if (made === undefined || made.seq !== card) return null
  const data = made.data as { labels?: Record<string, string>; origin?: { key?: unknown; external?: unknown } }
  const key = typeof data.origin?.key === 'string' ? data.origin.key : null
  const synced = key !== null && made.by.profile === null && (made.by.principal === key || made.by.principal.startsWith(`${key}:user:`))
  return { by: made.by, labels: data.labels ?? {}, key: synced ? key : null, external: synced && typeof data.origin?.external === 'string' ? data.origin.external : null }
}

/**
 * A card's stage. From a source with a status, the newest `state` its own sync set: anyone may label, so a
 * `state` someone else set counts for nothing. From any other, the newest `stage` a trusted person set.
 */
async function stageOf(team: Board, card: number, owner: string): Promise<Stage> {
  const made = await madeOf(team, card)
  if (made === null) return 'ready'
  const project = projectOf((await team.readThread({ id: card })).message.channel)
  const source = made.key === null ? undefined : sources()[made.key]
  const bySync = (by: By) => made.key !== null && by.profile === null && (by.principal === made.key || by.principal.startsWith(`${made.key}:user:`))
  // Its first labels count: `madeOf` names no source unless sync itself wrote the card.
  let state = made.labels.state
  let stage = trusted(made.by, owner, project) ? made.labels.stage : undefined
  for (let after = card; ; ) {
    const page = await team.events({ after, filter: { re: card, types: ['labels.changed'] }, limit: 200 })
    for (const event of page.events) {
      const data = event.data as { id?: unknown; set?: Record<string, string>; unset?: string[] }
      if (data.id !== card) continue
      if (bySync(event.by) && ('state' in (data.set ?? {}) || data.unset?.includes('state'))) state = data.set?.state
      if (trusted(event.by, owner, project) && ('stage' in (data.set ?? {}) || data.unset?.includes('stage'))) stage = data.set?.stage
    }
    if (page.events.length < 200 || page.cursor <= after) break
    after = page.cursor
  }
  if (source !== undefined && state !== undefined) return source.stages[state] ?? 'backlog'
  return stage === 'backlog' || stage === 'planning' ? stage : 'ready'
}

/** A line on a card from the loop itself, as `loop`: never `intake`, whose replies on a card mark a round. */
const note = (team: Board, card: number, text: string, key: string) => team.as('loop').reply({ to: card, text: defused(text), idempotencyKey: `loop-note-${card}-${key}` }).then(() => {}, () => {})

/**
 * Moves a card to the stage it is in now: parked, or to triage. Never out of `working` or a hold someone
 * else put it in, and never on what the loop itself writes back (In progress, Done): a person moving it there
 * reads the same, so those move nothing. Canceled (Linear's Canceled and Duplicate) cancels it.
 */
async function reconcile(team: Board, card: number, since: number): Promise<void> {
  const owner = await ownerOf(team)
  const { message, task } = await team.readThread({ id: card })
  if (!isCardChannel(message.channel) || task === null || task.owner.principal !== owner || task.owner.profile !== 'intake') return
  const wanted = await stageOf(team, card, owner)
  const hold = task.state === 'blocked' ? (task.hold?.kind ?? '') : ''
  if (wanted === 'canceled') {
    // A run going on would go on without its card: it finishes first, and the card says why it stays.
    if (hold === 'working') return note(team, card, 'still working: a run is going, so it isn\'t canceled', `cancel-${since}`)
    if (!ENDED.has(task.state)) await asOwner(team).taskCancel({ id: card })
    return
  }
  if (wanted === 'backlog' || wanted === 'planning') {
    if (hold === 'working') return note(team, card, `still working: a run is going, so it isn't moved to ${wanted}`, `park-${since}`)
    if (hold !== wanted && !MOVABLE.has(hold)) return
    if (hold !== wanted) await rehold(team, card, wanted, PARKED[wanted]!)
    // Planning starts once per card: moved back to it later, its planner goes on when someone replies.
    if (wanted === 'planning' && (await requestsOn(team, card, owner, flow('planning', projectOf(message.channel)))).length === 0) await askPlan(team, card, owner, 0)
    return
  }
  if (wanted !== 'ready' || !['backlog', 'planning', 'triage', 'declined', 'duplicate'].includes(hold)) return
  if (hold !== 'triage') await rehold(team, card, 'triage', 'an agent is turning this into a spec')
  // Asked once since it was last held for triage, so a retry half way, or another move to ready, asks once.
  await askTriage(team, card, owner, await heldSince(team, card, 'triage'))
}

/** The newest event that held a card in `kind`, or the card itself when it was made so. */
async function heldSince(team: Board, card: number, kind: string): Promise<number> {
  let found = card
  for (let after = card; ; ) {
    const page = await team.events({ after, filter: { re: card, types: ['task.blocked'] }, limit: 200 })
    for (const event of page.events) if ((event.data as { id?: unknown; kind?: unknown }).id === card && (event.data as { kind?: unknown }).kind === kind) found = event.seq
    if (page.events.length < 200 || page.cursor <= after) break
    after = page.cursor
  }
  return found
}

/**
 * Writes a card's status back to where it came from (`working` or `done`, as SOURCES names them), when its
 * source has a status and the loop has its token. A write that fails is said on the card, and the card goes on.
 */
async function setStatus(team: Board, card: number, stage: 'working' | 'done', since: number): Promise<void> {
  const made = await madeOf(team, card)
  const source = made?.key ? sources()[made.key] : undefined
  const want = source?.write?.[stage]
  if (!made?.external || !source || !want) return
  try {
    await signed(source, (authorization) => (source.type === 'notion' ? notionStatus(made.external!, want, authorization) : linearStatus(made.external!, want, authorization)))
  } catch (error) {
    await note(team, card, `couldn't set its ${source.type === 'notion' ? 'Notion' : 'Linear'} status to ${want}: ${String((error as Error)?.message ?? error).slice(0, 300)}`, `status-${stage}-${since}`)
  }
}

/** The Linear app's own token, kept until shortly before it runs out. */
let appToken: { id: string; token: string; until: number } | undefined

/**
 * How the loop signs what it writes to a source. A Linear OAuth app, when its client ID and secret are set,
 * comes first: the loop then writes as the same app its sync comments as, never as whoever owns a key also
 * left in the environment. Its token is asked for with the client credentials, as its sync asks (the same
 * scopes, so the sync's token stays good). Otherwise the source's token. Null when it has neither.
 */
async function authOf(source: Source): Promise<string | null> {
  const id = source.clientId ? process.env[source.clientId] : undefined
  const secret = source.clientSecret ? process.env[source.clientSecret] : undefined
  if (source.type === 'linear' && id && secret) {
    if (appToken?.id === id && appToken.until > Date.now() + 60_000) return `Bearer ${appToken.token}`
    const api = process.env.LOOP_LINEAR_API ?? 'https://api.linear.app/graphql'
    const got = await answer(await fetch(new URL('/oauth/token', api).href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: (source.scopes ?? LINEAR_SCOPES).join(','), client_id: id, client_secret: secret }).toString() }))
    if (typeof got?.access_token !== 'string' || !got.access_token) throw new Error('Linear made no token for the app')
    appToken = { id, token: got.access_token, until: Date.now() + (Number(got.expires_in) || 0) * 1000 }
    return `Bearer ${appToken.token}`
  }
  const token = process.env[source.token]
  if (!token) return null
  // A Linear personal API key goes as it is; everything else is a bearer token.
  return source.type === 'linear' && (token.startsWith('lin_api_') || /^bearer /i.test(token)) ? token : `Bearer ${token}`
}

/**
 * Does a write signed as `authOf` says. A Linear app's token Linear refused (401: one asked for since, with other
 * scopes, ended it) is asked for again, and the write tried once more, as its sync does. Nothing to sign with: nothing.
 */
async function signed(source: Source, write: (authorization: string) => Promise<unknown>): Promise<void> {
  const authorization = await authOf(source)
  if (authorization === null) return
  try {
    await write(authorization)
  } catch (error) {
    if (!(error instanceof Refused) || error.status !== 401 || appToken === undefined || authorization !== `Bearer ${appToken.token}`) throw error
    appToken = undefined
    const again = await authOf(source)
    if (again !== null) await write(again)
  }
}

/** What a platform answered when it said no. */
class Refused extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** A platform's answer as JSON, or what it said went wrong. */
async function answer(response: Response): Promise<any> {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Refused(response.status, `${response.status} ${String(body?.message ?? body?.errors?.[0]?.message ?? '')}`.trim())
  if (body?.errors?.length) throw new Error(String(body.errors[0]?.message ?? 'an error'))
  return body
}

/** A Notion page's Status (or a select called Status) set to the option whose name reads as `want`. */
async function notionStatus(external: string, want: string, authorization: string): Promise<void> {
  if (!external.startsWith('page:')) throw new Error(`not a page: ${external}`)
  const api = process.env.LOOP_NOTION_API ?? 'https://api.notion.com/v1'
  const headers = { authorization, 'notion-version': '2026-03-11', 'content-type': 'application/json' }
  const id = external.slice(5)
  const page = await answer(await fetch(`${api}/pages/${id}`, { headers }))
  const found = Object.entries(page.properties ?? {}).find(([name, property]: [string, any]) => property?.type === 'status' || (property?.type === 'select' && /^status$/i.test(name)))
  if (!found) throw new Error('the page has no Status')
  const [name, property] = found as [string, { type: 'status' | 'select' }]
  const parent = page.parent ?? {}
  const schema = await answer(await fetch(parent.data_source_id ? `${api}/data_sources/${parent.data_source_id}` : `${api}/databases/${parent.database_id}`, { headers }))
  const option = (schema.properties?.[name]?.[property.type]?.options ?? []).find((each: { name?: string }) => slug(String(each.name ?? '')) === want)
  if (!option) throw new Error(`its ${name} has no option for ${want}`)
  await answer(await fetch(`${api}/pages/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ properties: { [name]: { [property.type]: { name: option.name } } } }) }))
}

/** A Linear issue moved to its team's state whose name reads as `want`. */
async function linearStatus(external: string, want: string, authorization: string): Promise<void> {
  if (!external.startsWith('issue:')) throw new Error(`not an issue: ${external}`)
  const api = process.env.LOOP_LINEAR_API ?? 'https://api.linear.app/graphql'
  const ask = async (query: string, variables: Record<string, unknown>) => (await answer(await fetch(api, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) }))).data
  const id = external.slice(6)
  const states = (await ask('query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }', { id }))?.issue?.team?.states?.nodes ?? []
  const state = states.find((each: { name?: string }) => slug(String(each.name ?? '')) === want)
  if (!state) throw new Error(`its team has no state for ${want}`)
  const moved = await ask('mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }', { id, state: state.id })
  if (moved?.issueUpdate?.success !== true) throw new Error('Linear refused the change')
}

/**
 * The card done: its status written back, and its task completed by its owner. A card that can't be
 * completed now (its budget is spent, say) is held `done` instead. Either way a trusted reply starts a round.
 */
async function finish(team: Board, card: number, since: number, review: { id: number; rounds: number }): Promise<void> {
  const { message, task: now } = await team.readThread({ id: card })
  if (now?.state !== 'blocked' || now.hold?.kind !== 'working') return
  // Not if a round started since the review was read: that round's review decides.
  const again = (await team.readThread({ id: review.id })).task
  if (again?.state !== 'completed' || again.rounds !== review.rounds || !(await latestRun(team, message, await ownerOf(team)))?.ended) return
  await setStatus(team, card, 'done', since)
  const owned = asOwner(team)
  await owned.taskUnblock({ id: card })
  try {
    const held = await owned.taskClaim({ id: card })
    await owned.taskComplete({ id: card, token: held.token, result: 'the review approved the change' })
  } catch {
    await owned.taskBlock({ id: card, kind: 'done', reason: 'the review approved the change' }).catch(() => {})
  }
}

/**
 * A line to you, by NOTIFY_CMD when the daemon has it (a command, given one line), and nothing else. A line
 * about a project's card starts with its name: `acme: card #12 needs your approval`.
 */
function notify(line: string, channel: string): void {
  const command = process.env.NOTIFY_CMD
  if (!command) return
  const project = projectOf(channel)
  const [bin, ...args] = command.split(' ').filter(Boolean)
  spawn(bin!, [...args, project === null ? line : `${project}: ${line}`], { stdio: 'ignore', detached: true }).unref()
}

/** The caps set: each project's `maxRuns`, and LOOP_MAX_RUNS for every run of the loop. Null with neither. */
function caps(): { all: number | null; of: Record<string, number> } | null {
  const all = Number.parseInt(process.env.LOOP_MAX_RUNS ?? '', 10)
  const of = Object.fromEntries(Object.entries(projects()).flatMap(([name, project]) => (project.maxRuns === undefined ? [] : [[name, project.maxRuns]])))
  return all >= 1 || Object.keys(of).length > 0 ? { all: all >= 1 ? all : null, of } : null
}

/**
 * The loop's runs going, by project (`''` for the cards right under `cards/`): asked for and not yet made by the
 * daemon (after its place among requests), or with a task ready or being worked. A run waiting on a person, or
 * ended, takes no place.
 */
async function runsGoing(team: Board, owner: string, except?: string): Promise<Map<string, number>> {
  const going = new Map<string, string>()
  for (const state of ['ready', 'claimed'] as const) {
    for (const task of (await team.taskList({ channel: 'cards/', state, limit: 1000 })).tasks) {
      if (task.channel !== except && task.by.principal === owner && task.by.profile === 'workflows' && runOf(task.channel) !== null) going.set(task.channel, projectOf(task.channel) ?? '')
    }
  }
  for (let after = (await asOwner(team).cursorGet('workflow:requests')) ?? 0; ; ) {
    const page = await team.events({ after, filter: { types: ['workflow.requested'] }, limit: 200 })
    for (const event of page.events) if (event.by.principal === owner && event.by.profile === 'intake' && event.channel !== null) going.set(`#${event.seq}`, projectOf(event.channel) ?? '')
    if (page.events.length < 200 || page.cursor <= after) break
    after = page.cursor
  }
  const counts = new Map<string, number>()
  for (const project of going.values()) counts.set(project, (counts.get(project) ?? 0) + 1)
  return counts
}

/**
 * Why a run of a project (null: the cards right under `cards/`) would wait now, or null when it may go on.
 * `except` is a run's own channel, for a run going on again, which mustn't count itself.
 */
async function busy(team: Board, owner: string, project: string | null, except?: string): Promise<string | null> {
  const set = caps()
  if (set === null) return null
  const going = await runsGoing(team, owner, except)
  const runs = (n: number, of = '') => `${n} run${n === 1 ? '' : 's'}${of} ${n === 1 ? 'is' : 'are'} going`
  const mine = going.get(project ?? '') ?? 0
  if (project !== null && set.of[project] !== undefined && mine >= set.of[project]) return runs(mine, ` of ${project}`)
  const all = [...going.values()].reduce((sum, each) => sum + each, 0)
  return set.all !== null && all >= set.all ? `${runs(all)} on the board` : null
}

/** Checking for a place and taking it, one at a time here: two watchers at once can't both take the last place. */
let asking: Promise<unknown> = Promise.resolve()
function serial<T>(take: () => Promise<T>): Promise<T> {
  const next = asking.then(take, take)
  asking = next.catch(() => {})
  return next
}

/**
 * Asks for the `name` workflow on the message `on()` gives, unless a cap is reached: then the card says once why
 * `what` waits (`key` tells the times apart), and this returns that reason. A run that ends starts it.
 */
function request(team: Board, card: number, owner: string, name: string, what: string, key: string, on: () => Promise<number>): Promise<string | null> {
  const ask = async () => {
    const waiting = await busy(team, owner, projectOf((await team.readThread({ id: card })).message.channel))
    if (waiting !== null) {
      await note(team, card, `waiting: ${waiting}, so ${what} starts when one ends`, `wait-${name}-${key}`)
      return waiting
    }
    await team.as('intake').workflowRequest({ name, on: await on() })
    return null
  }
  return serial(ask)
}

const ENDED = new Set(['completed', 'failed', 'canceled'])

/**
 * A card's newest `card` run, from the board's record of the request: its channel, request and tasks by step.
 * Found by the request on the card's thread, never by a label, which anyone who may label could change.
 */
async function latestRun(team: Board, card: Message, owner: string, base = 'card') {
  const name = flow(base, projectOf(card.channel))
  const found = (await requestsOn(team, card.id, owner, name)).at(-1)
  if (found === undefined) return null
  const channel = `${card.channel}/${name}-${found.seq}`
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
  return { channel, request: found.seq, work: step('work'), review: step('review'), plan: step('plan'), ended: tasks.length > 0 && tasks.every((task) => ENDED.has(task.state) || stuck(task)) }
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
  const workers = loadWorkflows(workflowsPath()).find((each) => each.name === flow('card', projectOf(card.channel)))?.workers.as
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

/**
 * The trusted comments on a card not yet taken: made after `from`, the request of the run they would go to,
 * and named by no round's marker (a reply by `intake`, `round 2: taking #31, #32`). Never this module's own.
 */
function takenSince(replies: Message[], owner: string, from: number, project: string | null): Message[] {
  const taken = new Set<number>()
  for (const reply of replies) if (reply.by.principal === owner && reply.by.profile === 'intake') for (const [, id] of reply.text.matchAll(/#(\d+)/g)) taken.add(Number(id))
  return replies.filter((reply) => reply.id > from && !taken.has(reply.id) && !reply.deleted && !ours(reply.by, owner) && trusted(reply.by, owner, project))
}

/**
 * Comments for a round, each fenced as content by whoever wrote it, whole: never cut in the middle of one.
 * The oldest first, as many as fit; the rest wait for the next round, so `taken` is what the marker names.
 */
function quote(asked: Message[]): { text: string; taken: Message[] } {
  let text = ''
  const taken: Message[] = []
  for (const reply of asked) {
    const next = `${text ? '\n\n' : ''}${fenced(`Comment #${reply.id} by ${actorId(reply.by)}`, reply.text)}`
    if (taken.length > 0 && text.length + next.length > 8_000) break
    text += next
    taken.push(reply)
  }
  return { text, taken }
}

/** Whether a failure is the run's own: of a task the daemon made, by one of the workflow's workers. */
async function workersFailure(team: Board, event: { by: By; task?: { id: number } | null }, owner: string, name: string): Promise<boolean> {
  const workers = loadWorkflows(workflowsPath()).find((each) => each.name === name)?.workers.as
  if (!workers || event.by.principal !== owner || !event.by.profile?.startsWith(`${workers}-`)) return false
  return (await madeStep(team, event.task!.id, owner)) !== undefined
}

/** Runs going on from here, so one card's round never gets two workers from this process. */
const going = new Set<string>()

/** Whether a worker on the run's channel is going: started from here, or one of the run's own still waiting for work. */
const hasWorker = (channel: string) => going.has(channel) || spawnSync('pgrep', ['-f', `run --ready ${channel} --loop`], { stdio: 'ignore' }).status === 0

/**
 * A worker on a run's ready tasks, as the card workflow's own workers are: its runner, agent, repository and
 * `--push` from workflows.json, taking only that run's tasks. They stop after ten idle minutes, so a round
 * that starts later has none: this starts one, in the background, and the watcher goes on.
 */
function startWorker(run: { channel: string; request: number }, owner: string, name = 'card'): void {
  // One of the run's own workers may still be waiting for work: it takes the round, and a second would race it.
  if (hasWorker(run.channel)) return
  const workflow = loadWorkflows(workflowsPath()).find((each) => each.name === name)
  if (!workflow) throw new Error(`no ${name} workflow in workflows.json`)
  const k = workflow.workers
  const args = ['run', '--ready', run.channel, '--loop', '--wait', '2m', ...(k.runner ? ['--runner', k.runner] : ['--cwd', k.cwd!]), '--agent', k.agent, '--as', `${k.as}-round`, ...(k.repo ? ['--repo', k.repo] : []), ...(k.push || workflow.steps.some((step) => step.push === true) ? ['--push'] : []), ...(k.timeout ? ['--timeout', k.timeout] : []), ...(k.template ? ['--template', k.template] : []), ...(k.model ? ['--model', k.model] : []), '--by', `${owner}+workflows`, '--label', `workflow=${name}`, '--label', `request=${run.request}`]
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
async function nextRound(team: Board, cardId: number): Promise<boolean> {
  const owner = await ownerOf(team)
  const { message: card, replies, task } = await team.readThread({ id: cardId })
  // A card that is done (completed, or held `done`) comes back for a round as one still working does.
  // So does one left ready: reopened for a round by a watcher that stopped before it held it again.
  const done = task?.state === 'completed' || task?.state === 'ready' || (task?.state === 'blocked' && (task.hold?.kind === 'done' || waitsForRound(task.hold)))
  if (!isCardChannel(card.channel) || !(done || (task?.state === 'blocked' && task.hold?.kind === 'working'))) return false
  const run = await latestRun(team, card, owner)
  if (!run?.ended || !run.work || !run.review) return false
  // What the round that ended showed goes on the card before the next one starts, whichever watcher got here first.
  await shareScreenshots(team, card, run.work.id, owner)
  // Only what was said once the run was asked for: what came before it went into planning, or the spec.
  const project = projectOf(card.channel)
  const waiting = takenSince(replies, owner, run.request, project)
  if (waiting.length === 0) return false
  const round = run.work.rounds + 2
  const { text: quoted, taken: asked } = quote(waiting)
  const last = asked.at(-1)!.id
  const owned = asOwner(team)
  const again = async (id: number) => {
    const now = (await team.readThread({ id })).task
    if (now?.state === 'completed' || now?.state === 'failed') await owned.taskReopen({ id, round: true }).catch(() => {})
    else if (now?.state === 'blocked' && (now.hold?.kind ?? '').startsWith('push_')) await owned.taskUnblock({ id }).catch(() => {})
  }
  // Checked and sent back in one go: past a cap the round waits, and a run that ends starts it.
  const full = await serial(async () => {
    const full = await busy(team, owner, project)
    if (full !== null) return full
    await team.as('intake').reply({ to: run.work!.id, text: `Round ${round}: what was asked on card #${card.id} since the last round. Do this on top of the work on your branch.\n\n${quoted}`.slice(0, 10_000), idempotencyKey: `loop-ask-${run.work!.id}-${last}` })
    // The work first: a review reopened first would be ready before the work it reviews. Each only while it is
    // still ended, so two watchers here at once, or a retry, send it back once.
    if (done) {
      if (task!.state === 'blocked') await rehold(team, card.id, 'working', 'the card workflow is making the change')
      else {
        if (task!.state === 'completed') await owned.taskReopen({ id: card.id, round: true }).catch(() => {})
        await owned.taskBlock({ id: card.id, kind: 'working', reason: 'the card workflow is making the change' })
      }
      await setStatus(team, card.id, 'working', last)
    }
    await again(run.work!.id)
    await again(run.review!.id)
    return null
  })
  if (full !== null) {
    // Held `queued` until then, out of done: a card isn't done while there is more asked of it.
    if (!waitsForRound(task!.hold)) {
      if (task!.state === 'blocked') await rehold(team, card.id, 'queued', ROUND_WAITS)
      else {
        if (task!.state === 'completed') await owned.taskReopen({ id: card.id, round: true }).catch(() => {})
        await owned.taskBlock({ id: card.id, kind: 'queued', reason: ROUND_WAITS })
      }
    }
    await note(team, card.id, `waiting: ${full}, so round ${round} starts when one ends`, `wait-round-${last}`)
    return true
  }
  startWorker(run, owner, flow('card', project))
  // Last: the marker says these comments were taken, so a retry before it takes them again rather than losing them.
  await team.as('intake').reply({ to: card.id, text: `round ${round}: taking ${asked.map((reply) => `#${reply.id}`).join(', ')}`, idempotencyKey: `loop-round-${card.id}-${last}` })
  return true
}

/**
 * Starts what waited for a place: first a run's task answered while every place was taken, then the cards,
 * oldest first: a change or a round held `queued`, a triage not yet asked for, and a planning not yet asked
 * for or with a round waiting. Each checks for a place itself, so one that still has none waits for the next
 * run to end.
 */
async function startWaiting(team: Board): Promise<void> {
  const owner = await ownerOf(team)
  const resumed = (await team.taskList({ channel: 'cards/', state: 'blocked', limit: 1000 })).tasks
    .filter((task) => task.hold?.kind === 'queued' && task.by.principal === owner && task.by.profile === 'workflows' && runOf(task.channel) !== null)
  for (const task of resumed.sort((a, b) => a.id - b.id)) {
    // Unblocked, it is ready again, and the resume watcher gives it a worker.
    await serial(async () => {
      if ((await busy(team, owner, projectOf(task.channel))) === null) await asOwner(team).taskUnblock({ id: task.id }).catch(() => {})
    })
  }
  const waiting: { id: number; channel: string; hold: string; round: boolean }[] = []
  for (const path of (await team.channels()).channels.map((each) => each.path).filter(isCardChannel)) {
    for (const task of (await team.taskList({ channel: path, state: 'blocked', limit: 1000 })).tasks) {
      const hold = task.hold?.kind ?? ''
      if (task.channel === path && task.owner.principal === owner && task.owner.profile === 'intake' && ['queued', 'triage', 'planning'].includes(hold)) waiting.push({ id: task.id, channel: path, hold, round: waitsForRound(task.hold) })
    }
  }
  for (const card of waiting.sort((a, b) => a.id - b.id)) {
    if (card.round) await nextRound(team, card.id)
    else if (card.hold === 'queued') {
      const spec = await latestSpec(team, card.id, owner)
      if (spec !== null) await startWork(team, card.id, spec.id, owner)
    } else if (card.hold === 'triage') await askTriage(team, card.id, owner, await heldSince(team, card.id, 'triage'))
    else if ((await requestsOn(team, card.id, owner, flow('planning', projectOf(card.channel)))).length === 0) await askPlan(team, card.id, owner, 0)
    else await nextPlanRound(team, card.id)
  }
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
      if (task === null) {
        // A report from a source with a status starts where its status says: only a ready one is triaged now.
        const stage = await stageOf(team, message.id, owner)
        const parked = stage === 'ready' ? null : stage === 'planning' ? 'planning' : 'backlog'
        const hold = parked === null ? { kind: 'triage', reason: 'an agent is turning this into a spec' } : { kind: parked, reason: PARKED[parked]! }
        await team.taskCreate({ thread: message.id, hold, idempotencyKey: `loop-card-${message.id}` })
        if (stage === 'canceled') await asOwner(team).taskCancel({ id: message.id })
        if (parked === 'planning') return askPlan(team, message.id, owner, message.id)
        if (parked !== null) return
      } else if (task.state === 'blocked' && task.hold?.kind === 'planning') {
        return askPlan(team, message.id, owner, message.id)
      } else if (task.state !== 'blocked' || task.hold?.kind !== 'triage') return
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
      if (done === null || !done.result) return
      const card = await team.readThread({ id: done.thread })
      const where = card.message.channel
      if (done.workflow !== flow('triage', projectOf(where)) || card.task?.state !== 'blocked' || card.task.hold?.kind !== 'triage') return
      // Only the newest triage: one asked for before the report was last changed read text that isn't there now.
      if ((await requestsOn(team, done.thread, owner, done.workflow)).at(-1)?.seq !== done.request) return
      const links = await linksIn(team, done.result, done.thread, owner)
      // A result that names other cards and writes none: held for a person, never left as if a triage still ran.
      if (!links.spec.trim()) {
        const kind = links.duplicate === null ? 'declined' : 'duplicate'
        await rehold(team, done.thread, kind, links.duplicate === null ? 'the triage wrote no card' : `the same request as #${links.duplicate.id}`)
        await note(team, done.thread, links.duplicate === null ? 'declined: the triage wrote no card. Edit the report, or move it to ready again, to try again.' : `duplicate of #${links.duplicate.id}, with no card of its own: cancel it, or move it to ready again to triage it again.`, `nospec-${event.task!.id}`)
        notify(`card #${done.thread} ${links.duplicate === null ? 'was declined' : `looks like a duplicate of #${links.duplicate.id}`}: mu read ${done.thread}`, where)
        return
      }
      const spec = await team.reply({ to: done.thread, text: defused(links.spec), idempotencyKey: `loop-spec-${event.task!.id}` })
      if (links.related.length > 0) {
        await team.label({ id: done.thread, set: { related: links.related.map((each) => each.id).join(',') } })
        // Numbers alone: the card is mirrored where it came from, and another card's words may be private to its source.
        await note(team, done.thread, `related: ${links.related.map((each) => `#${each.id}`).join(', ')}`, `related-${event.task!.id}`)
        await relateInLinear(team, done.thread, links.related)
      }
      // The same request as another card: nothing is worked until someone trusted says to (approved=yes), or it is canceled.
      if (links.duplicate !== null) {
        await rehold(team, done.thread, 'duplicate', `the same request as #${links.duplicate.id}: label it approved=yes to work it anyway`)
        await note(team, done.thread, `duplicate of #${links.duplicate.id}: held. Label it approved=yes to work it anyway, or cancel it.`, `duplicate-${event.task!.id}`)
        notify(`card #${done.thread} looks like a duplicate of #${links.duplicate.id}: mu read ${done.thread}`, where)
        return
      }
      // Trusted only as first written: an edit since was someone's, and the board holds the card as edited then.
      if (trusted(card.message.by, owner, projectOf(where)) && card.message.revision === 1) return startWork(team, done.thread, spec.id, owner)
      await rehold(team, done.thread, 'approval', 'waiting for a trusted person to label it approved=yes')
      notify(`card #${done.thread} needs your approval: mu read ${done.thread}, then mu label ${done.thread} approved=yes`, where)
    },
  },

  // A planning run's agent answered: its questions and draft go on the card, and comments made meanwhile are the next round.
  planned: {
    tail: { channel: 'cards/', types: ['task.completed'] },
    as: 'planner',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      const done = await workflowResult(team, event.task!.id, owner)
      if (done === null || !done.result) return
      const where = (await team.readThread({ id: done.thread })).message.channel
      if (done.workflow !== flow('planning', projectOf(where))) return
      // Only the newest planning, of a card still in planning: one of text since changed, or of a card moved on, says nothing now.
      if ((await requestsOn(team, done.thread, owner, done.workflow)).at(-1)?.seq !== done.request) return
      const card = (await team.readThread({ id: done.thread })).task
      if (card?.state !== 'blocked' || card.hold?.kind !== 'planning') return
      const rounds = (await team.readThread({ id: event.task!.id })).task?.rounds ?? 0
      await team.reply({ to: done.thread, text: defused(done.result), idempotencyKey: `loop-plan-${event.task!.id}-${rounds}` })
      notify(`card #${done.thread} has a plan to read: mu read ${done.thread}`, where)
      await nextPlanRound(team, done.thread)
    },
  },

  // A card's planner stopped without an answer (out of time, a usage limit, or it failed): the card says so, and a
  // trusted reply tries again, as a round.
  'plan-stopped': {
    tail: { channel: 'cards/', types: ['task.failed'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      const run = runOf(event.task!.channel)
      if (run?.base !== 'planning' || !(await workersFailure(team, event, owner, run.name))) return
      const request = run.request
      const asked = (await team.events({ after: request - 1, filter: { types: ['workflow.requested'] }, limit: 1 })).events[0]
      if (asked?.seq !== request || asked.thread === null || asked.channel !== run.card || (asked.data as { name?: unknown }).name !== run.name || asked.by.principal !== owner || asked.by.profile !== 'intake') return
      if ((await requestsOn(team, asked.thread, owner, run.name)).at(-1)?.seq !== request) return
      const card = (await team.readThread({ id: asked.thread })).task
      if (card?.state !== 'blocked' || card.hold?.kind !== 'planning') return
      const rounds = (await team.readThread({ id: event.task!.id })).task?.rounds ?? 0
      await note(team, asked.thread, 'the planner stopped without an answer: reply on the card to try again.', `plan-stopped-${event.task!.id}-${rounds}`)
      notify(`card #${asked.thread}'s planner stopped: mu read ${asked.thread}`, run.card)
    },
  },

  // A trusted person approved a card: the change starts on the latest spec. Anyone else's label does nothing.
  approve: {
    tail: { channel: 'cards/', types: ['labels.changed'], root: true },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      const set = (event.data as { set?: Record<string, string> }).set ?? {}
      if (set.approved !== 'yes') return
      const card = await team.readThread({ id: event.thread! })
      if (!trusted(event.by, owner, projectOf(card.message.channel))) return
      if (!isCardChannel(card.message.channel) || card.task?.state !== 'blocked' || !['approval', 'duplicate'].includes(card.task.hold?.kind ?? '')) return
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
      const owner = await ownerOf(team)
      const now = (await team.readThread({ id: card.id })).task
      if (now?.state === 'blocked' && now.hold?.kind === 'edited') {
        // A parked card stays parked: it is triaged, from its new text, once it is moved to ready.
        const stage = await stageOf(team, card.id, owner)
        if (stage === 'backlog') return rehold(team, card.id, stage, PARKED[stage]!)
        // In planning, the planner starts again from the new text.
        if (stage === 'planning') return rehold(team, card.id, stage, PARKED[stage]!).then(() => askPlan(team, card.id, owner, event.seq))
        await rehold(team, card.id, 'triage', 'the report changed: an agent is turning it into a spec again')
      } else if (now?.state !== 'blocked' || now.hold?.kind !== 'triage') return
      await askTriage(team, card.id, owner, event.seq)
    },
  },

  // A card's status changed where it came from, or a trusted person set its `stage`: it moves to that stage.
  stage: {
    tail: { channel: 'cards/', types: ['labels.changed'], root: true },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const data = event.data as { set?: Record<string, string>; unset?: string[] }
      const names = [...Object.keys(data.set ?? {}), ...(data.unset ?? [])]
      if (!names.includes('state') && !names.includes('stage')) return
      // Only a change its own sync or someone trusted made: anyone else's label wakes nothing, nor writes a note.
      const made = await madeOf(team, event.thread!)
      const bySync = made?.key != null && event.by.profile === null && (event.by.principal === made.key || event.by.principal.startsWith(`${made.key}:user:`))
      if (!bySync && !trusted(event.by, await ownerOf(team), projectOf((await team.readThread({ id: event.thread! })).message.channel))) return
      await reconcile(team, event.thread!, event.seq)
    },
  },

  // The newest triage of a card failed: its agent found nothing to change here, or stopped. The card waits,
  // declined, rather than held for a triage nobody runs: its run's summary on the card says why.
  declined: {
    tail: { channel: 'cards/', types: ['task.failed'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const owner = await ownerOf(team)
      const run = runOf(event.task!.channel)
      // A failure anyone but the run's own workers wrote declines nothing.
      if (run?.base !== 'triage' || !(await workersFailure(team, event, owner, run.name))) return
      const request = run.request
      const asked = (await team.events({ after: request - 1, filter: { types: ['workflow.requested'] }, limit: 1 })).events[0]
      if (asked?.seq !== request || asked.thread === null || asked.channel !== run.card || (asked.data as { name?: unknown }).name !== run.name || asked.by.principal !== owner || asked.by.profile !== 'intake') return
      const card = asked.thread
      // Only the newest triage: one of text since changed has nothing to say about the report now.
      if ((await requestsOn(team, card, owner, run.name)).at(-1)?.seq !== request) return
      const now = (await team.readThread({ id: card })).task
      if (now?.state !== 'blocked' || now.hold?.kind !== 'triage') return
      await rehold(team, card, 'declined', 'the triage made no card: edit the report, or move it to ready again')
      await note(team, card, "declined: the triage made no card, and its summary says why. Edit the report, or move it to ready again, to try again.", `declined-${request}`)
      notify(`card #${card} was declined: mu read ${card}`, run.card)
    },
  },

  // A trusted comment on a card whose run has ended: another round on the same pull request.
  round: {
    tail: { channel: 'cards/', types: ['message.posted'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      const message = event.message!
      if (message.re === null || !isCardChannel(message.channel)) return
      if (!(await nextPlanRound(team, message.thread))) await nextRound(team, message.thread)
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
      const run0 = runOf(runTask.channel)
      if (run0?.base !== 'card' || run0.request !== request) return
      const asked = (await team.events({ after: request - 1, filter: { types: ['workflow.requested'] }, limit: 1 })).events[0]
      if (asked?.seq !== request || asked.thread === null || runTask.channel !== `${asked.channel}/${run0.name}-${request}`) return
      const card = (await team.readThread({ id: asked.thread })).message
      const run = await latestRun(team, card, owner)
      if (run?.channel !== runTask.channel || !run.ended) return
      await shareScreenshots(team, card, run.work?.id, owner)
      notify(`card #${card.id}'s change is done for now: mu read ${card.id}`, card.channel)
      // Comments that came while it ran go first: a card isn't done while there is more asked of it.
      if (await nextRound(team, card.id)) return
      const review = run.review === undefined ? null : await workflowResult(team, run.review.id, owner)
      if (review?.step === 'review' && review.request === run.request && /^approve\b/i.test((review.result ?? '').trim())) await finish(team, card.id, event.seq, run.review!)
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
      const run = runOf(task.channel)
      if (!run) return
      // Only a run this module asked for: the request it names is checked against the board's own record.
      const request = run.request
      const owner = await ownerOf(team)
      const asked = (await team.events({ after: request - 1, filter: { types: ['workflow.requested'] }, limit: 1 })).events[0]
      if (asked?.seq !== request || asked.channel !== run.card || (asked.data as { name?: unknown }).name !== run.name || asked.by.principal !== owner || asked.by.profile !== 'intake') return
      // One of the run's own workers takes it: the run never stopped going.
      if (hasWorker(task.channel)) return
      // Past a cap it waits, held `queued` (the run itself left out, as it isn't going while it waits on a
      // person). A run that ends unblocks it, and this gives it its worker then.
      const full = await serial(async () => {
        const full = await busy(team, owner, projectOf(run.card), task.channel)
        if (full !== null) await asOwner(team).taskBlock({ id: task.id, kind: 'queued', reason: `waiting: ${full}` }).catch(() => {})
        return full
      })
      if (full === null) startWorker({ channel: task.channel, request }, owner, run.name)
    },
  },

  // A task of a card's run waits for a person: you are told its ID, and nothing it says.
  'needs-me': {
    tail: { channel: 'cards/', types: ['task.blocked'], kinds: ['!triage', '!approval', '!working', '!backlog', '!planning', '!done', '!declined', '!duplicate', '!queued'] },
    run: ({ event }) => notify(`task #${event.task!.id} is blocked: mu read ${event.task!.id}`, event.task!.channel),
  },

  // A run's task ended, or waits for a person: its place is free, and the oldest card waiting for one starts.
  // Only with a maxRuns or LOOP_MAX_RUNS set: without, nothing waits.
  next: {
    tail: { channel: 'cards/', types: ['task.completed', 'task.failed', 'task.canceled', 'task.blocked'] },
    as: 'intake',
    run: async ({ event, board: team }) => {
      if (runOf(event.task!.channel) === null) return
      if (caps() !== null) await startWaiting(team)
    },
  },
} satisfies Record<string, Watch>

/**
 * Where reports come from, each into its own channel under `cards/`. Keep the ones you use, with your own IDs
 * and keys. A thread started in any of them is a report; a reply in it is a comment on the card, both ways. An
 * app posts its reports to `cards/app` with a token you make for it (see the README), and the inspector
 * posts wherever you choose.
 */
export const sync = {
  // A Slack channel, by its ID: the one people send feedback in. With the app's agent feature turned on in Slack,
  // add `agent: true` here and a thread shows "is working" while its card is worked on (Slack can't undo that).
  slack: slack({ secret: env('SLACK_SIGNING_SECRET'), token: env('SLACK_BOT_TOKEN'), channels: { C0123456789: 'cards/slack' } }),
  // A Linear team, by its key: issues filed there are reports, and the card's replies are comments on them, written
  // by an OAuth application of its own (with client credentials tokens turned on), not by a person's API key.
  // With "Agent session events" turned on for that application's webhook, add `agent: true` and
  // `appSecret: env('LINEAR_APP_WEBHOOK_SECRET')` here and an issue shows the app working while its card is worked on.
  lin: linear({ secret: env('LINEAR_WEBHOOK_SECRET'), clientId: env('LINEAR_CLIENT_ID'), clientSecret: env('LINEAR_CLIENT_SECRET'), teams: { ENG: 'cards/linear' } }),
  // GitHub issues on your repository, with the card's replies sent back as comments, written by the GitHub App
  // the workers push with (it needs write on Issues too), not by a person's token.
  gh: github({ secret: env('GITHUB_WEBHOOK_SECRET'), appId: env('GITHUB_APP_ID'), appKey: env('GITHUB_APP_KEY_FILE'), repos: { 'your-org/your-repo': { issues: 'cards/github', mirror: true } } }),
  // A Notion database, by its data source ID: its pages are reports, and the card's replies are comments on them.
  // NOTION_WEBHOOK_SECRET is `pending` until Notion has sent its verification token: see the Notion sync page.
  nt: notion({ secret: env('NOTION_WEBHOOK_SECRET'), token: env('NOTION_TOKEN'), databases: { '00000000000040008000000000000000': 'cards/notion' } }),
}

export const team = board({ sync, watch })
