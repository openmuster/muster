import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { duration } from '../cli/args.ts'
import { configDir } from '../cli/claims.ts'
import { Failure } from '../failure.ts'
import { githubRepo } from '../runner/github.ts'

export type WorkflowStep = { key: string; text: string; needs?: string[]; for?: string; labels?: Record<string, string>; push?: boolean; title?: string }
export type Workers = { count: number; agent: 'claude' | 'codex'; as: string; runner?: 'local' | 'vercel' | 'cloudflare' | 'e2b'; repo?: string; push?: boolean; cwd?: string; timeout?: string; template?: string; model?: string }
export type Workflow = { name: string; description: string; who: string[]; channels: string[]; steps: WorkflowStep[]; workers: Workers; timeout?: string }

export const workflowsPath = () => join(configDir(), 'workflows.json')

const MAX_STEPS = 20

/**
 * `{steps.<key>.result}` in a step's text: that earlier step's result, quoted into the task once it is
 * ready. Anything that starts `{steps.` is read as one, so a misspelt one is refused, not left as written.
 */
export const STEP_RESULT = /\{steps\.([^{}]*?)\.result\}/g
const STEP_ANY = /\{steps\.[^{}]*\}/g

/** Whether a workflow pushes from any task: its workers' `push`, or a step's own. */
export const pushes = (workflow: Pick<Workflow, 'workers' | 'steps'>): boolean => workflow.steps.some((step) => step.push ?? workflow.workers.push === true)

/**
 * The first step whose text names a result it can't have: a step it doesn't wait for, directly or through
 * the steps it waits for. Only those have ended by the time it is ready. Null when every one is in reach.
 */
function unreachableResult(steps: WorkflowStep[]): string | null {
  const before = new Map<string, Set<string>>()
  for (const step of steps) {
    const reach = new Set<string>()
    for (const need of step.needs ?? []) {
      reach.add(need)
      for (const further of before.get(need) ?? []) reach.add(further)
    }
    before.set(step.key, reach)
    for (const [whole] of step.text.matchAll(STEP_ANY)) {
      const key = /^\{steps\.(.*)\.result\}$/.exec(whole)?.[1]
      if (key === undefined) return `has a step "${step.key}" with ${whole}, which isn't {steps.<key>.result}.`
      if (!reach.has(key)) return `has a step "${step.key}" that quotes the result of "${key}", which isn't a step it needs, directly or through another.`
    }
  }
  return null
}
const MAX_WORKERS = 16
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item !== '')

/**
 * The operator's registered workflows: named plans of steps for a crew of workers. Like watchers and
 * hooks they come from this file and never from a board, so nothing written to one can register one.
 * A file that is missing means none; one that is wrong is a config error.
 */
