import { Failure } from '../failure.ts'
import type { Board } from '../handle.ts'
import { WORKFLOWS_PROFILE } from '../model.ts'
import { fenced, noStepResults, PUSH_LABEL, STEP_LABEL } from './runs.ts'
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
 * Fills `{steps.<key>.result}` in a run's task, as the worker that took it, before its agent starts: by
 * then every step it needs has ended. The daemon made the task with the placeholder left in, and only its
 * own text can name one (`fillStep` changes `{steps.` in anything it inserts). Each result is quoted as
 * `{thread.text}` is, with `{steps.` changed in it too, so the filled text names none and a second fill
 * finds nothing. A step is known by the key the daemon labelled it with when it made it, and only among
 * the tasks this one waits for, directly or through another. The edit is made as the daemon's profile,
 * which owns the task, so the board doesn't hold it as edited. Says whether it changed the text.
 */
export async function fillResults(team: Board, id: number, owner: string): Promise<boolean> {
  const thread = await team.readThread({ id })
  const text = thread.message.text
  if (thread.task === null || thread.message.by.principal !== owner || thread.message.by.profile !== WORKFLOWS_PROFILE) return false
  if (!new RegExp(STEP_RESULT.source).test(text)) return false
  const channel = thread.message.channel
  // The steps this task waits for, by the key each was made with.
  const byKey = new Map<string, { id: number; state: string; result: string | null }>()
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
    const key = (await madeLabels(team, need, owner))?.[STEP_LABEL]
    if (key === undefined) continue
    byKey.set(key, { id: need, state: read.task.state, result: read.task.result })
    queue.push(...read.task.needs)
  }
  const filled = text.replace(new RegExp(STEP_RESULT.source, 'g'), (_whole, key: string) => resultQuote(key, byKey.get(key)))
  await team.as(WORKFLOWS_PROFILE).edit({ id, text: filled })
  return true
}

/** A step's result as `{steps.<key>.result}` puts it in a task, or a line that says there is none. */
export function resultQuote(key: string, step: { id: number; state: string; result: string | null } | undefined): string {
  const name = JSON.stringify(key)
  if (step === undefined) return `(No result from step ${name}: it isn't among the steps this task waits for.)`
  if (step.state !== 'completed') return `(No result from step ${name}, #${step.id}: it is ${step.state}.)`
  if (step.result === null || step.result.trim() === '') return `(No result from step ${name}, #${step.id}: it completed without one.)`
  return noStepResults(fenced(`The result of step ${name}, #${step.id}`, step.result))
}
