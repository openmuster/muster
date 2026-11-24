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

/** GitHub catch-up reads at most this many pages of 100 of each list per repo. */
const GITHUB_CATCHUP_PAGES = 10

/** Past a catch-up's page cap, how many more pages it reads while all of it changed at one time. */
const CATCHUP_EXTRA_PAGES = 5

/** Of several lists cut short, the next catch-up starts where the one read least far got to. */
const soonest = (cuts: { resume: string; skipped?: string }[]) => {
  const first = [...cuts].sort((a, b) => Date.parse(a.resume) - Date.parse(b.resume))[0]!
  const skipped = cuts.flatMap((cut) => (cut.skipped ? [cut.skipped] : []))
  return { resume: first.resume, ...(skipped.length ? { skipped: skipped.sort()[0]! } : {}) }
}

const newestOf = (times: number[]) => Math.max(...times.filter((time) => !Number.isNaN(time)))

/**
 * Where the next catch-up starts after one cut short, given when the changes it read were made. It goes back to
 * the newest of them, so others made at that same time are read again, not skipped. Unless that is no later than
 * where this one started: then so many changed at one time that reading them again would never move on, so it
 * goes past that time and says so (`skipped`). A platform whose `since` takes what changed at that time
 * (`inclusive`) has times to the second (`step`).
 */
