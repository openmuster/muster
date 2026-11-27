import { Activity, Bell, Hash, ListTodo, Menu, Paperclip, Tag, UserPlus, X } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { FeedEvent, ThreadSummary } from '../../core/reads.ts'
import type { TaskListing } from '../../core/tasks.ts'
import type { By, Message } from '../../model.ts'
import type { JoinRecord } from '../../serve/joins.ts'
import { initial, openCount, reduce, TABS, tasksFor, type Tab } from './store.ts'
import { MARK_PATH } from '../mark.ts'
import { useKeys, type Binding } from './keys.ts'
import { notices, permission, show, type Permission } from './notify.ts'
import { ICON, ICON_SMALL, STYLE } from './style.ts'

/**
 * The page's token. It arrives in the link `mu inspect` printed, after the `#`: the one part of an
 * address a browser never sends anywhere. It is kept for this address alone (a port is part of it), so a
 * link to a view opens in a new tab too, and taken out of the address bar so it isn't copied with a link.
 */
const KEPT = 'muster.inspect'
function pageToken(): string | null {
  const given = /^#k=([A-Za-z0-9_-]+)$/.exec(window.location.hash)?.[1]
  if (given) {
    try {
      window.localStorage.setItem(KEPT, given)
    } catch {
      // No storage: the token lasts as long as this page does.
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    return given
  }
  try {
    return window.localStorage.getItem(KEPT)
  } catch {
    return null
  }
}
const TOKEN = pageToken()
/** What the page says when it has no token, or one from an inspector that has since stopped. */
const NO_TOKEN = 'This page needs the link mu inspect printed: open that one. A link to a view works once it has been opened here.'

/** The page's data: every read and write goes through the board's own routes, by way of the proxy. */
async function call<T>(route: string, args: unknown[] = [], as: string | null = null): Promise<T> {
  if (TOKEN === null) throw new Error(NO_TOKEN)
  const response = await fetch(`/board/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-muster-inspect': TOKEN }, body: JSON.stringify({ args, as }) })
  if (response.status === 401) throw new Error(NO_TOKEN)
  const body = (await response.json()) as { ok?: T; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.ok as T
}

const who = (by: By) => {
  const person = by.principal.slice(by.principal.lastIndexOf(':') + 1)
  return by.profile ? `${by.profile} via ${person}` : person
}
const ago = (at: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}
/** The whole date, for the tooltip on a time said as "3m". */
const when = (at: string) => new Date(at).toLocaleString()
const left = (until: string) => {
  const s = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`
}

/**
 * A link to a view: a real address, so it takes the keyboard's focus and opens in a new tab when asked
 * to. A plain click stays on this page.
 */
function Link(props: { href: string; go: (href: string) => void; on?: boolean; className?: string; title?: string; label?: string; children: ReactNode }) {
  const follow = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    props.go(props.href)
  }
  const className = [props.className, props.on ? 'on' : ''].filter(Boolean).join(' ')
  return (
    <a href={props.href} className={className || undefined} title={props.title} aria-label={props.label} aria-current={props.on ? 'page' : undefined} onClick={follow}>
      {props.children}
    </a>
  )
}

/**
 * What makes a row something to open: a click, or Enter once the keyboard has reached it (by Tab, or by
 * J and K). `key` names the row, so the keyboard can come back to it when its thread is closed.
 */
const opens = (key: string, open: () => void) => ({
  tabIndex: 0,
  'data-row': key,
  onClick: open,
  onKeyDown: (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.target === event.currentTarget) open()
  },
})

type View = { kind: 'activity' } | { kind: 'joins' } | { kind: 'tasks'; tab: Tab } | { kind: 'channel'; path: string }

function viewOf(location: Location): { view: View; thread: number | null } {
  const params = new URLSearchParams(location.search)
  const thread = Number(params.get('thread')) || null
  const path = location.pathname
  if (path.startsWith('/c/')) return { view: { kind: 'channel', path: decodeURIComponent(path.slice(3)) }, thread }
  if (path.startsWith('/activity')) return { view: { kind: 'activity' }, thread }
  if (path.startsWith('/joins')) return { view: { kind: 'joins' }, thread }
  const tab = (params.get('state') ?? 'open') as Tab
  return { view: { kind: 'tasks', tab: TABS.includes(tab) ? tab : 'open' }, thread }
}

