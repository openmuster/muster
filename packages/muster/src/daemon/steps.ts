import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { WORKFLOWS_PROFILE, type BoardEvent } from '../model.ts'
import { fenced, noStepResults, PUSH_LABEL, STEP_LABEL, WORKERS_LABEL } from './runs.ts'
import { STEP_RESULT } from './workflows.ts'

/**
 * The labels a task of a run was made with, read from the board's record of its making: only when the
 * daemon made it, as `<owner>+workflows`, which only the board itself writes as. A label is anyone's to
 * change who may label in the run's channel, a steered agent's token included, so what it says now is
 * never read for what the daemon meant. Null for a task the daemon didn't make.
 */
export async function madeLabels(team: Board, id: number, owner: string): Promise<Record<string, string> | null> {
  const made = (await team.events({ after: id - 1, filter: { types: ['message.posted'] }, limit: 1 })).events[0]
  if (made === undefined || made.seq !== id || made.by.principal !== owner || made.by.profile !== WORKFLOWS_PROFILE) return null
  const labels = (made.data as { labels?: unknown }).labels
  return labels !== null && typeof labels === 'object' ? (labels as Record<string, string>) : {}
}

/**
 * Whether a worker pushes the task it took: never when it wasn't started with `--push`, and otherwise
 * unless the daemon made the task labelled `workflow.push=false`. A label set since, by anyone, counts for nothing.
 */
export async function pushesTask(team: Board, id: number, owner: string, push: boolean): Promise<boolean> {
  if (!push) return false
  return (await madeLabels(team, id, owner))?.[PUSH_LABEL] !== 'false'
}

/**
 * Whether a step's latest completion is its workers' own: completed by one of the run's workers
 * (`<workers.as>-…`, under the owner's principal), under a claim that worker made from the daemon's machine,
 * not one made by a token held to channels. Every agent of the run holds such a token, and the run's tasks
 * are in its channel, so without this one step's agent could claim and complete another step with
 * whatever it liked, and have it quoted under the daemon's header.
 */
async function workersResult(team: Board, id: number, owner: string, workers: string | undefined): Promise<boolean> {
  if (workers === undefined) return false
  const seen: BoardEvent[] = []
  let after = id - 1
  for (;;) {
    const page = await team.events({ after, filter: { re: id, types: ['task.claimed', 'task.completed'] }, limit: 500 })
    seen.push(...page.events)
    if (page.events.length < 500 || page.cursor <= after) break
    after = page.cursor
  }
  const done = seen.findLastIndex((event) => event.type === 'task.completed')
  if (done === -1) return false
  const completed = seen[done]!
  const claimed = seen.slice(0, done).findLast((event) => event.type === 'task.claimed')
  const worker = (by: BoardEvent['by']) => by.principal === owner && by.profile !== null && by.profile.startsWith(`${workers}-`)
  return claimed !== undefined && worker(completed.by) && claimed.by.profile === completed.by.profile && worker(claimed.by) && (claimed.data as { narrowed?: unknown }).narrowed !== true
}

/**
 * A workflow step's result, for code that goes on from it (a board module's watcher, say): only when the
 * daemon made the task, as `<owner>+workflows`, and the run's own worker completed it, as a step's result is
 * checked before it is quoted into the next step. With it, the run it belongs to: the workflow and step as
 * the daemon made them, and the thread and message the run was asked on, from the board's record of the
 * request. Null for anything else: a task someone else made, one an agent completed with its sandbox's
 * token, one not completed. Labels count for nothing here, so a relabelled task is read as it was made.
 */
export async function workflowResult(team: Board, id: number, owner: string): Promise<{ workflow: string; step: string; request: number; thread: number; on: number; result: string | null } | null> {
  const made = await madeLabels(team, id, owner)
  const workflow = made?.workflow
  const step = made?.[STEP_LABEL]
  const request = Number(made?.request)
  if (workflow === undefined || step === undefined || !Number.isSafeInteger(request) || request < 1) return null
  const read = await team.readThread({ id }).catch(() => null)
  if (read?.task?.state !== 'completed') return null
  if (!(await workersResult(team, id, owner, made?.[WORKERS_LABEL]))) return null
  const asked = (await team.events({ after: request - 1, filter: { types: ['workflow.requested'] }, limit: 1 })).events[0]
  if (asked === undefined || asked.seq !== request || asked.thread === null || (asked.data as { name?: unknown }).name !== workflow) return null
  // A run is made in `<channel>/<workflow>-<request>`, under the channel it was asked in: anything else isn't this request's run.
  if (read.message.channel !== `${asked.channel}/${workflow}-${request}`) return null
  const on = (asked.data as { on?: unknown }).on
  return { workflow, step, request, thread: asked.thread, on: typeof on === 'number' ? on : asked.thread, result: read.task.result }
}