function cutShort(times: number[], since: string, inclusive: boolean, step: number): { resume: string; skipped?: string } {
  const newest = newestOf(times)
  const again = inclusive ? newest : newest - 1
  if (again > Date.parse(since)) return { resume: new Date(again).toISOString() }
  return { resume: new Date(newest + (inclusive ? step : 0)).toISOString(), skipped: new Date(newest).toISOString() }
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
      const cuts: { resume: string; skipped?: string }[] = []
      const when = (list: any[]) => list.map((each) => Date.parse(String(each.updated_at)))
      /**
       * A list oldest change first, up to the page cap. Each page after the first is asked for from the newest change
       * read so far, not by its number: something changed during the read moves to the end, not past a page already
       * read. Only a whole page changed in the same second goes by number, and that may run a few pages past the cap.
       */
      const read = async (path: string) => {
        const out: any[] = []
        let from = since
        let page = 1
        for (let asked = 1; asked <= GITHUB_CATCHUP_PAGES + CATCHUP_EXTRA_PAGES; asked++) {
          if (asked > GITHUB_CATCHUP_PAGES && page === 1) break
          const got = (await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${path}since=${encodeURIComponent(from)}&sort=updated&direction=asc&per_page=100&page=${page}`, { headers })) as any[]
          // Not a list is not "nothing changed": refused, the next catch-up asks from the same point.
          if (!Array.isArray(got)) throw new Failure('platform_refused', 'GitHub did not answer with a list.')
          out.push(...got)
          if (got.length < 100) return out
          const newest = newestOf(when(got))
          if (!Number.isFinite(newest)) throw new Failure('platform_refused', 'GitHub listed changes without when they were made.')
          if (newest > Date.parse(from)) {
            from = new Date(newest).toISOString()
            page = 1
          } else page++
        }
        cuts.push(cutShort(when(out), since, true, 1000))
        return out
      }
      for (const repo of Object.keys(options.repos)) {
        // Issues and pull requests first, so a comment on one opened while the board was down lands in its thread.
        const items = await read(`${repo}/issues?state=all&`)
        const parents = new Map<string, Inbound['parent']>()
        for (const item of items) {
          const isPull = item.pull_request !== undefined
          const root = rootOf(repo, item, isPull, `catchup:issue:${repo}#${item.number}`)
          out.push(root)
          parents.set(String(item.number), { author: root.author, text: root.text ?? '', labels: root.labels ?? {} })
          // Its state now: a close or a merge missed while down. Importing it on a thread that already says so changes nothing.
          // The list doesn't say who closed or merged it, so it is put down to the sync, not to whoever opened it.
          out.push({ ...root, author: '', self: false, ...(item.updated_at ? { at: String(item.updated_at) } : {}), id: `catchup:state:${repo}#${item.number}:${item.updated_at ?? ''}`, kind: 'labels', external: `catchup:state:${repo}#${item.number}:${item.updated_at ?? ''}`, labels: { state: root.labels!.state! } })
        }
        const comments = await read(`${repo}/issues/comments?`)
        for (const comment of comments) {
          const number = String(comment.issue_url ?? '').split('/').pop()
          const isPull = String(comment.html_url ?? '').includes('/pull/')
          const parent = parents.get(number ?? '')
          out.push({ id: `catchup:comment:${comment.id}`, author: String(comment.user?.login ?? 'unknown'), place: `${repo}|${isPull ? 'pulls' : 'issues'}`, self: options.bot !== undefined && comment.user?.login === options.bot, kind: 'reply', thread: `${repo}#${number}`, external: `comment:${comment.id}`, text: String(comment.body ?? ''), ...(parent ? { parent } : {}) })
        }
      }
      // Cut short, the next catch-up starts where the list read least far got to; what is read again is known already.
      return cuts.length ? { events: out, ...soonest(cuts) } : out
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

/** Catch-up reads at most this many pages of each list, of this many each: Linear limits requests and their cost. */
const LINEAR_CATCHUP_PAGES = 10
const LINEAR_CATCHUP_PAGE = 50

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
  const postAs = (query: string, variables: unknown, fetcher: typeof fetch) => {
    // A personal API key goes as it is; an OAuth token is a bearer token.
    const token = options.token!
    const authorization = token.startsWith('lin_api_') || /^bearer /i.test(token) ? token : `Bearer ${token}`
    return send(fetcher, options.api ?? 'https://api.linear.app/graphql', { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
  }
  /** An issue as a thread's first message, as its webhook would have brought it, in the state it is in now. */
  const rootOf = (issue: Record<string, any>, id: string): Inbound => {
    const thread = `issue:${issue.id}`
    const author = String(issue.creator?.id ?? 'unknown')
    return {
      id,
      author,
      place: String(issue.team?.key ?? ''),
      self: options.bot !== undefined && author === options.bot,
      kind: 'root',
      thread,
      external: thread,
      text: `${issue.title ?? ''}\n\n${issue.description ?? ''}`.trim(),
      labels: { kind: 'issue', ref: String(issue.identifier ?? ''), ...(issue.state?.name ? { state: slug(String(issue.state.name)) } : {}) },
    }
  }
  return {
    type: 'linear',
    verify({ headers, body }) {
      if (!same(headers['linear-signature'] ?? '', hmac(options.secret, body))) throw bad()
    },
    parse({ body }) {
      const payload = JSON.parse(body) as Record<string, any>
      const data = payload.data ?? {}
      // Known by what Linear signed, as a GitHub delivery is: the `linear-delivery` header isn't signed, so an
      // old body sent again under a new one would otherwise be news, and set a thread's state back.
      const delivery = `lin:${hmac('id', body).slice(0, 32)}`
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
    async catchUp(since, fetcher) {
      if (!options.token) return []
      const keys = Object.keys(options.teams)
      if (keys.length === 0) return []
      const refused = (field: string, answer: any) => new Failure('platform_refused', `Linear did not list ${field}: ${String(answer?.errors?.[0]?.message ?? 'no data').slice(0, 200)}`)
      /**
       * Reads a list oldest change first, up to the page cap. A call that fails throws, and the board asks again
       * from the same point. Issues sort that way; comments can't be sorted, and Linear lists them newest first,
       * so they are read from the end backwards. Cut short, it says where the next catch-up starts: the newest
       * change it read, less a millisecond, so one made in that same millisecond is read again, not skipped.
       */
      const read = async (field: 'issues' | 'comments', nodes: string, filter: Record<string, unknown>): Promise<{ nodes: Record<string, any>[]; cut?: { resume: string; skipped?: string } }> => {
        const type = field === 'issues' ? 'IssueFilter' : 'CommentFilter'
        const list = async (variables: Record<string, unknown>, args: string, page: string) => {
          const answer = await postAs(`query($filter: ${type}, $cursor: String) { ${field}(filter: $filter, ${args}) { nodes { ${nodes} } pageInfo { ${page} } } }`, variables, fetcher)
          const got = answer?.data?.[field]
          // Linear can answer 200 with errors and no data, a rate limit among them: that is a failure, not "nothing changed".
          if (!got || !Array.isArray(got.nodes)) throw refused(field, answer)
          return got
        }
        const out: Record<string, any>[] = []
        let cursor: string | null = null
        let more = false
        const when = (list: Record<string, any>[]) => list.map((node) => Date.parse(String(node.updatedAt)))
        const from = Date.parse((filter.updatedAt as { gt: string }).gt)
        // Past the cap, on only while all of it changed in the same millisecond, so the next start couldn't move on.
        for (let page = 0; page < LINEAR_CATCHUP_PAGES + CATCHUP_EXTRA_PAGES; page++) {
          if (page >= LINEAR_CATCHUP_PAGES && newestOf(when(out)) - 1 > from) break
          const got: any =
            field === 'issues'
              ? await list({ filter, cursor }, `first: ${LINEAR_CATCHUP_PAGE}, after: $cursor, sort: [{ updatedAt: { order: Ascending } }]`, 'hasNextPage endCursor')
              : await list({ filter, cursor }, `last: ${LINEAR_CATCHUP_PAGE}, before: $cursor, orderBy: updatedAt`, 'hasPreviousPage startCursor')
          out.push(...got.nodes)
          const next = field === 'issues' ? [got.pageInfo?.hasNextPage, got.pageInfo?.endCursor] : [got.pageInfo?.hasPreviousPage, got.pageInfo?.startCursor]
          more = Boolean(next[0] && next[1])
          if (!more) break
          cursor = String(next[1])
        }
        if (!more || out.length === 0) return { nodes: out }
        const times = out.map((node) => Date.parse(String(node.updatedAt))).filter((time) => !Number.isNaN(time))
        if (times.length !== out.length) throw new Failure('platform_refused', `Linear listed ${field} without when they changed.`)
        // What was read must be the oldest changes: if anything older is left, the order isn't what this read assumed,
        // and moving on would skip it. Refused, the next start asks again from the same point.
        const older = await list({ filter: { ...filter, updatedAt: { gt: (filter.updatedAt as { gt: string }).gt, lt: new Date(Math.min(...times)).toISOString() } }, cursor: null }, 'first: 1', 'hasNextPage')
        if (older.nodes.length > 0) throw new Failure('platform_refused', `Linear did not list ${field} oldest first.`)
        return { nodes: out, cut: cutShort(times, (filter.updatedAt as { gt: string }).gt, false, 0) }
      }
      const issueFields = 'id identifier title description creator { id } team { key } state { name } updatedAt'
      const changed = { updatedAt: { gt: since } }
      const issues = await read('issues', issueFields, { ...changed, team: { key: { in: keys } } })
      const comments = await read('comments', `id body updatedAt user { id } issue { ${issueFields} }`, { ...changed, issue: { team: { key: { in: keys } } } })
      const out: Inbound[] = []
      // Issues first, so a comment on one opened while the board was down lands in its thread.
      for (const issue of issues.nodes) {
        const root = rootOf(issue, `catchup:issue:${issue.id}`)
        out.push(root)
        // Its state now: a move missed while down. Importing it on a thread that already says so changes nothing.
        // Linear doesn't say here who moved it, so it is put down to the sync, not to whoever opened the issue.
        if (root.labels?.state) out.push({ ...root, id: `catchup:state:${issue.id}:${issue.updatedAt ?? ''}`, author: '', self: false, ...(issue.updatedAt ? { at: String(issue.updatedAt) } : {}), kind: 'labels', external: `catchup:state:${issue.id}:${issue.updatedAt ?? ''}`, labels: { state: root.labels.state } })
      }
      for (const comment of comments.nodes) {
        if (!comment.issue?.id) continue
        // Each carries its issue: catch-up rows arrive together, and a comment may be imported before its issue's root.
        const { author, text, labels, place } = rootOf(comment.issue, '')
        const by = String(comment.user?.id ?? 'unknown')
        out.push({ id: `catchup:comment:${comment.id}`, author: by, place, self: options.bot !== undefined && by === options.bot, kind: 'reply', thread: `issue:${comment.issue.id}`, external: `comment:${comment.id}`, text: String(comment.body ?? ''), parent: { author, text: text ?? '', labels: labels ?? {} } })
      }
      // Cut short, the next catch-up starts where the list read least far got to; what both read again is known already.
      const cuts = [issues.cut, comments.cut].filter((cut) => cut !== undefined)
      return cuts.length ? { events: out, ...soonest(cuts) } : out
    },
    async deliver(message, target, fetcher) {
      const post = (query: string, variables: unknown) => postAs(query, variables, fetcher)
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

/**
 * Requests one catch-up tick makes for what was posted while down, shared by the mapped channels, each getting at
 * least three. Ticks come a minute apart while a read is cut short: Slack allows an app made for its own
 * workspace 50 or more of these a minute.
 */
const SLACK_REQUESTS = 24
/** Threads started before the downtime, among the 200 messages before it, whose new replies a tick reads per channel. */
const SLACK_OLD_THREADS = 2
/** How far back from its start a catch-up looks for those threads. */
const SLACK_LOOKBACK_US = 7 * 24 * 3600 * 1_000_000
/** History is read oldest first, a stretch of time at a time: this long to begin with, longer while quiet. */
const SLACK_WINDOW_US = 30 * 60 * 1_000_000
/** The shortest stretch. One busier than a tick can read is gone past, and said to be. */
const SLACK_MIN_WINDOW_US = 60 * 1_000_000
/** Pages a stretch longer than the shortest may take before it is read as shorter ones. */
const SLACK_STRETCH_PAGES = 2

/** A Slack ts, `1700000000.000100`, as whole microseconds, and back. */
const fromTs = (ts: string) => {
  const [seconds = '0', fraction = ''] = String(ts).split('.')
  return Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, '0').slice(0, 6))
}
const toTs = (us: number) => `${Math.floor(us / 1_000_000)}.${String(us % 1_000_000).padStart(6, '0')}`

type SlackPage = { messages?: Record<string, any>[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }

/** Slack: messages in mapped channels come in as threads, and board replies go back into the Slack thread. */
export function slack(options: SlackOptions): Provider {
  const now = options.now ?? (() => Date.now())
  const isSelf = (message: Record<string, any>) => message.bot_id !== undefined && (options.bot === undefined || message.bot_id === options.bot)
  /** A Web API read. Slack says no with a 200 and `ok: false`, which is a failure here too, never "nothing new". */
  const api = async (fetcher: typeof fetch, method: string, query: Record<string, string>): Promise<SlackPage> => {
    const body = await send(fetcher, `${options.api ?? 'https://slack.com/api'}/${method}?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${options.token}` } })
    if (body.ok !== true) throw new Failure(`slack_${body.error ?? 'error'}`, `Slack refused ${method}: ${body.error ?? 'unknown'}.`)
    return body as SlackPage
  }
  /** A message read back, as the webhook for it would have made it. */
  const inbound = (channel: string, each: Record<string, any>, thread: string, parent?: Inbound['parent']): Inbound => ({
    id: `catchup:${channel}:${each.ts}`,
    author: String(each.user ?? each.bot_id ?? 'unknown'),
    place: channel,
    self: isSelf(each),
    kind: thread === each.ts ? 'root' : 'reply',
    thread: `${channel}:${thread}`,
    external: `${channel}:${each.ts}`,
    text: String(each.text ?? ''),
    ...(parent ? { parent } : {}),
  })
  // Joins, topic changes and replies also sent to the channel: what a webhook ignores, this does too.
  const isPlain = (each: Record<string, any>) => each.subtype === undefined && (each.thread_ts === undefined || each.thread_ts === each.ts)
  /** Whether a thread may have had replies after a point. A parent that doesn't say when its last came is read to find out. */
  const repliedAfter = (each: Record<string, any>, from: number) => Number(each.reply_count) > 0 && (each.latest_reply === undefined || fromTs(each.latest_reply) > from)
  /** A thread's replies after a point, oldest first, in up to `pages` requests; `done` is false if there were more. */
  const repliesOf = async (fetcher: typeof fetch, channel: string, parent: Record<string, any>, from: number, pages: number) => {
    // A reply whose thread the board never saw starts it from the thread's first message.
    const opener = isSelf(parent) ? undefined : { author: String(parent.user ?? parent.bot_id ?? 'unknown'), text: String(parent.text ?? ''), labels: {} }
    const out: Inbound[] = []
    let cursor = ''
    let used = 0
    while (used < pages) {
      const got = await api(fetcher, 'conversations.replies', { channel, ts: parent.ts, oldest: toTs(from), limit: '200', ...(cursor ? { cursor } : {}) })
      used++
      for (const reply of got.messages ?? []) {
        if (reply.ts !== parent.ts && fromTs(reply.ts) > from && reply.subtype === undefined) out.push(inbound(channel, reply, parent.ts, opener))
      }
      cursor = got.has_more ? (got.response_metadata?.next_cursor ?? '') : ''
      if (!cursor) return { events: out, used, done: true }
    }
    return { events: out, used, done: false }
  }
  /**
   * What was posted in a stretch of time, and the replies in threads started in it, in up to `pages` history pages
   * and `budget` requests in all. Not `done` when there was more: what it did read is kept in `events`, newest
   * history first if it was the history that ran over.
   */
  const stretch = async (fetcher: typeof fetch, channel: string, lo: number, hi: number, from: number, pages: number, budget: number) => {
    const messages: Record<string, any>[] = []
    let cursor = ''
    let used = 0
    let done = true
    for (;;) {
      // From lo up to hi, not including it: Slack leaves out both ends, and a ts is a whole microsecond.
      const got = await api(fetcher, 'conversations.history', { channel, oldest: toTs(lo - 1), latest: toTs(hi), limit: '200', ...(cursor ? { cursor } : {}) })
      used++
      messages.push(...(got.messages ?? []))
      cursor = got.has_more ? (got.response_metadata?.next_cursor ?? '') : ''
      if (!cursor) break
      if (used >= Math.min(pages, budget)) {
        done = false
        break
      }
    }
    const historyPages = used
    // Ran over, and not to be kept: read as shorter stretches instead.
    if (!done && used < budget) return { events: [], used, pages: historyPages, done }
    messages.sort((a, b) => fromTs(a.ts) - fromTs(b.ts))
    const events: Inbound[] = []
    for (const each of messages) {
      if (!isPlain(each)) continue
      events.push(inbound(channel, each, each.ts))
      if (!repliedAfter(each, from)) continue
      if (used >= budget) {
        done = false
        continue
      }
      const replies = await repliesOf(fetcher, channel, each, from, budget - used)
      used += replies.used
      events.push(...replies.events)
      if (!replies.done) done = false
    }
    return { events, used, pages: historyPages, done }
  }
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
    /**
     * Each mapped channel's history since a point, oldest first, and the new replies in its threads. A tick that
     * stops short says where the next goes on from: the channel furthest behind. Each channel moves on at least
     * the shortest stretch a tick, so a read never stalls: one busier than that is gone past, and said to be.
     * Replies in threads started before the point are read for a few threads, best effort. A refusal, a rate
     * limit included, throws: the board asks again from the same point later.
     */
    async catchUp(since, fetcher) {
      if (!options.token) return []
      const channels = Object.keys(options.channels)
      const start = Date.parse(since) * 1000
      const end = now() * 1000
      const events: Inbound[] = []
      let resume = end
      let skipped: number | undefined
      for (const channel of channels) {
        const before = await api(fetcher, 'conversations.history', { channel, oldest: toTs(Math.max(0, start - SLACK_LOOKBACK_US)), latest: toTs(start), limit: '200' })
        for (const parent of (before.messages ?? []).filter((each) => isPlain(each) && repliedAfter(each, start)).slice(0, SLACK_OLD_THREADS)) {
          events.push(...(await repliesOf(fetcher, channel, parent, start, 1)).events)
        }
        let lo = start
        let width = SLACK_WINDOW_US
        let budget = Math.max(3, Math.floor(SLACK_REQUESTS / channels.length))
        let moved = false
        while (lo < end && budget > 0) {
          // The last request or two of a tick that hasn't moved this channel on read the shortest stretch, whatever it holds.
          if (!moved && budget <= 2) width = SLACK_MIN_WINDOW_US
          const shortest = width <= SLACK_MIN_WINDOW_US
          const hi = Math.min(lo + width, end)
          // Two requests are kept back for that, until it has moved on.
          const read = await stretch(fetcher, channel, lo, hi, start, shortest ? budget : SLACK_STRETCH_PAGES, shortest || moved ? budget : budget - 2)
          budget -= read.used
          if (read.done || shortest) {
            if (!read.done) skipped = Math.min(skipped ?? lo, lo)
            events.push(...read.events)
            lo = hi
            moved = true
            if (read.done && read.pages === 1) width *= 2
            continue
          }
          width = Math.max(SLACK_MIN_WINDOW_US, Math.floor(width / 4))
        }
        resume = Math.min(resume, lo)
      }
      if (resume >= end && skipped === undefined) return events
      const at = (point: number) => new Date(Math.floor(point / 1000)).toISOString()
      return { events, resume: at(resume), ...(skipped !== undefined ? { skipped: at(skipped) } : {}) }
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
