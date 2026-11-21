import type { Board, PlanTask } from 'muster'

export type Launch = {
  /** What the swarm is for, in the owner's words. */
  goal: string
  /** A short name for this run: its tasks live in `<swarm>/<slug>`. */
  slug: string
  /** How many workers to start. */
  agents: number
  /** `claude`, `codex`, or a command. */
  agent: string
  /** Where the agents work. */
  cwd: string
  /** Where the agents run: on this machine, or in a cloud sandbox. Default local. */
  runner?: 'local' | 'vercel' | 'cloudflare'
  /** The repository a cloud sandbox clones. */
  repo?: string
  /**
   * Lets `agent` be any command. Off unless code of yours says so: a launch that takes its fields from a
   * request, as the page does, must never start whatever command the request names.
   */
  allowCommand?: boolean
}

const KNOWN = ['claude', 'codex']
const RUNNERS = ['local', 'vercel', 'cloudflare']

export const AGENTS_MAX = 16
const SLUG = /^[a-z0-9][a-z0-9-]{0,30}$/

/** Starts one worker process. The page passes the real one; tests pass one that only takes notes. */
export type Spawner = (worker: { name: string; argv: string[]; cwd: string }) => void

/** The command line of a worker: take the run's next ready task, start the agent on it, and again, until nothing is ready for ten minutes. */
export function workerArgv(launch: Launch, swarm: string): string[] {
  if (launch.runner && launch.runner !== 'local') {
    // A sandbox is its own worker: it takes tasks from the queue itself, through the board's URL.
    return ['run', '--ready', `${swarm}/${launch.slug}`, '--runner', launch.runner, '--agent', launch.agent, ...(launch.repo ? ['--repo', launch.repo] : [])]
  }
  const agent = launch.agent === 'claude' || launch.agent === 'codex' ? ['--agent', launch.agent] : []
  const command = agent.length ? [] : ['--', ...launch.agent.split(' ').filter(Boolean)]
  return ['run', '--ready', `${swarm}/${launch.slug}`, '--loop', '--wait', '10m', '--cwd', launch.cwd, ...agent, ...command]
}

/**
 * Launches a run: a thread that records what was asked, one planning task, and the workers. The plan's
 * agent splits the goal into tasks on the board; the workers take them as they become ready.
 */
export async function launch(team: Board, swarm: string, request: Launch, spawn: Spawner): Promise<{ run: number; plan: number; workers: string[] }> {
  if (!SLUG.test(request.slug)) throw new Error('A run name is lowercase letters, numbers and "-".')
  if (!request.goal.trim()) throw new Error('Say what the swarm is for.')
  if (request.runner !== undefined && !RUNNERS.includes(request.runner)) throw new Error('A run is on this machine, or in a vercel or cloudflare sandbox.')
  if (!KNOWN.includes(request.agent) && !request.allowCommand) throw new Error('A run starts claude or codex. Another command is started only by code that passes allowCommand.')
  if (request.runner && request.runner !== 'local') {
    if (request.agent !== 'claude' && request.agent !== 'codex') throw new Error('A cloud sandbox runs claude or codex.')
    if (!process.env.MUSTER_URL) throw new Error('A cloud sandbox reaches the board by URL: start this app with MUSTER_URL and MUSTER_TOKEN set.')
    if (!process.env.MUSTER_AGENT_TOKEN) throw new Error('A cloud sandbox needs a token made for its agents: set MUSTER_AGENT_TOKEN to one held to a profile and to this swarm\'s channels (mu token create).')
  }
  if (!Number.isInteger(request.agents) || request.agents < 1 || request.agents > AGENTS_MAX) throw new Error(`A run has 1 to ${AGENTS_MAX} agents.`)
  const channel = `${swarm}/${request.slug}`
  const run = await team.post({ channel: `${swarm}/runs`, text: `run ${request.slug}: ${request.goal}`, labels: { run: request.slug, agents: String(request.agents), agent: request.agent.split(' ')[0]! }, idempotencyKey: `run-${request.slug}` })
  const tasks: PlanTask[] = [
    {
      key: 'plan',
      text: [
        `Plan the work for this goal: ${request.goal}`,
        `Split it into small tasks in ${channel}, each written for a reader with no context: what to build, which files it owns, what's out of scope, and the command that proves it's done.`,
        'No two tasks may change the same files at once; make one wait for the other with --needs.',
        `For each piece of work also create a review task that needs it. Queue them all with: mu tasks create ${channel} --file plan.json --idempotency-key ${request.slug}-plan`,
        'Complete this task with the list of task IDs you made.',
      ].join('\n'),
      labels: { role: 'plan', run: request.slug },
    },
  ]
  const made = await team.taskPlan({ channel, tasks, idempotencyKey: `plan-${request.slug}` })
  const workers: string[] = []
  for (let i = 1; i <= request.agents; i++) {
    const name = `agent-${i}`
    spawn({ name, argv: [...workerArgv(request, swarm), '--as', name], cwd: request.cwd })
    workers.push(name)
  }
  return { run: run.id, plan: made.tasks[0]!.id, workers }
}
