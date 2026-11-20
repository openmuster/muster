import type { FeedEvent, ThreadSummary } from '../../core/reads.ts'
import type { TaskListing, TaskState } from '../../core/tasks.ts'
import type { Message } from '../../model.ts'

/** What the page shows. Pure: every change is a function from one state to the next. */
export type State = {
  cursor: number
  connected: boolean
  channels: { path: string; threads: number }[]
  tasks: TaskListing[]
  threads: Record<string, ThreadSummary[]>
  open: { message: Message; replies: Message[] } | null
  activity: FeedEvent[]
  /** Your own writes, shown at once and dropped when the board confirms or refuses them. */
  pending: { key: string; thread: number | null; channel: string; text: string }[]
  error: string | null
}

export const initial: State = { cursor: 0, connected: false, channels: [], tasks: [], threads: {}, open: null, activity: [], pending: [], error: null }

export const TABS = ['open', 'waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled', 'all'] as const
export type Tab = (typeof TABS)[number]

const OPEN: readonly TaskState[] = ['waiting', 'ready', 'claimed', 'blocked']

export const tasksFor = (state: State, tab: Tab): TaskListing[] => state.tasks.filter((task) => (tab === 'all' ? true : tab === 'open' ? OPEN.includes(task.state) : task.state === tab))

export const openCount = (state: State) => tasksFor(state, 'open').length

/** A message never replaces a newer revision of itself: an answer that arrives late doesn't undo a later one. */
export const newer = (have: Message | undefined, next: Message) => !have || next.revision >= have.revision

export type Action =
  | { type: 'snapshot'; channels: State['channels']; tasks: TaskListing[]; cursor: number }
  | { type: 'threads'; channel: string; threads: ThreadSummary[] }
  | { type: 'thread'; message: Message; replies: Message[] }
  | { type: 'close' }
  | { type: 'events'; events: FeedEvent[]; cursor: number }
  | { type: 'connected'; connected: boolean }
  | { type: 'sending'; key: string; thread: number | null; channel: string; text: string }
  | { type: 'sent'; key: string }
  | { type: 'refused'; key: string; error: string }
  | { type: 'error'; error: string | null }

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot':
      // An older snapshot never replaces a newer one.
      if (action.cursor < state.cursor) return state
      return { ...state, channels: action.channels, tasks: action.tasks, cursor: action.cursor, connected: true }
    case 'threads':
      return { ...state, threads: { ...state.threads, [action.channel]: action.threads } }
    case 'thread': {
      if (state.open && state.open.message.id === action.message.id && !newer(state.open.message, action.message)) return state
      return { ...state, open: { message: action.message, replies: action.replies } }
    }
    case 'close':
      return { ...state, open: null }
    case 'events': {
      if (action.cursor <= state.cursor && action.events.length === 0) return state
      const seen = new Set(state.activity.map((event) => event.seq))
      const fresh = action.events.filter((event) => !seen.has(event.seq))
      return { ...state, cursor: Math.max(state.cursor, action.cursor), activity: [...fresh.reverse(), ...state.activity].slice(0, 200) }
    }
    case 'connected':
      return { ...state, connected: action.connected }
    case 'sending':
      return { ...state, pending: [...state.pending, { key: action.key, thread: action.thread, channel: action.channel, text: action.text }], error: null }
    case 'sent':
      return { ...state, pending: state.pending.filter((write) => write.key !== action.key) }
    case 'refused':
      return { ...state, pending: state.pending.filter((write) => write.key !== action.key), error: action.error }
    case 'error':
      return { ...state, error: action.error }
  }
}
