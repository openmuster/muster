import type { Board, Message, TaskListing, TaskState } from 'muster'

export const STATES: TaskState[] = ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled']

export type Snapshot = {
  cursor: number
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
  const agents = tasks.claimed.flatMap((task) => (task.claim ? [{ name: task.claim.by.profile ?? task.claim.by.principal, task: task.id, until: task.claim.until }] : []))
  const page = await team.readChannel({ channel: `${swarm}/`, limit: 30 })
  const messages = page.threads.flatMap((thread) => (thread.last ? [thread.message, thread.last] : [thread.message])).sort((a, b) => b.id - a.id).slice(0, 30)
  return { cursor, tasks, agents, messages }
}
