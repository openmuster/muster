import { createHmac, timingSafeEqual } from 'node:crypto'
import { Failure } from '../failure.ts'
import { channelPath } from '../model.ts'
import { SEND_MS, type Inbound, type Provider, type Received } from './types.ts'

const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const bad = () => new Failure('unauthorized', 'bad signature')
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run'

async function send(fetcher: typeof fetch, url: string, init: RequestInit): Promise<any> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(SEND_MS), ...init })
  const body = (await response.json().catch(() => ({}))) as any
  if (!response.ok) throw new Failure(`platform_${response.status}`, `The platform answered ${response.status}.`)
  return body
}

export type GitHubOptions = {
  secret: string
  /** A token that may comment. Needed only where a repo mirrors. */
  token?: string
  /** The app's own login, so its comments aren't imported back. */
  bot?: string
  /** A repo to a channel, or to a channel for issues and one for pulls. `mirror` sends board replies back. */
  repos: Record<string, string | { issues?: string; pulls?: string; mirror?: boolean }>
  api?: string
}

/** GitHub: issues, pull requests and their comments come in as threads. Nothing goes back unless a repo mirrors. */
export function github(options: GitHubOptions): Provider {
  /** An issue or pull request as a thread's first message, written by whoever opened it, in the state it is in now. */
  const rootOf = (repo: string, item: Record<string, any>, isPull: boolean, id: string): Inbound => {
    const thread = `${repo}#${item.number}`
    const opener = item.user?.login as string | undefined
    const merged = Boolean(item.merged || item.merged_at || item.pull_request?.merged_at)
    return {
      id,
      author: String(opener ?? 'unknown'),
      place: `${repo}|${isPull ? 'pulls' : 'issues'}`,
      self: options.bot !== undefined && opener === options.bot,
      kind: 'root',
      thread,
      external: thread,
      text: `${item.title ?? ''}\n\n${item.body ?? ''}`.trim(),
      labels: { kind: isPull ? 'pr' : 'issue', state: item.state === 'closed' ? (merged ? 'merged' : 'closed') : 'open', ref: thread },
    }
  }
  const mapping = (place: string) => {
    const [repo, kind] = place.split('|') as [string, 'issues' | 'pulls']
    const to = options.repos[repo]
    return { repo, kind, to }
  }
  return {
    type: 'github',
    verify({ headers, body }) {
      const given = headers['x-hub-signature-256'] ?? ''
      if (!same(given, `sha256=${hmac(options.secret, body)}`)) throw bad()
    },
    parse({ headers, body }) {
      const payload = JSON.parse(body) as Record<string, any>
      const kind = headers['x-github-event']
      // What makes a delivery this one and not another is what GitHub signed: its body, and nothing else. No
      // header is signed, the delivery ID and the event's kind included, so an old body sent again under a
      // new ID, or as another kind that reads the same, would otherwise be news, and set a thread's labels
      // back to what they were.
      const delivery = `gh:${hmac('id', body).slice(0, 32)}`
      const repo = payload.repository?.full_name as string | undefined
      if (!repo) return []
      const self = options.bot !== undefined && payload.sender?.login === options.bot
      const author = String(payload.sender?.login ?? 'unknown')
      const item = payload.issue ?? payload.pull_request
      const isPull = payload.pull_request !== undefined || payload.issue?.pull_request !== undefined
      const place = `${repo}|${isPull ? 'pulls' : 'issues'}`
      const thread = item ? `${repo}#${item.number}` : ''
      const base = { id: delivery, author, place, self }
      if ((kind === 'issues' || kind === 'pull_request') && payload.action === 'opened') {
        return [{ ...base, kind: 'root', thread, external: thread, text: `${item.title}\n\n${item.body ?? ''}`.trim(), labels: { kind: isPull ? 'pr' : 'issue', state: 'open', ref: thread } }]
      }
      // A comment or review on an issue the board never saw (opened before sync, or while the board was
      // down) carries the issue, so its thread can start from it. A board that has the thread ignores it.
      const withRoot = (events: Inbound[]): Inbound[] => {
        if (!item) return events
        const { author: opener, text, labels } = rootOf(repo, item, isPull, '')
        return events.map((event) => ({ ...event, parent: { author: opener, text: text ?? '', labels: labels ?? {} } }))
      }
      if ((kind === 'issues' || kind === 'pull_request') && (payload.action === 'closed' || payload.action === 'reopened')) {
        return [{ ...base, kind: 'labels', thread, external: `${delivery}`, labels: { state: payload.action === 'reopened' ? 'open' : item.merged ? 'merged' : 'closed' } }]
      }
      if (kind === 'issue_comment' && payload.action === 'edited') return [{ ...base, kind: 'edit', thread, external: `comment:${payload.comment.id}`, text: String(payload.comment.body ?? '') }]
      if (kind === 'issue_comment' && payload.action === 'deleted') return [{ ...base, kind: 'delete', thread, external: `comment:${payload.comment.id}` }]
      if ((kind === 'issues' || kind === 'pull_request') && payload.action === 'edited') return [{ ...base, kind: 'edit', thread, external: thread, text: `${item.title}\n\n${item.body ?? ''}`.trim() }]
      if (kind === 'issue_comment' && payload.action === 'created') {
        return withRoot([{ ...base, kind: 'reply', thread, external: `comment:${payload.comment.id}`, text: String(payload.comment.body ?? '') }])
      }
      if (kind === 'pull_request_review' && payload.action === 'submitted') {
        const out: Inbound[] = [{ ...base, kind: 'labels', thread, external: delivery, labels: { review: String(payload.review.state).toLowerCase() } }]
        if (payload.review.body) out.push({ ...base, id: `${delivery}:body`, kind: 'reply', thread, external: `review:${payload.review.id}`, text: String(payload.review.body) })
        return withRoot(out)
      }
      if (kind === 'workflow_run' && payload.action === 'completed') {
        return ((payload.workflow_run.pull_requests ?? []) as { number: number }[]).map((pull, index) => ({
          ...base,
          id: `${delivery}:${index}`,
          place: `${repo}|pulls`,
          kind: 'labels' as const,
          thread: `${repo}#${pull.number}`,
          external: `${delivery}:${index}`,
          labels: { [`ci.${slug(String(payload.workflow_run.name ?? 'run'))}`]: String(payload.workflow_run.conclusion ?? 'unknown') },
        }))
      }
      return []
    },
    channelFor(place) {
      const { kind, to } = mapping(place)
      const channel = typeof to === 'string' ? to : to?.[kind]
      return channel ? channelPath(channel) : null
    },
    placeFor(channel) {
      for (const [repo, to] of Object.entries(options.repos)) if (typeof to === 'object' && to.mirror === true && to.issues === channel) return `${repo}|issues`
      return null
    },
    async update(external, text, place, fetcher) {
      if (!external.startsWith('comment:')) return
      await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${place.split('|')[0]}/issues/comments/${external.slice(8)}`, { method: 'PATCH', headers: { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'muster' }, body: JSON.stringify({ body: text }) })
    },
    async remove(external, place, fetcher) {
      if (!external.startsWith('comment:')) return
      await fetcher(`${options.api ?? 'https://api.github.com'}/repos/${place.split('|')[0]}/issues/comments/${external.slice(8)}`, { method: 'DELETE', headers: { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'user-agent': 'muster' } })
    },
    async catchUp(since, fetcher) {
      if (!options.token) return []
      const out: Inbound[] = []
      const headers = { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'user-agent': 'muster' }
      for (const repo of Object.keys(options.repos)) {
        // Issues and pull requests first, so a comment on one opened while the board was down lands in its thread.
        const items = (await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(since)}&per_page=100`, { headers })) as any[]
        const parents = new Map<string, Inbound['parent']>()
        for (const item of Array.isArray(items) ? items : []) {
          const isPull = item.pull_request !== undefined
          const root = rootOf(repo, item, isPull, `catchup:issue:${repo}#${item.number}`)
          out.push(root)
          parents.set(String(item.number), { author: root.author, text: root.text ?? '', labels: root.labels ?? {} })
          // Its state now: a close or a merge missed while down. Importing it on a thread that already says so changes nothing.
          out.push({ ...root, id: `catchup:state:${repo}#${item.number}:${item.updated_at ?? ''}`, kind: 'labels', external: `catchup:state:${repo}#${item.number}:${item.updated_at ?? ''}`, labels: { state: root.labels!.state! } })
        }
        const comments = (await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`, { headers })) as any[]
        for (const comment of Array.isArray(comments) ? comments : []) {
          const number = String(comment.issue_url ?? '').split('/').pop()
          const isPull = String(comment.html_url ?? '').includes('/pull/')
          const parent = parents.get(number ?? '')
          out.push({ id: `catchup:comment:${comment.id}`, author: String(comment.user?.login ?? 'unknown'), place: `${repo}|${isPull ? 'pulls' : 'issues'}`, self: options.bot !== undefined && comment.user?.login === options.bot, kind: 'reply', thread: `${repo}#${number}`, external: `comment:${comment.id}`, text: String(comment.body ?? ''), ...(parent ? { parent } : {}) })
        }
      }
      return out
    },
    mirrors(place) {
      const { to } = mapping(place)
      return typeof to === 'object' && to.mirror === true && options.token !== undefined
    },
    async deliver(message, target, fetcher) {
      const headers = { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'muster' }
      if (target.threadExternal === null) {
        // A thread started on the board opens an issue: its first line is the title.
        const repo = target.place.split('|')[0]!
        const [title, ...rest] = message.text.split('\n')
        const made = await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${repo}/issues`, { method: 'POST', headers, body: JSON.stringify({ title: title!.slice(0, 250), body: rest.join('\n').trim() }) })
        return { external: `${repo}#${made.number}`, thread: `${repo}#${made.number}`, labels: { kind: 'issue', state: 'open', ref: `${repo}#${made.number}` } }
      }
      const [repo, number] = target.threadExternal.split('#')
      const made = await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'muster' },
        body: JSON.stringify({ body: message.text }),
      })
      return { external: `comment:${made.id}` }
    },
  }
}

