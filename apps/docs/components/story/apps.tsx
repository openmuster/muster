import { Check, CircleDot, X } from 'lucide-react'
import type { App, AppComment, Chapter, View } from './cues'

/** Each tool's name, as the panel's caption. */
export const TOOL: Record<View, string> = { linear: 'Linear', github: 'GitHub', slack: 'Slack', notion: 'Notion' }

const COLUMNS = ['Backlog', 'Todo', 'In Progress', 'Done']

/**
 * A sketch of a synced tool's own view of the work: drawn in the site's greys, not the tool's colours,
 * so it reads as "where your team already is" rather than a screenshot of someone else's product.
 */
export function AppView({ chapter, app }: { chapter: Chapter; app: App }) {
  if (chapter.view === 'linear') return <Kanban chapter={chapter} app={app} />
  if (chapter.view === 'github') return <PullRequest chapter={chapter} app={app} />
  if (chapter.view === 'slack') return <SlackThread app={app} />
  return <Database chapter={chapter} app={app} />
}

function Kanban({ chapter, app }: { chapter: Chapter; app: App }) {
  return (
    <div className="mt-3 space-y-4">
      <div className="grid grid-cols-4 gap-2">
        {COLUMNS.map((column) => (
          <div key={column} className="min-w-0 rounded-md bg-fd-background/60 p-1.5">
            <p className="truncate px-0.5 text-[11px] text-fd-muted-foreground">{column}</p>
            <div className="mt-1.5 min-h-16">
              {app.column === column && (
                // Keyed by column, so the card arrives again where a person puts it.
                <div key={column} className="story-in rounded border border-fd-border bg-fd-card p-1.5">
                  <p className="font-mono text-[10px] text-fd-muted-foreground">{chapter.ref}</p>
                  <p className="mt-0.5 text-[11px] leading-snug">{chapter.title}</p>
                  {app.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {app.tags.map((tag) => (
                        <span key={tag} className="rounded-full border border-fd-border px-1.5 text-[10px] text-fd-muted-foreground">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {app.comments.length > 0 && <p className="mt-1 text-[10px] text-fd-muted-foreground">{app.comments.length} comment{app.comments.length > 1 ? 's' : ''}</p>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <Comments comments={app.comments} />
      <Note app={app} />
    </div>
  )
}

const CHECKS = {
  failing: { icon: X, tone: 'text-red-300', text: 'ci: failing' },
  pending: { icon: CircleDot, tone: 'text-amber-300', text: 'ci: running' },
  passing: { icon: Check, tone: 'text-green-300', text: 'ci: passing' },
} as const

function PullRequest({ chapter, app }: { chapter: Chapter; app: App }) {
  const checks = app.checks ? CHECKS[app.checks] : null
  return (
    <div className="mt-3 space-y-4">
      <div>
        <div className="flex items-start gap-2">
          <span className="font-mono text-xs text-fd-muted-foreground">{chapter.ref}</span>
          <p className="text-sm font-medium">{chapter.title}</p>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-green-500/50 px-2 py-0.5 text-green-300">{app.column}</span>
          {app.tags.map((tag) => (
            <span key={tag} className="rounded-full border border-fd-border px-1.5 text-fd-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      </div>
      {checks && (
        <div key={app.checks} className="story-in flex items-center gap-2 rounded-md border border-fd-border px-2.5 py-2 text-xs">
          <checks.icon size={14} className={checks.tone} aria-hidden="true" />
          <span className={checks.tone}>{checks.text}</span>
        </div>
      )}
      <Comments comments={app.comments} />
      <Note app={app} />
    </div>
  )
}

function SlackThread({ app }: { app: App }) {
  const [root, ...replies] = app.comments
  if (!root) return <p className="mt-3 text-sm text-fd-muted-foreground">nothing here yet</p>
  return (
    <div className="mt-3 space-y-3">
      <Message comment={root} />
      {replies.length > 0 && (
        <div className="ml-3 space-y-3 border-l border-fd-border pl-3">
          <p className="text-[11px] text-fd-muted-foreground">
            {replies.length} repl{replies.length > 1 ? 'ies' : 'y'}
          </p>
          {replies.map((reply, at) => (
            <Message key={at} comment={reply} />
          ))}
        </div>
      )}
    </div>
  )
}

function Database({ chapter, app }: { chapter: Chapter; app: App }) {
  const rows = [
    { title: 'Pricing page copy', status: 'Done' },
    { title: chapter.title, status: app.column, ours: true },
    { title: 'Webinar outline', status: 'Not started' },
  ]
  return (
    <div className="mt-3 space-y-4">
      <div className="overflow-hidden rounded-md border border-fd-border text-xs">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-fd-border px-2.5 py-1.5 text-[11px] text-fd-muted-foreground">
          <span>{chapter.ref}</span>
          <span>Status</span>
        </div>
        {rows.map((row) => (
          <div key={row.title} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 ${row.ours ? 'bg-fd-accent/60' : ''}`}>
            <span className="truncate">{row.title}</span>
            <span key={row.status} className={`rounded px-1.5 py-0.5 text-[11px] ${row.ours ? 'story-in' : ''} ${statusTone(row.status)}`}>
              {row.status}
            </span>
          </div>
        ))}
      </div>
      <Comments comments={app.comments} />
      <Note app={app} />
    </div>
  )
}

function statusTone(status: string): string {
  if (status === 'Done') return 'bg-green-500/15 text-green-300'
  if (status === 'In progress') return 'bg-blue-500/15 text-blue-300'
  if (status === 'Ready for agent') return 'bg-amber-500/15 text-amber-300'
  return 'bg-fd-accent text-fd-muted-foreground'
}

/** The board's replies, as the comments they became on the other side. */
function Comments({ comments }: { comments: AppComment[] }) {
  if (comments.length === 0) return null
  return (
    <ul className="space-y-3 border-l border-fd-border pl-3">
      {comments.map((comment, at) => (
        <li key={at} className="story-in">
          <Message comment={comment} />
        </li>
      ))}
    </ul>
  )
}

function Message({ comment }: { comment: AppComment }) {
  return (
    <div className="story-in text-sm">
      <span className="text-xs text-fd-muted-foreground">
        {comment.by}
        {comment.agent && <span className="ml-1.5 rounded border border-fd-border px-1 text-[10px]">via muster</span>}
      </span>
      <p className="mt-0.5">{comment.text}</p>
    </div>
  )
}

function Note({ app }: { app: App }) {
  if (!app.note) return null
  return (
    <p key={app.note} className="story-in text-xs text-fd-muted-foreground">
      {app.note}
    </p>
  )
}
