import { spawn } from 'node:child_process'
import type { PlanTask } from '../core/tasks.ts'
import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { actorId, channelScope, inScope, type By } from '../model.ts'
import type { Workflow } from './workflows.ts'

/**
 * Starts one worker process, and settles once it has started or couldn't. The daemon passes the real one;
 * tests pass one that only takes notes. A worker with no `cwd` (a Vercel worker) starts where the daemon runs.
 */
export type Spawner = (worker: { name: string; argv: string[]; cwd?: string }) => void | Promise<void>

export type RunDeps = { spawn: Spawner; now: () => number }

export type Ran = { started: number[]; refused: number[]; why?: string }

/** Where the daemon keeps its place among the board's workflow requests. */
export const REQUESTS_CURSOR = 'workflow:requests'
/** The profile the daemon writes a run as, so watchers and hooks can tell its writing from a person's. */
export const WORKFLOWS_PROFILE = 'workflows'
/** Requests one tick handles, so a burst of them never holds up schedules and watchers. */
const BATCH = 20

/**
 * A worker as `mu` on this machine: `MUSTER_BIN` when it is set, or else the same node and CLI the
 * daemon itself runs as. It is left running on its own. One that can't start (no such program, no such
 * folder) rejects, so the daemon says so instead of announcing workers that never ran.
 */
export const spawnWorker: Spawner = (worker) =>
  new Promise<void>((resolve, reject) => {
    const bin = process.env.MUSTER_BIN
    const options = { ...(worker.cwd !== undefined ? { cwd: worker.cwd } : {}), detached: true, stdio: 'ignore' as const }
    const child = bin ? spawn(bin, worker.argv, options) : spawn(process.execPath, [process.argv[1]!, ...worker.argv], options)
    child.once('spawn', () => {
      // Started: what it does from here is its own, and no later error of its may end the daemon.
      child.on('error', () => {})
      child.unref()
      resolve()
    })
    child.once('error', (error) => reject(error))
  })

/**
 * A worker's command line. Built from the operator's config and the request's seq alone: nothing a
 * request carries reaches it, so an argument that looks like a flag is only ever text in a task. The
 * labels hold it to its own run's tasks.
 */
export function workerArgv(workflow: Workflow, run: string, seq: number, i: number): string[] {
  const workers = workflow.workers
  return [
    'run', '--ready', run, '--loop', '--wait', '10m',
    ...(workers.runner === 'vercel' ? ['--runner', 'vercel'] : ['--cwd', workers.cwd!]),
    '--agent', workers.agent, '--as', `${workers.as}-${i}`,
    ...(workers.repo ? ['--repo', workers.repo] : []),
    ...(workers.push ? ['--push'] : []),
    ...(workers.timeout ? ['--timeout', workers.timeout] : []),
    '--label', `workflow=${workflow.name}`, '--label', `request=${seq}`,
  ]
}

/**
 * Fills a step's text, in one pass, by plain replacement: `{thread}`, `{channel}`, `{run}` and
 * `{args.<k>}`. A placeholder it doesn't know, or an argument nobody gave, is left as written, and what
 * a value says is never read again as a placeholder.
 */
export function fillStep(text: string, values: { thread: number; channel: string; run: string; args: Record<string, string> }): string {
  return text.replace(/\{(thread|channel|run|args\.([a-z][a-z0-9_]*))\}/g, (whole, name: string, arg: string | undefined) => {
    if (arg !== undefined) return Object.hasOwn(values.args, arg) ? values.args[arg]! : whole
    return name === 'thread' ? String(values.thread) : name === 'channel' ? values.channel : values.run
  })
}

/**
 * Whether a verified author is one `who` names. An entry with a `:` is a whole actor ID. A bare name is a
 * profile, and only under the principal of whoever runs this daemon: someone else's agent of that name is
 * someone else. A match that rests on a profile counts only when the board says the profile was held by
 * the caller's token (or the caller was the board itself), not named by the request.
 */
export function mayStart(who: string[], by: By, owner: string, profileHeld: boolean): boolean {
  const id = actorId(by)
  return who.some((entry) => {
    if (entry.includes(':')) return entry === id && (by.profile === null || profileHeld)
    return profileHeld && by.principal === owner && by.profile === entry
  })
}

/** Whether a channel is one of a workflow's: exactly, or under an entry that ends in `/`, as `tail --channel` reads them. */
export function runsIn(channels: string[], channel: string): boolean {
  return channels.some((entry) => {
    try {
      return inScope(channel, channelScope(entry))
    } catch {
      return false
    }
  })
}

type Request = { seq: number; channel: string; thread: number; by: By; args: Record<string, string> }

/**
 * Reads the workflow requests made since it last looked and handles each in order: a refusal on the
 * thread, or a run. A run is the workflow's steps as tasks in `<channel>/<name>-<seq>`, its workers, a
 * labelled first message there once they have started, and a reply on the thread. Every write is keyed
 * by the request's seq, so a request read twice (a restart, a tick that stopped half way) makes nothing
 * twice; the first message is the mark that the workers were started, so they are started once.
 *
 * The cursor moves past a request once it is answered. Something that isn't the board's answer stops the
 * pass before that request, and the next tick reads it again.
 */