/** Why a task's results can't be filled in. `edited`: its text isn't the daemon's any more; `writer`: this caller can't write as the daemon. */
export class FillRefused extends Failure {
  readonly why: 'edited' | 'writer'
  constructor(why: 'edited' | 'writer', message: string) {
    super('fill_refused', message)
    this.why = why
  }
}

/**
 * Fills `{steps.<key>.result}` in a run's task, as the worker that took it, before its agent starts: by
 * then every step it needs has ended. The daemon made the task with the placeholder left in, and only its
 * own text can name one (`fillStep` changes every other `{steps.`). Each result is quoted as
 * `{thread.text}` is, with `{steps.` changed in it too, so the filled text names none and a second fill
 * finds nothing. A step is known by the key the daemon labelled it with when it made it, and only among
 * the tasks this one waits for, directly or through another, in the same channel; its result counts only
 * when the run's own worker completed it.
 *
 * The edit is made as the daemon's profile, which owns the task, so the board doesn't hold it as edited,
 * and only on the text the daemon wrote: a task edited since is refused (`FillRefused` `edited`), so text
 * someone else put there is never saved again under the daemon's name. A caller that can't write as the
 * daemon (a token held to a profile, which the board would quietly write as instead) is refused too
 * (`writer`). Says whether it filled anything.
 */
export async function fillResults(team: Board, id: number, owner: string): Promise<'filled' | 'none'> {
  const thread = await team.readThread({ id })
  const text = thread.message.text
  if (thread.task === null || thread.message.by.principal !== owner || thread.message.by.profile !== WORKFLOWS_PROFILE) return 'none'
  if (!new RegExp(STEP_RESULT.source).test(text)) return 'none'
  // Only once every step it needs has ended: a task still waiting is filled when it is taken.
  if (thread.task.state !== 'ready' && thread.task.state !== 'claimed') return 'none'
  if (thread.message.revision !== MADE) throw new FillRefused('edited', `#${id}'s text was changed after the daemon made it, so its steps' results aren't filled in: read it before it goes on.`)
  const writer = team.as(WORKFLOWS_PROFILE)
  const me = await writer.whoami()
  if (me.principal !== owner || me.profile !== WORKFLOWS_PROFILE) throw new FillRefused('writer', `Only a workflow's worker, on the daemon's machine, fills in #${id}'s steps' results.`)
  const channel = thread.message.channel
  // The steps this task waits for, by the key each was made with.
  const byKey = new Map<string, Step>()
  const seen = new Set<number>()
  const queue = [...thread.task.needs]
  while (queue.length > 0) {
    const need = queue.shift()!
    if (seen.has(need)) continue
    seen.add(need)
    const read = await team.readThread({ id: need }).catch((error) => {
      if (error instanceof Failure && error.reason === 'not_found') return null
      throw error
    })
    if (read === null || read.task === null || read.message.channel !== channel) continue
    const made = await madeLabels(team, need, owner)
    const key = made?.[STEP_LABEL]
    if (key === undefined) continue
    const ours = read.task.state === 'completed' && (await workersResult(team, need, owner, made?.[WORKERS_LABEL]))
    byKey.set(key, { id: need, state: read.task.state, result: read.task.result, ours })
    queue.push(...read.task.needs)
  }
  const filled = text.replace(new RegExp(STEP_RESULT.source, 'g'), (_whole, key: string) => resultQuote(key, byKey.get(key)))
  const edited = await writer.edit({ id, text: filled, ifRevision: MADE })
  if (edited.by.principal !== owner || edited.by.profile !== WORKFLOWS_PROFILE) throw new FillRefused('writer', `#${id} was written as ${edited.by.profile ?? 'no profile'}, not as the daemon.`)
  return 'filled'
}

/** A message's revision as it was written, before any edit. */
const MADE = 1

type Step = { id: number; state: string; result: string | null; ours: boolean }

/** A step's result as `{steps.<key>.result}` puts it in a task, or a line that says there is none. */
export function resultQuote(key: string, step: Step | undefined): string {
  const name = JSON.stringify(key)
  if (step === undefined) return `(No result from step ${name}: it isn't among the steps this task waits for.)`
  if (step.state !== 'completed') return `(No result from step ${name}, #${step.id}: it is ${step.state}.)`
  if (!step.ours) return `(No result from step ${name}, #${step.id}: it wasn't completed by one of the run's workers.)`
  if (step.result === null || step.result.trim() === '') return `(No result from step ${name}, #${step.id}: it completed without one.)`
  return noStepResults(fenced(`The result of step ${name}, #${step.id}`, step.result))
}