export function loadWorkflows(path = workflowsPath()): Workflow[] {
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Failure('invalid_config', `${path} isn't JSON: ${(error as Error).message}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { workflows?: unknown } | null)?.workflows
  if (!Array.isArray(list)) throw new Failure('invalid_config', `${path} needs a "workflows" array.`)
  const names = new Set<string>()
  return list.map((entry: unknown, index) => {
    const name = isObject(entry) ? entry.name : undefined
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(name)) throw new Failure('invalid_config', `Workflow ${index + 1} in ${path} needs a "name" of lowercase letters, numbers, ".", "_" and "-".`)
    if (names.has(name)) throw new Failure('invalid_config', `Two workflows in ${path} are named "${name}".`)
    names.add(name)
    const fail = (message: string): never => {
      throw new Failure('invalid_config', `Workflow "${name}" in ${path} ${message}`)
    }
    const entryObject = entry as Record<string, unknown>
    const checkDuration = (value: unknown, field: string) => {
      if (typeof value !== 'string') return fail(`has a "${field}" that isn't a duration like 30m.`)
      try {
        duration(value, field)
      } catch {
        fail(`has a "${field}" that isn't a duration like 30m.`)
      }
    }
    if (typeof entryObject.description !== 'string') fail('needs a "description".')
    if (!strings(entryObject.who)) fail('needs "who": the people allowed to start it, as a non-empty array of names.')
    if (!strings(entryObject.channels)) fail('needs "channels": where it may be started, as a non-empty array of channels.')
    if (!Array.isArray(entryObject.steps) || entryObject.steps.length < 1 || entryObject.steps.length > MAX_STEPS) fail(`needs 1 to ${MAX_STEPS} "steps".`)
    const seen = new Set<string>()
    const steps = (entryObject.steps as unknown[]).map((raw, at): WorkflowStep => {
      if (!isObject(raw) || typeof raw.key !== 'string' || raw.key === '') return fail(`has a step ${at + 1} with no "key".`)
      const key = raw.key
      if (seen.has(key)) fail(`has two steps with the key "${key}".`)
      if (typeof raw.text !== 'string' || raw.text === '') fail(`has a step "${key}" with no "text".`)
      if (raw.needs !== undefined && (!Array.isArray(raw.needs) || !raw.needs.every((need) => typeof need === 'string'))) fail(`has a step "${key}" whose "needs" isn't an array of keys.`)
      for (const need of (raw.needs ?? []) as string[]) if (!seen.has(need)) fail(`has a step "${key}" that needs "${need}", which isn't an earlier step.`)
      if (raw.for !== undefined && typeof raw.for !== 'string') fail(`has a step "${key}" whose "for" isn't a string.`)
      if (raw.labels !== undefined && (!isObject(raw.labels) || !Object.values(raw.labels).every((label) => typeof label === 'string'))) fail(`has a step "${key}" whose "labels" aren't k:v strings.`)
      if (raw.push !== undefined && typeof raw.push !== 'boolean') fail(`has a step "${key}" whose "push" isn't true or false.`)
      if (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 200)) fail(`has a step "${key}" whose "title" isn't text of at most 200 characters.`)
      seen.add(key)
      return { key, text: raw.text as string, ...(raw.needs !== undefined ? { needs: raw.needs as string[] } : {}), ...(raw.for !== undefined ? { for: raw.for as string } : {}), ...(raw.labels !== undefined ? { labels: raw.labels as Record<string, string> } : {}), ...(raw.push !== undefined ? { push: raw.push as boolean } : {}), ...(raw.title !== undefined ? { title: raw.title as string } : {}) }
    })
    const refused = unreachableResult(steps)
    if (refused) fail(refused)
    const w = entryObject.workers
    if (!isObject(w)) return fail('needs "workers".')
    if (!Number.isInteger(w.count) || (w.count as number) < 1 || (w.count as number) > MAX_WORKERS) fail(`needs "workers.count" from 1 to ${MAX_WORKERS}.`)
    if (w.agent !== 'claude' && w.agent !== 'codex') fail('needs "workers.agent": "claude" or "codex".')
    if (typeof w.as !== 'string' || w.as === '') fail('needs "workers.as": the name the workers act as.')
    if (w.runner !== undefined && w.runner !== 'local' && w.runner !== 'vercel' && w.runner !== 'cloudflare' && w.runner !== 'e2b') fail('needs a "workers.runner" of "local", "vercel", "cloudflare" or "e2b".')
    if (w.repo !== undefined && typeof w.repo !== 'string') fail('has a "workers.repo" that isn\'t a string.')
    if (w.cwd !== undefined && typeof w.cwd !== 'string') fail('has a "workers.cwd" that isn\'t a string.')
    // A worker on this machine works in a folder the operator names: never wherever the daemon happened to start.
    const cloud = w.runner === 'vercel' || w.runner === 'cloudflare' || w.runner === 'e2b'
    if (!cloud && (typeof w.cwd !== 'string' || w.cwd === '')) fail('needs "workers.cwd": the folder its workers run in on this machine.')
    if (w.push !== undefined && typeof w.push !== 'boolean') fail('has a "workers.push" that isn\'t true or false.')
    if ((w.push === true || steps.some((step) => step.push === true)) && !(cloud && typeof w.repo === 'string' && githubRepo(w.repo))) fail('can only "push" with "runner": "vercel", "cloudflare" or "e2b" and a github.com https "repo".')
    if (w.timeout !== undefined) checkDuration(w.timeout, 'workers.timeout')
    // Each a word for mu run's own flag (--template, --model), never a path: a worker's command line takes it as one argument.
    if (w.template !== undefined && (typeof w.template !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(w.template))) fail('has a "workers.template" that isn\'t an E2B template name.')
    if (w.template !== undefined && w.runner !== 'e2b') fail('has a "workers.template", which is for "e2b" workers: no other runner makes a sandbox from a template you name.')
    if (w.model !== undefined && (typeof w.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(w.model))) fail('has a "workers.model" that isn\'t a model name.')
    if (entryObject.timeout !== undefined) checkDuration(entryObject.timeout, 'timeout')
    const workers: Workers = { count: w.count as number, agent: w.agent as Workers['agent'], as: w.as as string, ...(w.runner !== undefined ? { runner: w.runner as Workers['runner'] } : {}), ...(w.repo !== undefined ? { repo: w.repo as string } : {}), ...(w.push !== undefined ? { push: w.push as boolean } : {}), ...(w.cwd !== undefined ? { cwd: w.cwd as string } : {}), ...(w.timeout !== undefined ? { timeout: w.timeout as string } : {}), ...(w.template !== undefined ? { template: w.template as string } : {}), ...(w.model !== undefined ? { model: w.model as string } : {}) }
    return { name, description: entryObject.description as string, who: entryObject.who as string[], channels: entryObject.channels as string[], steps, workers, ...(entryObject.timeout !== undefined ? { timeout: entryObject.timeout as string } : {}) }
  })
}
