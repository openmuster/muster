'use client'

import { useEffect, useState } from 'react'
import type { Snapshot } from '@/lib/swarm'

const COLUMNS = ['ready', 'claimed', 'waiting', 'blocked', 'completed', 'failed', 'canceled'] as const

/** Time left on a claim, as the CLI prints it. */
const left = (until: string, now: number): string => {
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000))
  return s === 0 ? 'lease ran out' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`
}
const runOf = (channel: string): string => channel.slice(channel.lastIndexOf('/') + 1)

export default function Live() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setRun(new URLSearchParams(window.location.search).get('run'))
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const response = await fetch(`/api/live${run ? `?run=${encodeURIComponent(run)}` : ''}`)
        if (!response.ok) throw new Error(`the board answered ${response.status}`)
        const next = (await response.json()) as Snapshot
        if (stopped) return
        setSnap(next)
        setError(null)
      } catch (cause) {
        if (!stopped) setError((cause as Error).message)
      }
      if (!stopped) timer = setTimeout(load, 2000)
    }
    void load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [run])
  const pick = (name: string | null) => {
    window.history.replaceState(null, '', name ? `?run=${encodeURIComponent(name)}` : window.location.pathname)
    setRun(name)
  }
  if (!snap) return <p className="dim">{error ?? 'loading'}</p>
  const several = !run && snap.runs.length > 1
  return (
    <>
      <h1>
        live <span className="dim">{error ? `· ${error}` : `· ${snap.agents.length} working`}</span>
      </h1>
      <div className="runs">
        <a href="/live" className={run ? '' : 'on'} onClick={(event) => (event.preventDefault(), pick(null))}>
          all runs
        </a>
        {snap.runs.map((entry) => (
          <a key={entry.name} href={`/live?run=${entry.name}`} className={run === entry.name ? 'on' : ''} onClick={(event) => (event.preventDefault(), pick(entry.name))}>
            {entry.name} <span className="dim">{entry.open === 0 ? `done, ${entry.total}` : `${entry.open} open of ${entry.total}`}</span>
          </a>
        ))}
      </div>
      <div className="cols">
        {COLUMNS.map((state) => (
          <div className={`col${snap.tasks[state].length ? '' : ' empty'}`} key={state}>
            <div className="dim">
              {state} {snap.tasks[state].length}
            </div>
            {snap.tasks[state].map((task) => (
              <div className="task" key={task.id}>
                #{task.id} {task.text.split('\n')[0]}
                <div className="dim">
                  {[
                    several ? runOf(task.channel) : '',
                    task.claim ? `${task.claim.by.profile ?? task.claim.by.principal} · ${left(task.claim.until, now)}` : '',
                    task.hold ? task.hold.kind : '',
                    task.state === 'waiting' ? `needs ${task.needs.map((id) => `#${id}`).join(' ')}` : '',
                    task.result ?? task.reason ?? '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <h2>messages</h2>
      {snap.messages.map((message) => (
        <div className="task" key={message.id}>
          <span className="dim">
            #{message.thread} {message.by.profile ?? message.by.principal}
          </span>{' '}
          {message.text.split('\n')[0]}
        </div>
      ))}
    </>
  )
}
