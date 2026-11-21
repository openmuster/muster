'use client'

import { Pause, Play } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { CHAPTERS, chapterMs, frameAt, type Board } from './cues'

/** `prefers-reduced-motion`, read once the page is live. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return reduced
}

const STATE_STYLE: Record<Board['state'], string> = {
  ready: 'border-fd-border text-fd-foreground',
  claimed: 'border-[#3b82f6]/50 text-[#93c5fd]',
  blocked: 'border-[#f59e0b]/50 text-[#fcd34d]',
  completed: 'border-[#22c55e]/50 text-[#86efac]',
}

/**
 * The home page's demo: a terminal on one side, the board it changes on the other. It plays by itself,
 * a chapter at a time, and holds still for anyone who pauses it, tabs to it, or has asked for less
 * motion, in which case each chapter is shown finished.
 */
export function Story({ code }: { code: string }) {
  const reduced = useReducedMotion()
  const [index, setIndex] = useState(0)
  const [t, setT] = useState(0)
  const [paused, setPaused] = useState(false)
  const [hover, setHover] = useState(false)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const chapter = CHAPTERS[index]!
  const total = chapterMs(chapter)
  // Resting the pointer on the demo holds it so it can be read. The tabs above it don't, so picking a scene plays it.
  const still = reduced || paused || hover

  useEffect(() => {
    if (still) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const step = Math.min(now - last, 100)
      last = now
      setT((before) => before + step)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [still])

  useEffect(() => {
    if (!reduced && t >= total) {
      setIndex((before) => (before + 1) % CHAPTERS.length)
      setT(0)
    }
  }, [t, total, reduced])

  const go = (next: number) => {
    setIndex((next + CHAPTERS.length) % CHAPTERS.length)
    setT(0)
  }
  const onKey = (event: KeyboardEvent) => {
    const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!move) return
    event.preventDefault()
    const next = (index + move + CHAPTERS.length) % CHAPTERS.length
    go(next)
    tabs.current[next]?.focus()
  }

  const shown = frameAt(chapter, reduced ? total : t)
  const board = shown.board

  return (
    <section aria-label="muster in three short scenes">
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Scenes" onKeyDown={onKey}>
        {CHAPTERS.map((item, at) => (
          <button
            key={item.id}
            ref={(node) => void (tabs.current[at] = node)}
            role="tab"
            type="button"
            id={`scene-tab-${item.id}`}
            aria-selected={at === index}
            aria-controls="scene-panel"
            tabIndex={at === index ? 0 : -1}
            onClick={() => go(at)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${at === index ? 'bg-fd-accent text-fd-foreground' : 'text-fd-muted-foreground hover:text-fd-foreground'}`}
          >
            {item.label}
          </button>
        ))}
        {!reduced && (
          <button type="button" onClick={() => setPaused((before) => !before)} aria-pressed={paused} className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-fd-muted-foreground hover:text-fd-foreground">
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
            {paused ? 'Play' : 'Pause'}
          </button>
        )}
      </div>

      <div id="scene-panel" role="tabpanel" aria-labelledby={`scene-tab-${chapter.id}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className="mt-3 overflow-hidden rounded-xl border border-fd-border bg-[#0a0a0a]">
        <div className="flex items-center gap-3 border-b border-fd-border px-4 py-2.5">
          <span className="flex gap-1.5" aria-hidden="true">
            <i className="size-2.5 rounded-full bg-[#3a3a3a]" />
            <i className="size-2.5 rounded-full bg-[#3a3a3a]" />
            <i className="size-2.5 rounded-full bg-[#3a3a3a]" />
          </span>
          <span className="font-mono text-xs text-fd-muted-foreground">{chapter.file}</span>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="min-h-[13rem] lg:min-h-[23rem] border-fd-border p-4 lg:border-r">
            {chapter.code ? (
              // Highlighted on the server from text of ours, never from anything a visitor sends.
              <div className="story-code text-[13px] leading-relaxed" dangerouslySetInnerHTML={{ __html: code }} />
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed">
                {shown.lines.map((line, at) =>
                  line.kind === 'cmd' ? (
                    <div key={at}>
                      <span className="select-none text-fd-muted-foreground">$ </span>
                      <Command text={line.text} />
                      {line.typing && <span className="story-caret" aria-hidden="true" />}
                    </div>
                  ) : (
                    <div key={at} className="text-fd-muted-foreground">
                      {line.text}
                    </div>
                  ),
                )}
              </pre>
            )}
          </div>

          <div className="min-h-[13rem] lg:min-h-[23rem] border-t border-fd-border p-4 lg:border-t-0" aria-live="off">
            <div className="flex items-center justify-between gap-3 text-xs text-fd-muted-foreground">
              <span className="font-mono">#work</span>
              <span>the board</span>
            </div>
            {board ? (
              <div className="mt-3">
                <div className="flex items-start gap-2">
                  <span className="font-mono text-xs text-fd-muted-foreground">#1</span>
                  <p className="text-sm font-medium">{chapter.title}</p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded border px-1.5 py-0.5 font-mono transition-colors duration-300 ${STATE_STYLE[board.state]}`}>{board.state}</span>
                  <span className="text-fd-muted-foreground">{board.note}</span>
                </div>
                <ul className="mt-4 space-y-3 border-l border-fd-border pl-3">
                  {board.replies.map((reply, at) => (
                    <li key={at} className="story-in text-sm">
                      <span className="text-xs text-fd-muted-foreground">
                        {reply.by}
                        {reply.by !== chapter.who && reply.by !== 'ada' ? ' via ada' : ''}
                      </span>
                      <p className="mt-0.5">{reply.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-sm text-fd-muted-foreground">nothing here yet</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 flex justify-center gap-2" aria-hidden="true">
        {CHAPTERS.map((item, at) => (
          <span key={item.id} className={`h-1 w-6 overflow-hidden rounded-full ${at === index ? 'bg-fd-border' : 'bg-fd-border/60'}`}>
            {at === index && <span className="block h-full bg-fd-foreground" style={{ width: `${Math.min(100, ((reduced ? total : t) / total) * 100)}%` }} />}
          </span>
        ))}
      </div>
    </section>
  )
}

/** A command, with its parts told apart the way a highlighter would: the program, flags, and quoted text. */
function Command({ text }: { text: string }) {
  const parts = text.match(/"[^"]*"?|\S+|\s+/g) ?? []
  return (
    <>
      {parts.map((part, at) => {
        const tone = part.startsWith('"') ? 'text-[#86efac]' : part.startsWith('--') ? 'text-[#93c5fd]' : at === 0 ? 'text-[#f0abfc]' : ''
        return (
          <span key={at} className={tone}>
            {part}
          </span>
        )
      })}
    </>
  )
}
