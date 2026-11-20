import { homedir } from 'node:os'
import { join } from 'node:path'
import { FACTORY, team } from '@/lib/board'
import { setup, tilde } from '@/lib/setup'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const me = await team().whoami()
  const config = process.env.MUSTER_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'muster')
  const steps = setup({ config, board: me.where, channel: FACTORY })
  const page = await team().readChannel({ channel: `${FACTORY}/`, limit: 15 }).catch(() => ({ threads: [] }))
  const open = (await team().taskList({ channel: `${FACTORY}/` }).catch(() => ({ tasks: [] }))).tasks
  return (
    <>
      <h1>factory</h1>
      <p className="dim">board {tilde(me.where)} · threads under #{FACTORY}/</p>
      <h2>setup</h2>
      {steps.map((step) => (
        <div className="item" key={step.name}>
          {step.done ? 'done' : 'to do'} · {step.name}
          <div className="dim">{step.detail}</div>
          {step.fix && <code>{step.fix}</code>}
        </div>
      ))}
      <h2>
        recent threads: {page.threads.length} · open tasks: {open.length}
      </h2>
      {page.threads.length === 0 && <p className="dim">nothing yet: post in #{FACTORY}/intake, or open an issue in a synced repo</p>}
      {page.threads.map((thread) => (
        <div className="item" key={thread.message.id}>
          <a href={`/board?thread=${thread.message.id}`}>
            #{thread.message.id} {thread.message.text.split('\n')[0]}
          </a>
          <div className="dim">
            #{thread.message.channel} · {thread.message.by.profile ?? thread.message.by.principal} · {thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}
            {thread.task ? ` · ${thread.task.state}` : ''}
            {thread.message.labels.state ? ` · ${thread.message.labels.state}` : ''}
          </div>
        </div>
      ))}
    </>
  )
}