export async function runWorkflows(team: Board, workflows: Workflow[], deps: RunDeps): Promise<Ran> {
  const out: Ran = { started: [], refused: [] }
  let cursor = await team.cursorGet(REQUESTS_CURSOR)
  if (cursor === null) {
    // A daemon new to a board starts from now: it never starts what was asked before it ran.
    cursor = await team.head()
    await team.cursorSet(REQUESTS_CURSOR, cursor)
  }
  const page = await team.events({ after: cursor, filter: { types: ['workflow.requested'] }, limit: BATCH })
  const owner = (await team.whoami()).principal
  const writer = team.as(WORKFLOWS_PROFILE)
  const say = async (seq: number, thread: number, text: string) => {
    // Keyed, so a request read twice is answered once, and synced like any reply: whoever asked may be
    // on a platform. A thread that has gone since takes no answer.
    await writer.reply({ to: thread, text, idempotencyKey: `workflow-${seq}-reply` }).catch((error) => {
      if (!(error instanceof Failure)) throw error
    })
  }
  let reached = page.cursor
  for (const event of page.events) {
    const { name, args, profileHeld } = event.data as { name: string; args?: Record<string, string>; profileHeld?: boolean }
    const channel = event.channel!
    const thread = event.thread!
    const workflow = workflows.find((each) => each.name === name)
    const refusal = !workflow
      ? `${name} isn't registered here`
      : !mayStart(workflow.who, event.by, owner, profileHeld === true)
        ? `${actorId(event.by)} may not start ${name}`
        : !runsIn(workflow.channels, channel)
          ? `${name} doesn't run in ${channel}`
          : null
    try {
      if (refusal !== null || !workflow) {
        await say(event.seq, thread, refusal!)
        out.refused.push(event.seq)
      } else {
        const result = await start(team, writer, workflow, { seq: event.seq, channel, thread, by: event.by, args: args ?? {} }, owner, deps)
        await say(event.seq, thread, result.text)
        if (result.failed === undefined) out.started.push(event.seq)
        else {
          out.refused.push(event.seq)
          out.why = `${name} ${event.seq}: ${result.failed}`
        }
      }
    } catch (error) {
      if (error instanceof Failure && refusal === null) {
        // The board's own answer, such as a task text too long to post: the same next time, so said and passed over.
        await say(event.seq, thread, `couldn't start ${name}: ${error.message}`)
        out.refused.push(event.seq)
      } else {
        out.why = (error as Error).message
        reached = event.seq - 1
        break
      }
    }
    await team.cursorSet(REQUESTS_CURSOR, event.seq)
  }
  if (reached > cursor) await team.cursorSet(REQUESTS_CURSOR, reached)
  return out
}

/** Makes one run, and says what to answer on the thread. */
async function start(team: Board, writer: Board, workflow: Workflow, on: Request, owner: string, deps: RunDeps): Promise<{ text: string; failed?: string }> {
  const run = `${on.channel}/${workflow.name}-${on.seq}`
  const labels = { workflow: workflow.name, request: String(on.seq) }
  const tasks: PlanTask[] = workflow.steps.map((step) => ({
    key: step.key,
    text: fillStep(step.text, { thread: on.thread, channel: on.channel, run, args: on.args }),
    labels: { ...step.labels, ...labels },
    ...(step.needs ? { needs: step.needs } : {}),
    ...(step.for !== undefined ? { for: step.for } : {}),
  }))
  try {
    // One write: a plan the board refuses leaves nothing behind.
    await writer.taskPlan({ channel: run, tasks, idempotencyKey: `workflow-${on.seq}` })
  } catch (error) {
    // The plan was made under this key before the operator's config changed: it is made, and not made again.
    if (!(error instanceof Failure) || error.reason !== 'idempotency_mismatch') throw error
  }
  // The run's first message is written once its workers have started: with it there, they were.
  const opened = (await team.readChannel({ channel: run, labels: [`request=${on.seq}`] })).threads.some(
    (each) => each.task === null && each.message.by.principal === owner && each.message.by.profile === WORKFLOWS_PROFILE,
  )
  if (!opened) {
    for (let i = 1; i <= workflow.workers.count; i++) {
      try {
        await deps.spawn({ name: `${workflow.workers.as}-${i}`, argv: workerArgv(workflow, run, on.seq, i), ...(workflow.workers.cwd !== undefined ? { cwd: workflow.workers.cwd } : {}) })
      } catch (error) {
        const reason = (error as Error).message
        return { text: `couldn't start workers for ${workflow.name}: ${reason}`, failed: reason }
      }
    }
    await writer.post({ channel: run, text: `${workflow.name}, asked for by ${actorId(on.by)} on #${on.thread}`, labels: { ...labels, thread: String(on.thread) }, idempotencyKey: `workflow-${on.seq}-run`, noSync: true })
  }
  return { text: `started ${workflow.name}: ${tasks.length} tasks in ${run}` }
}
