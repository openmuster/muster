import { Failure, misuse } from '../failure.ts'
import type { Caller } from '../model.ts'
import { append } from '../store/log.ts'
import { authorize, byOf, messageFor, type Context } from './context.ts'

export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const ARG_KEY = /^[a-z][a-z0-9_]{0,31}$/
export const ARGS_MAX = 10
export const ARG_VALUE_MAX = 500

export type WorkflowRequest = { name: string; on: number; args?: Record<string, string> }

function cleanArgs(args: unknown): Record<string, string> {
  if (args === undefined) return {}
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw misuse('invalid_args', 'A workflow takes its arguments as key=value pairs.')
  const entries = Object.entries(args)
  if (entries.length > ARGS_MAX) throw misuse('invalid_args', `A workflow request carries at most ${ARGS_MAX} arguments.`)
  const out: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!ARG_KEY.test(key)) throw misuse('invalid_args', `"${key}" isn't an argument name.`, 'An argument name is lowercase letters, numbers and "_", starting with a letter, up to 32.')
    if (typeof value !== 'string' || value.length > ARG_VALUE_MAX) throw misuse('invalid_args', `The value of "${key}" must be text of at most ${ARG_VALUE_MAX} characters.`)
    out[key] = value
  }
  return out
}

/**
 * Asks for a registered workflow to be run on a thread. The board keeps only the request: what the
 * workflow does is its operator's config, read by whoever runs the daemon, never stored here.
 */
export function request(ctx: Context, caller: Caller, req: WorkflowRequest): { seq: number } {
  if (typeof req.name !== 'string' || !WORKFLOW_NAME.test(req.name)) {
    throw misuse('invalid_workflow', `"${String(req.name)}" isn't a workflow name.`, 'A workflow name is lowercase letters, numbers, ".", "_" and "-".')
  }
  const args = cleanArgs(req.args)
  const message = messageFor(ctx, caller, req.on)
  if (message.deleted) throw new Failure('not_found', `No message ${req.on}.`)
  authorize(caller, message.channel, 'post')
  return ctx.db.write(() => {
    const event = append(ctx.db, { type: 'workflow.requested', by: byOf(caller), channel: message.channel, thread: message.thread, data: { name: req.name, on: req.on, args } }, ctx.now().toISOString())
    return { seq: event.seq }
  })
}
