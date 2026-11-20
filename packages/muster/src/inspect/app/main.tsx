import { Activity, Hash, ListTodo, Paperclip, Tag, X } from 'lucide-react'
import { useEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FeedEvent, ThreadSummary } from '../../core/reads.ts'
import type { TaskListing } from '../../core/tasks.ts'
import type { By, Message } from '../../model.ts'
import { initial, openCount, reduce, TABS, tasksFor, type Tab } from './store.ts'
import { STYLE } from './style.ts'

declare global {
  interface Window {
    __MUSTER__: { token: string }
  }
}

/** The page's data: every read and write goes through the board's own routes, by way of the proxy. */
async function call<T>(route: string, args: unknown[] = [], as: string | null = null): Promise<T> {
  const response = await fetch(`/board/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-muster-inspect': window.__MUSTER__.token }, body: JSON.stringify({ args, as }) })
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
const left = (until: string) => {
  const s = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`
}

type View = { kind: 'activity' } | { kind: 'tasks'; tab: Tab } | { kind: 'channel'; path: string }

function viewOf(location: Location): { view: View; thread: number | null } {
  const params = new URLSearchParams(location.search)
  const thread = Number(params.get('thread')) || null
  const path = location.pathname
  if (path.startsWith('/c/')) return { view: { kind: 'channel', path: decodeURIComponent(path.slice(3)) }, thread }
  if (path.startsWith('/activity')) return { view: { kind: 'activity' }, thread }
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
  const { view, thread } = route

  const go = (href: string) => {
    window.history.pushState(null, '', href)
    setRoute(viewOf(window.location))
  }
  useEffect(() => {
    const onPop = () => setRoute(viewOf(window.location))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const refresh = async () => {
    const [channels, tasks, head] = await Promise.all([call<{ channels: { path: string; threads: number }[] }>('channels'), call<{ tasks: TaskListing[] }>('taskList', [{ state: 'all', limit: 1000 }]), call<number>('head')])
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
        if (cursor.current === 0) {
          const recent = await call<{ events: FeedEvent[]; cursor: number }>('events', [{ after: 0, limit: 1000 }])
          cursor.current = recent.cursor
          dispatch({ type: 'events', events: recent.events.slice(-100), cursor: recent.cursor })
          await refresh()
        } else {
          const page = await call<{ events: FeedEvent[]; cursor: number }>('events', [{ after: cursor.current }])
          cursor.current = page.cursor
          if (page.events.length) {
            dispatch({ type: 'events', events: page.events, cursor: page.cursor })
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
      await run()
      dispatch({ type: 'sent', key })
      await refresh()
    } catch (error) {
      dispatch({ type: 'refused', key, error: (error as Error).message })
    }
  }

  const here = (extra: string) => `${window.location.pathname}${extra}`
  const openThread = (id: number) => go(here(`?${new URLSearchParams({ ...(view.kind === 'tasks' ? { state: view.tab } : {}), thread: String(id) })}`))
  const title = view.kind === 'tasks' ? 'tasks' : view.kind === 'activity' ? 'activity' : `#${view.path}`

  return (
    <div className="app">
      <aside>
        <div className="board">
          <b>muster</b>
          <span>{window.location.host}</span>
        </div>
        <nav>
          <a className={view.kind === 'activity' ? 'on' : ''} onClick={() => go('/activity')}><Activity size={14} /> activity</a>
          <a className={view.kind === 'tasks' ? 'on' : ''} onClick={() => go('/')}><ListTodo size={14} /> tasks <i>{openCount(state)}</i></a>
          <h6>channels</h6>
          {state.channels.map((channel) => (
            <a key={channel.path} className={view.kind === 'channel' && view.path === channel.path ? 'on' : ''} onClick={() => go(`/c/${encodeURIComponent(channel.path)}`)}>
              <Hash size={14} /> {channel.path}
            </a>
          ))}
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
      <main>
        <header>
          <b>{title}</b>
          {view.kind === 'tasks' && <span>oldest first</span>}
          <em className={state.connected ? 'live' : 'down'}>{state.connected ? 'live' : 'reconnecting'}</em>
        </header>
        {state.error && (
          <p className="error" onClick={() => dispatch({ type: 'error', error: null })}>
            {state.error}
          </p>
        )}
        {view.kind === 'tasks' && (
          <>
            <div className="tabs">
              {TABS.map((tab) => (
                <a key={tab} className={tab === view.tab ? 'on' : ''} onClick={() => go(`/?state=${tab}`)}>
                  {tab}
                </a>
              ))}
            </div>
            <div className="rows">
              {tasksFor(state, view.tab).map((task) => (
                <div key={task.id} className={`row ${task.state}`} onClick={() => openThread(task.id)}>
                  <span className="state">{task.state}</span>
                  <span className="id">#{task.id}</span>
                  <span className="text">{task.text.split('\n')[0]}</span>
                  {Object.entries(task.labels).map(([key, value]) => (
                    <code key={key}>{key}={value}</code>
                  ))}
                  <span className="grow" />
                  {task.claim && <span className="meta" title={who(task.claim.by)}>{task.claim.by.profile ?? who(task.claim.by)} · {left(task.claim.until)}</span>}
                  {task.state === 'waiting' && <span className="meta">needs {task.needs.map((id) => `#${id}`).join(' ')}</span>}
                  {task.hold && <span className="meta">{task.hold.kind}</span>}
                  <span className="meta where">#{task.channel}</span>
                  <span className="meta">{ago(task.at)}</span>
                </div>
              ))}
              {tasksFor(state, view.tab).length === 0 && <p className="empty">no {view.tab === 'all' ? '' : view.tab} tasks</p>}
            </div>
          </>
        )}
        {view.kind === 'channel' && (
          <div className="rows">
            {(state.threads[view.path] ?? []).map((item) => (
              <div key={item.message.id} className="thread" onClick={() => openThread(item.message.id)}>
                <div className="by">#{item.message.id} {who(item.message.by)} · {ago(item.message.at)} {item.task && <code>{item.task.state}</code>}</div>
                <div className="text">{item.message.text}</div>
                {item.replies > 0 && <div className="meta">{item.replies} {item.replies === 1 ? 'reply' : 'replies'}</div>}
              </div>
            ))}
            {state.pending.filter((write) => write.thread === null && write.channel === view.path).map((write) => (
              <div key={write.key} className="thread pending"><div className="text">{write.text}</div></div>
            ))}
          </div>
        )}
        {view.kind === 'activity' && (
          <div className="rows">
            {state.activity.map((event) => (
              <div key={event.seq} className="row" onClick={() => event.thread && openThread(event.thread)}>
                <span className="id">{event.seq}</span>
                <span className="state">{event.type}</span>
                <span className="text">{String((event.data as { text?: string; result?: string; reason?: string }).text ?? (event.data as { result?: string }).result ?? (event.data as { reason?: string }).reason ?? '').split('\n')[0]}</span>
                <span className="grow" />
                <span className="meta">{who(event.by)} · {ago(event.at)}</span>
              </div>
            ))}
          </div>
        )}
        {view.kind !== 'activity' && (
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
            <a onClick={() => go(here(view.kind === 'tasks' ? `?state=${view.tab}` : ''))}><X size={14} /></a>
          </header>
          <div className="messages">
            {[state.open.message, ...state.open.replies].map((message) => (
              <article key={message.id}>
                <div className="by">{who(message.by)} · {ago(message.at)}</div>
                <div className="text">{message.deleted ? '(deleted)' : message.text}</div>
                {Object.keys(message.labels).length > 0 && (
                  <div className="labels"><Tag size={12} /> {Object.entries(message.labels).map(([key, value]) => <code key={key}>{key}={value}</code>)}</div>
                )}
                {message.attachments.length > 0 && <div className="labels"><Paperclip size={12} /> {message.attachments.map((file) => file.name).join(' ')}</div>}
              </article>
            ))}
            {state.pending.filter((write) => write.thread === state.open!.message.id).map((write) => (
              <article key={write.key} className="pending"><div className="text">{write.text}</div></article>
            ))}
          </div>
          <Composer placeholder="reply…" button="reply" onSend={(text) => write(`${Date.now()}`, { thread: state.open!.message.id, channel: state.open!.message.channel, text }, () => call('reply', [{ to: state.open!.message.id, text }], me))} />
        </section>
      )}
      <style>{STYLE}</style>
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
        <span>enter to send · shift+enter for a new line</span>
        <button onClick={send}>{props.button}</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
