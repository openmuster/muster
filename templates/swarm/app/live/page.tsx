'use client'

import { useEffect, useState } from 'react'
import type { Snapshot } from '@/lib/swarm'

const COLUMNS = ['ready', 'claimed', 'waiting', 'blocked', 'completed', 'failed'] as const

export default function Live() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const run = new URLSearchParams(window.location.search).get('run')
    let stopped = false
    const load = async () => {
      try {
        const response = await fetch(`/api/live${run ? `?run=${encodeURIComponent(run)}` : ''}`)
        if (!response.ok) throw new Error(`the board answered ${response.status}`)
        setSnap((await response.json()) as Snapshot)
        setError(null)
      } catch (cause) {
        setError((cause as Error).message)
      }
      if (!stopped) setTimeout(load, 2000)
    }
    void load()
    return () => {
      stopped = true
    }
  }, [])
  if (!snap) return <p className="dim">{error ?? 'loading'}</p>
  return (
    <>
      <h1>
        live <span className="dim">{error ? `· ${error}` : `· ${snap.agents.length} working`}</span>
      </h1>
      <div className="cols">
        {COLUMNS.map((state) => (
          <div className="col" key={state}>
            <div className="dim">
              {state} {snap.tasks[state].length}
            </div>
            {snap.tasks[state].map((task) => (
              <div className="task" key={task.id}>
                #{task.id} {task.text.split('\n')[0]}
                <div className="dim">
                  {task.claim ? `${task.claim.by.profile ?? ''} ` : ''}
                  {task.hold ? `${task.hold.kind} ` : ''}
                  {task.state === 'waiting' ? `needs ${task.needs.map((id) => `#${id}`).join(' ')}` : ''}
                  {task.result ?? task.reason ?? ''}
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
