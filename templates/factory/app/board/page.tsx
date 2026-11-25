import { revalidatePath } from 'next/cache'
import { FACTORY, team } from '@/lib/board'

export const dynamic = 'force-dynamic'

async function reply(form: FormData) {
  'use server'
  const to = Number(form.get('to'))
  const text = String(form.get('text') ?? '').trim()
  if (!to || !text) return
  await team.reply({ to, text })
  revalidatePath('/board')
}

const who = (by: { principal: string; profile: string | null }) => by.profile ?? by.principal.slice(by.principal.lastIndexOf(':') + 1)

export default async function Board({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  const id = Number((await searchParams).thread)
  if (id) {
    const thread = await team.readThread({ id })
    return (
      <>
        <h1>
          #{thread.message.id} <span className="dim">#{thread.message.channel}</span>
        </h1>
        {[thread.message, ...thread.replies].map((message) => (
          <div className="item" key={message.id}>
            <div className="dim">{who(message.by)}</div>
            <div className="text">{message.text}</div>
          </div>
        ))}
        <form action={reply}>
          <input type="hidden" name="to" value={thread.message.id} />
          <textarea name="text" rows={3} placeholder="reply as yourself" required />
          <button type="submit">reply</button>
        </form>
      </>
    )
  }
  const page = await team.readChannel({ channel: `${FACTORY}/`, limit: 50 }).catch(() => ({ threads: [] }))
  return (
    <>
      <h1>board</h1>
      {page.threads.length === 0 && <p className="dim">no threads</p>}
      {page.threads.map((thread) => (
        <div className="item" key={thread.message.id}>
          <a href={`/board?thread=${thread.message.id}`}>
            #{thread.message.id} {thread.message.text.split('\n')[0]}
          </a>
          <div className="dim">
            #{thread.message.channel} · {who(thread.message.by)} · {thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}
          </div>
        </div>
      ))}
    </>
  )
}