export type LinearOptions = {
  secret: string
  token?: string
  /** The app's own user ID, so its comments aren't imported back. */
  bot?: string
  /** A team key to a channel. Two-way unless `mirror: false`. */
  teams: Record<string, string | { channel: string; mirror?: boolean }>
  api?: string
}

/** Linear: issues and comments come in as threads, and board replies go back as comments. */
export function linear(options: LinearOptions): Provider {
  const team = (place: string) => options.teams[place]
  return {
    type: 'linear',
    verify({ headers, body }) {
      if (!same(headers['linear-signature'] ?? '', hmac(options.secret, body))) throw bad()
    },
    parse({ headers, body }) {
      const payload = JSON.parse(body) as Record<string, any>
      const data = payload.data ?? {}
      const delivery = headers['linear-delivery'] ?? `${payload.type}:${data.id}:${payload.action}:${payload.createdAt ?? ''}`
      const author = String(data.userId ?? data.user?.id ?? payload.actor?.id ?? 'unknown')
      const self = options.bot !== undefined && author === options.bot
      if (payload.type === 'Issue' && payload.action === 'create') {
        const thread = `issue:${data.id}`
        return [{ id: delivery, author: String(data.creatorId ?? author), place: String(data.team?.key ?? ''), self, kind: 'root', thread, external: thread, text: `${data.title}\n\n${data.description ?? ''}`.trim(), labels: { kind: 'issue', ref: String(data.identifier ?? ''), ...(data.state?.name ? { state: slug(String(data.state.name)) } : {}) } }]
      }
      if (payload.type === 'Issue' && payload.action === 'update' && data.state?.name) {
        return [{ id: delivery, author, place: String(data.team?.key ?? ''), self, kind: 'labels', thread: `issue:${data.id}`, external: delivery, labels: { state: slug(String(data.state.name)) } }]
      }
      if (payload.type === 'Comment' && (payload.action === 'update' || payload.action === 'remove')) {
        return [{ id: delivery, author, place: String(data.issue?.team?.key ?? data.team?.key ?? ''), self, kind: payload.action === 'remove' ? 'delete' : 'edit', thread: `issue:${data.issueId ?? data.issue?.id}`, external: `comment:${data.id}`, ...(payload.action === 'update' ? { text: String(data.body ?? '') } : {}) }]
      }
      if (payload.type === 'Comment' && payload.action === 'create') {
        return [{ id: delivery, author, place: String(data.issue?.team?.key ?? data.team?.key ?? ''), self, kind: 'reply', thread: `issue:${data.issueId ?? data.issue?.id}`, external: `comment:${data.id}`, text: String(data.body ?? '') }]
      }
      return []
    },
    channelFor(place) {
      const to = team(place)
      const channel = typeof to === 'string' ? to : to?.channel
      return channel ? channelPath(channel) : null
    },
    placeFor(channel) {
      for (const [key, to] of Object.entries(options.teams)) if ((typeof to === 'string' ? to : to.channel) === channel) return key
      return null
    },
    mirrors(place) {
      const to = team(place)
      return options.token !== undefined && to !== undefined && !(typeof to === 'object' && to.mirror === false)
    },
    async deliver(message, target, fetcher) {
      // A personal API key goes as it is; an OAuth token is a bearer token.
      const token = options.token!
      const authorization = token.startsWith('lin_api_') || /^bearer /i.test(token) ? token : `Bearer ${token}`
      const post = (query: string, variables: unknown) => send(fetcher, options.api ?? 'https://api.linear.app/graphql', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
      if (target.threadExternal === null) {
        const found = await post('query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }', { key: target.place })
        const teamId = found?.data?.teams?.nodes?.[0]?.id
        if (!teamId) throw new Failure('platform_refused', `Linear has no team "${target.place}".`)
        const [title, ...rest] = message.text.split('\n')
        const made = await post('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier state { name } } } }', { input: { teamId, title: title!.slice(0, 250), description: rest.join('\n').trim() } })
        const created = made?.data?.issueCreate?.issue
        const issue = created?.id
        if (!issue) throw new Failure('platform_refused', 'Linear did not make the issue.')
        const labels: Record<string, string> = { kind: 'issue', ...(created.identifier ? { ref: String(created.identifier) } : {}), ...(created.state?.name ? { state: slug(String(created.state.name)) } : {}) }
        return { external: `issue:${issue}`, thread: `issue:${issue}`, labels }
      }
      const made = await post('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }', { input: { issueId: target.threadExternal!.replace(/^issue:/, ''), body: message.text } })
      const id = made?.data?.commentCreate?.comment?.id
      if (!id) throw new Failure('platform_refused', 'Linear did not make the comment.')
      return { external: `comment:${id}` }
    },
  }
}

export type SlackOptions = {
  secret: string
  token?: string
  /** The app's own bot ID, so its messages aren't imported back. */
  bot?: string
  /** A Slack channel ID to a board channel. Two-way unless `mirror: false`. */
  channels: Record<string, string | { channel: string; mirror?: boolean }>
  api?: string
  now?: () => number
}

/** Slack: messages in mapped channels come in as threads, and board replies go back into the Slack thread. */
export function slack(options: SlackOptions): Provider {
  const now = options.now ?? (() => Date.now())
  return {
    type: 'slack',
    verify({ headers, body }) {
      const stamp = headers['x-slack-request-timestamp'] ?? ''
      // An old request replayed is refused, however well it is signed.
      if (!/^\d+$/.test(stamp) || Math.abs(now() / 1000 - Number(stamp)) > 300) throw bad()
      if (!same(headers['x-slack-signature'] ?? '', `v0=${hmac(options.secret, `v0:${stamp}:${body}`)}`)) throw bad()
    },
    challenge({ body }) {
      const payload = JSON.parse(body) as { type?: string; challenge?: string }
      return payload.type === 'url_verification' ? String(payload.challenge) : null
    },
    parse({ body }) {
      const payload = JSON.parse(body) as Record<string, any>
      const event = payload.event ?? {}
      if (payload.type !== 'event_callback' || event.type !== 'message') return []
      const self = (message: Record<string, any>) => message.bot_id !== undefined && (options.bot === undefined || message.bot_id === options.bot)
      if (event.subtype === 'message_changed' && event.message) {
        return [{ id: String(payload.event_id ?? `${event.channel}:${event.ts}`), author: String(event.message.user ?? 'unknown'), place: String(event.channel), self: self(event.message), kind: 'edit', thread: `${event.channel}:${event.message.thread_ts ?? event.message.ts}`, external: `${event.channel}:${event.message.ts}`, text: String(event.message.text ?? '') }]
      }
      if (event.subtype === 'message_deleted') {
        return [{ id: String(payload.event_id ?? `${event.channel}:${event.ts}`), author: String(event.previous_message?.user ?? 'unknown'), place: String(event.channel), self: false, kind: 'delete', thread: `${event.channel}:${event.previous_message?.thread_ts ?? event.deleted_ts}`, external: `${event.channel}:${event.deleted_ts}` }]
      }
      if (event.subtype !== undefined) return []
      const root = event.thread_ts === undefined || event.thread_ts === event.ts
      return [{
        id: String(payload.event_id ?? `${event.channel}:${event.ts}`),
        author: String(event.user ?? event.bot_id ?? 'unknown'),
        place: String(event.channel),
        self: event.bot_id !== undefined && (options.bot === undefined || event.bot_id === options.bot),
        kind: root ? 'root' : 'reply',
        thread: `${event.channel}:${event.thread_ts ?? event.ts}`,
        external: `${event.channel}:${event.ts}`,
        text: String(event.text ?? ''),
      }]
    },
    channelFor(place) {
      const to = options.channels[place]
      const channel = typeof to === 'string' ? to : to?.channel
      return channel ? channelPath(channel) : null
    },
    placeFor(channel) {
      for (const [id, to] of Object.entries(options.channels)) if ((typeof to === 'string' ? to : to.channel) === channel) return id
      return null
    },
    async update(external, text, _place, fetcher) {
      const [channel, ts] = external.split(':')
      await send(fetcher, `${options.api ?? 'https://slack.com/api'}/chat.update`, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel, ts, text }) })
    },
    async remove(external, _place, fetcher) {
      const [channel, ts] = external.split(':')
      await send(fetcher, `${options.api ?? 'https://slack.com/api'}/chat.delete`, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel, ts }) })
    },
    mirrors(place) {
      const to = options.channels[place]
      return options.token !== undefined && to !== undefined && !(typeof to === 'object' && to.mirror === false)
    },
    async deliver(message, target, fetcher) {
      const [channel, ts] = (target.threadExternal ?? target.place).split(':')
      const made = await send(fetcher, `${options.api ?? 'https://slack.com/api'}/chat.postMessage`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, thread_ts: ts, text: message.text }),
      })
      if (made.ok !== true) throw new Failure(`slack_${made.error ?? 'error'}`, `Slack refused the message: ${made.error ?? 'unknown'}.`)
      return { external: `${channel}:${made.ts}`, ...(target.threadExternal === null ? { thread: `${channel}:${made.ts}` } : {}) }
    },
  }
}