function App() {
  const [state, dispatch] = useReducer(reduce, initial)
  const [route, setRoute] = useState(() => viewOf(window.location))
  const [me, setMe] = useState<string | null>(() => {
    try {
      return localStorage.getItem('muster.as')
    } catch {
      return null
    }
  })
  const cursor = useRef(0)
  // Notifications: who the page belongs to, whether the browser may show them, and what this tab wrote.
  const owner = useRef<string | null>(null)
  const [alerts, setAlerts] = useState<Permission>(permission)
  const alertsNow = useRef(alerts)
  alertsNow.current = alerts
  const wrote = useRef(new Set<number>())
  const { view, thread } = route
  // On a phone the sidebar is a drawer: open while this is true, and shut by going anywhere.
  const [menu, setMenu] = useState(false)

  const go = (href: string) => {
    window.history.pushState(null, '', href)
    setRoute(viewOf(window.location))
    setMenu(false)
  }
  useEffect(() => {
    const onPop = () => setRoute(viewOf(window.location))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const refresh = async () => {
    const [channels, tasks, head] = await Promise.all([call<{ channels: { path: string; threads: number }[] }>('channels'), Promise.all([call<{ tasks: TaskListing[] }>('taskList', [{ state: 'open', limit: 1000 }]), call<{ tasks: TaskListing[] }>('taskList', [{ state: 'all', latest: true, limit: 1000 }])]).then(([open, latest]) => ({ tasks: [...new Map([...open.tasks, ...latest.tasks].map((task) => [task.id, task])).values()].sort((a, b) => a.id - b.id) })), call<number>('head')])
    dispatch({ type: 'snapshot', channels: channels.channels, tasks: tasks.tasks, cursor: head })
    if (view.kind === 'channel') dispatch({ type: 'threads', channel: view.path, threads: (await call<{ threads: ThreadSummary[] }>('readChannel', [{ channel: view.path, limit: 100 }])).threads })
    if (thread) {
      const open = await call<{ message: Message; replies: Message[] }>('readThread', [{ id: thread }])
      dispatch({ type: 'thread', message: open.message, replies: open.replies })
    }
  }

  // Follow the feed: read what happened since the last look, then bring what is on screen up to date.
  useEffect(() => {
    let stopped = false
    const loop = async () => {
      try {
        // Asked until known: until then the page shows no notifications.
        owner.current ??= await call<string>('whoami').catch(() => null)
        if (cursor.current === 0) {
          const recent = await call<{ events: FeedEvent[]; cursor: number }>('events', [{ after: 0, limit: 1000 }])
          cursor.current = recent.cursor
          dispatch({ type: 'events', events: recent.events.slice(-100), cursor: recent.cursor })
          await refresh()
        } else {
          const before = cursor.current
          const page = await call<{ events: FeedEvent[]; cursor: number }>('events', [{ after: before }])
          cursor.current = page.cursor
          if (page.events.length) {
            dispatch({ type: 'events', events: page.events, cursor: page.cursor })
            // Only what is new since the page opened, read again for its owner: the board marks each mention of them.
            if (alertsNow.current === 'granted' && owner.current !== null) {
              const mine = await call<{ events: FeedEvent[] }>('events', [{ after: before, through: page.cursor, filter: { for: owner.current, types: ['message.posted'] } }])
              show(notices(mine.events, wrote.current), go)
            }
            await refresh()
          }
        }
        dispatch({ type: 'connected', connected: true })
      } catch {
        dispatch({ type: 'connected', connected: false })
      }
      if (!stopped) setTimeout(loop, 1000)
    }
    void loop()
    return () => {
      stopped = true
    }
  }, [])

  useEffect(() => {
    if (thread === null) dispatch({ type: 'close' })
    void refresh().catch((error: Error) => dispatch({ type: 'error', error: error.message }))
  }, [route.view.kind, view.kind === 'channel' ? view.path : '', thread])

  const write = async (key: string, pending: { thread: number | null; channel: string; text: string }, run: () => Promise<unknown>) => {
    dispatch({ type: 'sending', key, ...pending })
    try {
      // A post or reply answers with the message; a new task, with the task its thread is.
      const done = (await run()) as { id?: number; task?: { id: number } } | null
      // What this tab wrote never notifies it, whichever profile it wrote as.
      const id = done?.task?.id ?? done?.id
      if (id !== undefined) wrote.current.add(id)
      dispatch({ type: 'sent', key })
      await refresh()
    } catch (error) {
      dispatch({ type: 'refused', key, error: (error as Error).message })
    }
  }

  const here = (extra: string) => `${window.location.pathname}${extra}`
  const openThread = (id: number) => go(here(`?${new URLSearchParams({ ...(view.kind === 'tasks' ? { state: view.tab } : {}), thread: String(id) })}`))
  // The row a thread was opened from, by its `data-row`: Escape closes the thread and comes back to it.
  const from = useRef<string | null>(null)
  const back = useRef(false)
  const openRow = (key: string, id: number) => () => {
    from.current = key
    openThread(id)
  }
  const closeHref = here(view.kind === 'tasks' ? `?state=${view.tab}` : '')
  useEffect(() => {
    if (thread !== null || !back.current) return
    back.current = false
    if (from.current) document.querySelector<HTMLElement>(`[data-row="${CSS.escape(from.current)}"]`)?.focus()
  }, [thread])

  // The list of every key, over the page while it is open. What had the focus gets it back.
  const [keys, setKeys] = useState(false)
  const before = useRef<HTMLElement | null>(null)
  const showKeys = (show: boolean) => {
    if (show) before.current = document.activeElement as HTMLElement | null
    else before.current?.focus()
    setKeys(show)
  }
  /** J and K move down and up the rows that open, in the views that are lists to work through. */
  const move = (by: 1 | -1) => () => {
    if (keys || (view.kind !== 'tasks' && view.kind !== 'activity')) return false
    const rows = Array.from(document.querySelectorAll<HTMLElement>('main .rows [data-row]'))
    if (rows.length === 0) return false
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const on = at >= 0 ? at : rows.findIndex((row) => row.classList.contains('on'))
    rows[on < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, on + by))]!.focus()
    return true
  }
  const bindings: Binding[] = [
    { keys: ['j', 'ArrowDown'], shown: 'j ↓', does: 'next task or event', run: move(1) },
    { keys: ['k', 'ArrowUp'], shown: 'k ↑', does: 'previous task or event', run: move(-1) },
    { keys: [], shown: 'enter', does: 'open its thread' },
    {
      keys: ['Escape'],
      shown: 'esc',
      does: 'close this list, the menu, or the thread, back on its row',
      run: () => {
        if (keys) showKeys(false)
        else if (menu) setMenu(false)
        else if (thread !== null) {
          back.current = true
          go(closeHref)
        } else return false
        return true
      },
    },
    { keys: ['?'], shown: '?', does: 'show every key', run: () => (showKeys(!keys), true) },
  ]
  useKeys(bindings)

  const title = view.kind === 'tasks' ? 'tasks' : view.kind === 'activity' ? 'activity' : view.kind === 'joins' ? 'requests to join' : `#${view.path}`

  return (
    <div className={menu ? 'app menu' : 'app'}>
      <aside>
        <div className="board">
          <b><svg className="mark" width="14" height="14" viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden="true"><path fill="currentColor" d={MARK_PATH} /></svg>muster</b>
          <span>{window.location.host}</span>
        </div>
        <nav>
          <Link href="/activity" go={go} on={view.kind === 'activity'}><Activity size={ICON} /> activity</Link>
          <Link href="/" go={go} on={view.kind === 'tasks'}><ListTodo size={ICON} /> tasks <i>{openCount(state)}</i></Link>
          <h6>channels</h6>
          {state.channels.map((channel) => {
            // The last part is what tells two channels apart, so it is the part that is never cut short.
            const cut = channel.path.lastIndexOf('/') + 1
            return (
              <Link key={channel.path} href={`/c/${encodeURIComponent(channel.path)}`} go={go} on={view.kind === 'channel' && view.path === channel.path} title={channel.path}>
                <Hash size={ICON} />
                <span className="path">
                  {cut > 0 && <span className="in">{channel.path.slice(0, cut)}</span>}
                  <span className="leaf">{channel.path.slice(cut)}</span>
                </span>
              </Link>
            )
          })}
        </nav>
        <nav>
          <Link href="/joins" go={go} on={view.kind === 'joins'}><UserPlus size={ICON} /> requests to join</Link>
          {alerts === 'default' && (
            <button className="ask" onClick={() => void Notification.requestPermission().then(setAlerts, () => setAlerts(permission()))}>
              <Bell size={ICON} /> notify me of mentions
            </button>
          )}
        </nav>
        <label className="as">
          as
          <input
            value={me ?? ''}
            placeholder="yourself"
            onChange={(event) => {
              const next = event.target.value.trim() || null
              setMe(next)
              try {
                next ? localStorage.setItem('muster.as', next) : localStorage.removeItem('muster.as')
              } catch {
                // Storage is a convenience.
              }
            }}
          />
        </label>
      </aside>
      <div className="scrim" onClick={() => setMenu(false)} />
      <main>
        <header>
          <button className="icon burger" aria-label="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Menu size={ICON} /></button>
          <b>{title}</b>
          {view.kind === 'tasks' && <span>oldest first</span>}
          <em className={state.connected ? 'live' : 'down'}>{state.connected ? 'live' : 'reconnecting'}</em>
        </header>
        {state.error && (
          <p className="error banner" role="alert" onClick={() => dispatch({ type: 'error', error: null })}>
            {state.error}
          </p>
        )}
        {view.kind === 'tasks' && (
          <>
            <div className="tabs">
              {TABS.map((tab) => (
                <Link key={tab} href={`/?state=${tab}`} go={go} on={tab === view.tab}>
                  {tab}
                </Link>
              ))}
            </div>
            <div className="rows">
              {tasksFor(state, view.tab).map((task) => (
                <div key={task.id} className={`row ${task.state}${thread === task.id ? ' on' : ''}`} {...opens(`task-${task.id}`, openRow(`task-${task.id}`, task.id))}>
                  <span className="state">{task.state}</span>
                  <span className="id">#{task.id}</span>
                  <span className="text">{task.text.split('\n')[0]}</span>
                  {Object.entries(task.labels).map(([key, value]) => (
                    <code key={key} title={`${key}=${value}`}>{key}={value}</code>
                  ))}
                  <span className="grow" />
                  {task.claim && <span className="meta" title={who(task.claim.by)}>{task.claim.by.profile ?? who(task.claim.by)} · {left(task.claim.until)}</span>}
                  {task.state === 'waiting' && <span className="meta">needs {task.needs.map((id) => `#${id}`).join(' ')}</span>}
                  {task.hold && <span className="meta">{task.hold.kind}</span>}
                  <span className="meta where">#{task.channel}</span>
                  <span className="meta" title={when(task.at)}>{ago(task.at)}</span>
                </div>
              ))}
              {tasksFor(state, view.tab).length === 0 && <p className="empty">no {view.tab === 'all' ? '' : view.tab} tasks</p>}
            </div>
          </>
        )}
        {view.kind === 'channel' && (
          <div className="rows">
            {(state.threads[view.path] ?? []).map((item) => (
              <div key={item.message.id} className={thread === item.message.id ? 'thread on' : 'thread'} {...opens(`thread-${item.message.id}`, openRow(`thread-${item.message.id}`, item.message.id))}>
                <div className="by" title={when(item.message.at)}>#{item.message.id} {who(item.message.by)} · {ago(item.message.at)} {item.task && <code>{item.task.state}</code>}</div>
                <div className="text">{item.message.text}</div>
                {item.replies > 0 && <div className="meta">{item.replies} {item.replies === 1 ? 'reply' : 'replies'}</div>}
              </div>
            ))}
            {state.pending.filter((write) => write.thread === null && write.channel === view.path).map((write) => (
              <div key={write.key} className="thread pending"><div className="text">{write.text}</div></div>
            ))}
            {state.threads[view.path]?.length === 0 && !state.pending.some((write) => write.thread === null && write.channel === view.path) && <p className="empty">no messages in #{view.path} yet</p>}
          </div>
        )}
        {view.kind === 'activity' && (
          <div className="rows">
            {state.activity.map((event) => (
              <div key={event.seq} className={event.thread && thread === event.thread ? 'row event on' : 'row event'} {...(event.thread ? opens(`event-${event.seq}`, openRow(`event-${event.seq}`, event.thread)) : {})}>
                <span className="id">{event.seq}</span>
                <span className="state">{event.type}</span>
                <span className="text">{String((event.data as { text?: string; result?: string; reason?: string }).text ?? (event.data as { result?: string }).result ?? (event.data as { reason?: string }).reason ?? '').split('\n')[0]}</span>
                <span className="grow" />
                <span className="meta" title={when(event.at)}>{who(event.by)} · {ago(event.at)}</span>
              </div>
            ))}
            {state.connected && state.activity.length === 0 && <p className="empty">nothing has happened on this board yet</p>}
          </div>
        )}
        {view.kind === 'joins' && <Joins />}
        {view.kind !== 'activity' && view.kind !== 'joins' && (
          <Composer
            placeholder={view.kind === 'tasks' ? 'start a task…' : `message #${view.path}`}
            needsChannel={view.kind === 'tasks'}
            button={view.kind === 'tasks' ? 'start task' : 'send'}
            onSend={(text, channel) => {
              const target = view.kind === 'channel' ? view.path : channel
              return write(`${Date.now()}`, { thread: null, channel: target, text }, () => (view.kind === 'tasks' ? call('taskCreate', [{ channel: target, text }], me) : call('post', [{ channel: target, text }], me)))
            }}
          />
        )}
      </main>
      {state.open && (
        <section className="pane">
          <header>
            <b>#{state.open.message.id}</b>
            <span>#{state.open.message.channel}</span>
            <Link href={closeHref} go={go} className="icon" label="close"><X size={ICON} /></Link>
          </header>
          <div className="messages">
            {[state.open.message, ...state.open.replies].map((message) => (
              <article key={message.id}>
                <div className="by" title={when(message.at)}>{who(message.by)} · {ago(message.at)}</div>
                <div className="text">{message.deleted ? '(deleted)' : message.text}</div>
                {Object.keys(message.labels).length > 0 && (
                  <div className="labels"><Tag size={ICON_SMALL} /> {Object.entries(message.labels).map(([key, value]) => <code key={key} title={`${key}=${value}`}>{key}={value}</code>)}</div>
                )}
                {message.attachments.length > 0 && <div className="labels"><Paperclip size={ICON_SMALL} /> {message.attachments.map((file) => file.name).join(' ')}</div>}
              </article>
            ))}
            {state.pending.filter((write) => write.thread === state.open!.message.id).map((write) => (
              <article key={write.key} className="pending"><div className="text">{write.text}</div></article>
            ))}
          </div>
          <Composer placeholder="reply…" button="reply" onSend={(text) => write(`${Date.now()}`, { thread: state.open!.message.id, channel: state.open!.message.channel, text }, () => call('reply', [{ to: state.open!.message.id, text }], me))} />
        </section>
      )}
      {keys && (
        <>
          <div className="veil" onClick={() => showKeys(false)} />
          <section className="keys" role="dialog" aria-label="keys" tabIndex={-1} ref={(el) => el?.focus()}>
            <header>
              <b>keys</b>
              <button className="icon" aria-label="close" onClick={() => showKeys(false)}><X size={ICON} /></button>
            </header>
            <dl>
              {bindings.map((binding) => (
                <div key={binding.shown}>
                  <dt><kbd>{binding.shown}</kbd></dt>
                  <dd>{binding.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
      <style>{STYLE}</style>
    </div>
  )
}

const PERMISSIONS = ['read', 'post', 'react', 'label'] as const
const TTLS = [['1h', 3600], ['1 day', 86_400], ['7 days', 7 * 86_400]] as const

/**
 * Requests to join: what agents asked for, and the owner's answer. Asking isn't an event on the board,
 * so the list is read again every few seconds while it is open. What a token may do is chosen here;
 * the request only names who is asking.
 */
function Joins() {
  const [joins, setJoins] = useState<JoinRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    call<{ joins: JoinRecord[] }>('joinList')
      .then((answer) => (setJoins(answer.joins), setError(null)))
      .catch((failure: Error) => setError(failure.message))
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [])
  if (error) return <p className="error">{error}</p>
  if (joins === null) return null
  if (joins.length === 0) return <p className="empty">no requests. An agent asks with mu join &lt;board url&gt; --as &lt;name&gt;, on a board served with --allow-joins.</p>
  return (
    <div className="rows">
      {joins.map((join) => (
        <JoinRow key={join.code} join={join} onAnswered={() => void load()} onError={setError} />
      ))}
    </div>
  )
}

function JoinRow(props: { join: JoinRecord; onAnswered: () => void; onError: (message: string) => void }) {
  const { join } = props
  const [channel, setChannel] = useState('work/')
  const [allowed, setAllowed] = useState<string[]>(['read', 'post'])
  const [ttl, setTtl] = useState<number>(7 * 86_400)
  const answer = (route: 'joinApprove' | 'joinDeny', request: object) =>
    call(route, [{ code: join.code, ...request }])
      .then(props.onAnswered)
      .catch((failure: Error) => props.onError(failure.message))
  return (
    <div className="thread">
      <div className="by">
        <code>{join.code}</code> {join.profile} · {join.state} · until {new Date(join.expires * 1000).toLocaleTimeString()}
      </div>
      {join.note && <div className="text">{join.note}</div>}
      {join.state === 'pending' && (
        <div className="bar wrap">
          <input aria-label="channel" value={channel} onChange={(event) => setChannel(event.target.value.trim())} />
          {PERMISSIONS.map((permission) => (
            <label key={permission}>
              <input
                type="checkbox"
                checked={allowed.includes(permission)}
                onChange={(event) => setAllowed(event.target.checked ? [...allowed, permission] : allowed.filter((each) => each !== permission))}
              />{' '}
              {permission}
            </label>
          ))}
          <select aria-label="for how long" value={ttl} onChange={(event) => setTtl(Number(event.target.value))}>
            {TTLS.map(([name, seconds]) => (
              <option key={seconds} value={seconds}>{name}</option>
            ))}
          </select>
          <button disabled={!channel || allowed.length === 0} onClick={() => void answer('joinApprove', { can: { [channel]: allowed }, ttl })}>approve</button>
          <button className="quiet" onClick={() => void answer('joinDeny', {})}>deny</button>
        </div>
      )}
    </div>
  )
}

function Composer(props: { placeholder: string; button: string; needsChannel?: boolean; onSend: (text: string, channel: string) => Promise<void> }) {
  const [text, setText] = useState('')
  const [channel, setChannel] = useState('')
  const send = () => {
    const body = text.trim()
    if (!body || (props.needsChannel && !channel.trim())) return
    setText('')
    void props.onSend(body, channel.trim().replace(/^#/, ''))
  }
  return (
    <div className="composer">
      {props.needsChannel && <input value={channel} placeholder="#channel" onChange={(event) => setChannel(event.target.value)} />}
      <textarea
        value={text}
        placeholder={props.placeholder}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
      />
      <div className="bar">
        <span className="hint">enter to send · shift+enter for a new line</span>
        <button onClick={send}>{props.button}</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
