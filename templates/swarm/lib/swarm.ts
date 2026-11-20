import type { Board, Message, TaskListing, TaskState } from 'muster'

export const STATES: TaskState[] = ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled']

const OPEN: TaskState[] = ['waiting', 'ready', 'claimed', 'blocked']

/** The run a task belongs to: the last part of its channel (`swarm/checkout` is run `checkout`). */
export const runOf = (channel: string): string => channel.slice(channel.lastIndexOf('/') + 1)

export type Snapshot = {
  cursor: number
  /** Each run with tasks here, newest first: how many of its tasks are still open, and how many it has. */
  runs: { name: string; open: number; total: number }[]
  tasks: Record<TaskState, TaskListing[]>
  agents: { name: string; task: number; until: string }[]
  messages: Message[]
}

/**
 * What the live page shows, read fresh each time: the swarm's tasks by state, who holds what, and the
 * newest messages. Finished states are capped so a long run doesn't grow the page without end.
 */
export async function snapshot(team: Board, swarm: string): Promise<Snapshot> {
  const cursor = await team.head()
  const all = (await team.taskList({ channel: `${swarm}/`, state: 'all', limit: 1000 })).tasks
  const tasks = Object.fromEntries(STATES.map((state) => [state, [] as TaskListing[]])) as Record<TaskState, TaskListing[]>
  for (const task of all) tasks[task.state].push(task)
  for (const state of ['completed', 'failed', 'canceled'] as const) tasks[state] = tasks[state].slice(-25).reverse()
  const byRun = new Map<string, { name: string; open: number; total: number; newest: number }>()
  for (const task of all) {
    const name = runOf(task.channel)
    const run = byRun.get(name) ?? { name, open: 0, total: 0, newest: 0 }
    run.total += 1
    if (OPEN.includes(task.state)) run.open += 1
    run.newest = Math.max(run.newest, task.id)
    byRun.set(name, run)
  }
  const runs = [...byRun.values()].sort((a, b) => b.newest - a.newest).map(({ name, open, total }) => ({ name, open, total }))
  const agents = tasks.claimed.flatMap((task) => (task.claim ? [{ name: task.claim.by.profile ?? task.claim.by.principal, task: task.id, until: task.claim.until }] : []))
  const page = await team.readChannel({ channel: `${swarm}/`, limit: 30 })
  const messages = page.threads.flatMap((thread) => (thread.last ? [thread.message, thread.last] : [thread.message])).sort((a, b) => b.id - a.id).slice(0, 30)
  return { cursor, runs, tasks, agents, messages }
}
