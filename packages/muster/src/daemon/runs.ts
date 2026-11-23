import { spawn } from 'node:child_process'
import type { PlanTask } from '../core/tasks.ts'
import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { actorId, channelScope, inScope, type By } from '../model.ts'
import type { Workers, Workflow } from './workflows.ts'

/** Starts one worker process. The daemon passes the real one; tests pass one that only takes notes. */
export type Spawner = (worker: { name: string; argv: string[]; cwd: string }) => void

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
 * daemon itself runs as. Started on its own and left running; one that can't start is not the daemon's crash.
 */
export const spawnWorker: Spawner = (worker) => {
  const bin = process.env.MUSTER_BIN
  const child = bin
    ? spawn(bin, worker.argv, { cwd: worker.cwd, detached: true, stdio: 'ignore' })
    : spawn(process.execPath, [process.argv[1]!, ...worker.argv], { cwd: worker.cwd, detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * A worker's command line. Built from the operator's config alone: nothing a request carries reaches it,
 * so an argument that looks like a flag is only ever text in a task.
 */
export function workerArgv(workers: Workers, run: string, i: number): string[] {
  return [
    'run', '--ready', run, '--loop', '--wait', '10m',
    ...(workers.runner === 'vercel' ? ['--runner', 'vercel'] : ['--cwd', workers.cwd ?? process.cwd()]),
    '--agent', workers.agent, '--as', `${workers.as}-${i}`,
    ...(workers.repo ? ['--repo', workers.repo] : []),
    ...(workers.push ? ['--push'] : []),
    ...(workers.timeout ? ['--timeout', workers.timeout] : []),
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
 * someone else.
 */
export function mayStart(who: string[], by: By, owner: string): boolean {
  const id = actorId(by)
  return who.some((entry) => (entry.includes(':') ? entry === id : by.principal === owner && by.profile === entry))
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

/**
 * Reads the workflow requests made since it last looked and handles each in order: a refusal on the
 * thread, or a run. A run is a labelled first message in `<channel>/<name>-<seq>`, the workflow's steps as
 * tasks there, its workers, and a reply on the thread. Every write is keyed by the request's seq, so a
 * request read twice (a restart, a tick that stopped half way) makes nothing twice, and workers are
 * started only by the tick that made the plan.
 *
 * The cursor moves past a request once it is handled. Something that isn't the board's answer, such as a
 * worker that wouldn't start, stops the pass before that request, and the next tick reads it again.
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
    // Keyed, so a request read twice is answered once. A thread that has gone since takes no answer.
    await writer.reply({ to: thread, text, idempotencyKey: `workflow-${seq}-reply`, noSync: true }).catch((error) => {
      if (!(error instanceof Failure)) throw error
    })
  }
  let reached = page.cursor
  for (const event of page.events) {
    const { name, args } = event.data as { name: string; args?: Record<string, string> }
    const channel = event.channel!
    const thread = event.thread!
    const workflow = workflows.find((each) => each.name === name)
    const refusal = !workflow
      ? `${name} isn't registered here`
      : !mayStart(workflow.who, event.by, owner)
        ? `${actorId(event.by)} may not start ${name}`
        : !runsIn(workflow.channels, channel)
          ? `${name} doesn't run in ${channel}`
          : null
    try {
      if (refusal !== null || !workflow) {
        await say(event.seq, thread, refusal!)
        out.refused.push(event.seq)
      } else {
        const started = await start(writer, workflow, event.seq, { channel, thread, by: event.by, args: args ?? {} }, deps)
        await say(event.seq, thread, started)
        out.started.push(event.seq)
      }
    } catch (error) {
      if (error instanceof Failure && refusal === null) {
        // The board's own answer, such as a run channel it won't make: the same next time, so said and passed over.
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
async function start(writer: Board, workflow: Workflow, seq: number, on: { channel: string; thread: number; by: By; args: Record<string, string> }, deps: RunDeps): Promise<string> {
  const run = `${on.channel}/${workflow.name}-${seq}`
  const labels = { workflow: workflow.name, request: String(seq) }
  await writer.post({ channel: run, text: `${workflow.name}, asked for by ${actorId(on.by)} on #${on.thread}`, labels: { ...labels, thread: String(on.thread) }, idempotencyKey: `workflow-${seq}-run`, noSync: true })
  const tasks: PlanTask[] = workflow.steps.map((step) => ({
    key: step.key,
    text: fillStep(step.text, { thread: on.thread, channel: on.channel, run, args: on.args }),
    labels: { ...step.labels, ...labels },
    ...(step.needs ? { needs: step.needs } : {}),
    ...(step.for !== undefined ? { for: step.for } : {}),
  }))
  // A replayed plan answers with the tasks it made before, so only tasks newer than now mean this tick made them.
  const before = await writer.head()
  let fresh: boolean
  try {
    const made = await writer.taskPlan({ channel: run, tasks, idempotencyKey: `workflow-${seq}` })
    fresh = made.tasks.every((task) => task.id > before)
  } catch (error) {
    // The plan was made under this key before the operator's config changed: it is made, and not made again.
    if (!(error instanceof Failure) || error.reason !== 'idempotency_mismatch') throw error
    fresh = false
  }
  if (fresh) {
    for (let i = 1; i <= workflow.workers.count; i++) {
      deps.spawn({ name: `${workflow.workers.as}-${i}`, argv: workerArgv(workflow.workers, run, i), cwd: workflow.workers.cwd ?? process.cwd() })
    }
  }
  return `started ${workflow.name}: ${tasks.length} tasks in ${run}`
}
