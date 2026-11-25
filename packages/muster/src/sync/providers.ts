import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Failure } from '../failure.ts'
import { channelPath } from '../model.ts'
import { fetchFile, noteOut, refused, sizeOf, withLines } from './files.ts'
import { declared, type Resolved, type SyncOptions } from './declare.ts'
import { SEND_MS, type Inbound, type Provider, type Received, type Remote } from './types.ts'

const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const bad = () => new Failure('unauthorized', 'bad signature')
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'run'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g
/** The most labels and assignees a thread is filed under: a message holds 64 labels, and its own come too. */
const MOST_FILED = 40

/**
 * A platform's names (its labels, an item's assignees) as board labels under a prefix:
 * `tag.needs-review=needs review`. The key is the name cut down to what a label key may hold, the prefix
 * included; the value is the name in lowercase, so a filter written once matches however it was typed
 * there. A name with nothing a key can hold makes no label. Two names that make one key are one label,
 * the one that sorts first, so what a thread carries doesn't turn on the order a platform listed them in.
 */
function filed(prefix: string, names: unknown[]): [string, string][] {
  const out = new Map<string, string>()
  for (const name of names.filter((each): each is string => typeof each === 'string').sort()) {
    const key = name.toLowerCase().replace(/[^a-z0-9_.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64 - prefix.length)
    const value = name.replace(CONTROL, ' ').trim().toLowerCase().slice(0, 256)
    if (key && value && !out.has(prefix + key)) out.set(prefix + key, value)
  }
  return [...out]
}

/** What an item is filed under, tags before assignees, up to the most a thread takes. */
const filedUnder = (tags: unknown[], assignees: unknown[]) => Object.fromEntries([...filed('tag.', tags), ...filed('assignee.', assignees)].slice(0, MOST_FILED))

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

export type GitHubOptions = SyncOptions & {
  /** The app's own login, so its comments aren't imported back. */
  bot?: string
  /** A repo to a channel, or to a channel for issues and one for pulls. `mirror` sends board replies back. */
  repos: Record<string, string | { issues?: string; pulls?: string; mirror?: boolean }>
  api?: string
}

/**
 * GitHub: issues, pull requests and their comments come in as threads. Nothing goes back unless a repo mirrors.
 * `token` is one that may comment, needed only where a repo mirrors.
 */
export const github = (options: GitHubOptions): Provider => declared('github', options, githubWith)

function githubWith(options: Resolved<GitHubOptions>): Provider {
  // GitHub has no API that attaches a file to an issue or a comment: each file is named, and stays on the board.
  const named = (message: { text: string; attachments: { name: string; size: number }[] }, text: string) => withLines(text, message.attachments.map((file) => noteOut(`${file.name} (${sizeOf(file.size)})`, 'GitHub takes no uploads, it is on the board')))
  /**
   * An issue's or a pull request's labels and assignees, as GitHub lists them now. Every event about one
   * carries both whole, so the thread is made to say the same: `owns` is each list the item came with.
   */
  const filing = (item: Record<string, any>) => {
    const names = (list: unknown, field: string) => (Array.isArray(list) ? list.map((each) => each?.[field]) : [])
    return {
      labels: filedUnder(names(item.labels, 'name'), names(item.assignees, 'login')),
      owns: [...(Array.isArray(item.labels) ? ['tag.'] : []), ...(Array.isArray(item.assignees) ? ['assignee.'] : [])],
    }
  }
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
      labels: { kind: isPull ? 'pr' : 'issue', state: item.state === 'closed' ? (merged ? 'merged' : 'closed') : 'open', ref: thread, ...filing(item).labels },
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
        return [{ ...base, kind: 'root', thread, external: thread, text: `${item.title}\n\n${item.body ?? ''}`.trim(), labels: { kind: isPull ? 'pr' : 'issue', state: 'open', ref: thread, ...filing(item).labels } }]
      }
      // A comment or review on an issue the board never saw (opened before sync, or while the board was
      // down) carries the issue, so its thread can start from it. A board that has the thread ignores it.
      const withRoot = (events: Inbound[]): Inbound[] => {
        if (!item) return events
        const { author: opener, text, labels } = rootOf(repo, item, isPull, '')
        return events.map((event) => ({ ...event, parent: { author: opener, text: text ?? '', labels: labels ?? {} } }))
      }
      // A label or an assignee put on or taken off. The thread is filed as the item is now, and one the board
      // never saw starts from it.
      if ((kind === 'issues' || kind === 'pull_request') && ['labeled', 'unlabeled', 'assigned', 'unassigned'].includes(payload.action)) {
        return withRoot([{ ...base, kind: 'labels', thread, external: delivery, ...filing(item) }])
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
          // Its state now, and what it is filed under: a close, a merge or a label missed while down. Importing it
          // on a thread that already says so changes nothing.
          // The list doesn't say who closed, merged or labelled it, so it is put down to the sync, not to whoever opened it.
          const filedNow = filing(item)
          out.push({ ...root, author: '', self: false, ...(item.updated_at ? { at: String(item.updated_at) } : {}), id: `catchup:state:${repo}#${item.number}:${item.updated_at ?? ''}`, kind: 'labels', external: `catchup:state:${repo}#${item.number}:${item.updated_at ?? ''}`, labels: { state: root.labels!.state!, ...filedNow.labels }, owns: filedNow.owns })
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
        const made = await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${repo}/issues`, { method: 'POST', headers, body: JSON.stringify({ title: title!.slice(0, 250), body: named(message, rest.join('\n').trim()) }) })
        return { external: `${repo}#${made.number}`, thread: `${repo}#${made.number}`, labels: { kind: 'issue', state: 'open', ref: `${repo}#${made.number}` } }
      }
      const [repo, number] = target.threadExternal.split('#')
      const made = await send(fetcher, `${options.api ?? 'https://api.github.com'}/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'muster' },
        body: JSON.stringify({ body: named(message, message.text) }),
      })
      return { external: `comment:${made.id}` }
    },
  }
}

/** Catch-up reads at most this many pages of each list, of this many each: Linear limits requests and their cost. */
const LINEAR_CATCHUP_PAGES = 10
const LINEAR_CATCHUP_PAGE = 50

export type LinearOptions = SyncOptions & {
  /** The app's own user ID, so its comments aren't imported back. */
  bot?: string
  /** A team key to a channel. Two-way unless `mirror: false`. */
  teams: Record<string, string | { channel: string; mirror?: boolean }>
  api?: string
}

/** Linear: issues and comments come in as threads, and board replies go back as comments. */
export const linear = (options: LinearOptions): Provider => declared('linear', options, linearWith)

function linearWith(options: Resolved<LinearOptions>): Provider {
  const team = (place: string) => options.teams[place]
  /**
   * What an issue is filed under, as the webhook says it: its labels, its assignee, its priority and its
   * project. Linear leaves an empty assignee or project out rather than sending `null`, so one that is
   * missing with no ID either is empty, and one named by its ID alone is left as it was. Its labels are
   * the whole list when the payload has one, and none when it lists no label IDs.
   *
   * How a payload is read here, and the profile-handle pattern, follow `propertiesOf` and `handleOf` in
   * @vercel/board's `sync/linear.ts` (Apache-2.0, Copyright Vercel, Inc.).
   */
  const filing = (data: Record<string, any>): Required<Pick<Inbound, 'labels' | 'unset' | 'owns'>> => {
    const labels: Record<string, string> = {}
    const unset: string[] = []
    const owns: string[] = []
    const tags = Array.isArray(data.labels) ? data.labels.map((each: any) => each?.name) : Array.isArray(data.labelIds) && data.labelIds.length === 0 ? [] : null
    if (tags) owns.push('tag.')
    // A person's handle is the end of their profile URL; the name they show is the next best.
    const handle = data.assignee ? (/\/profiles\/([^/?#]+)/.exec(String(data.assignee.url ?? ''))?.[1] ?? data.assignee.displayName ?? data.assignee.name) : null
    if (data.assignee || !data.assigneeId) owns.push('assignee.')
    Object.assign(labels, filedUnder(tags ?? [], handle ? [handle] : []))
    const priority = ['', 'urgent', 'high', 'medium', 'low'][Number(data.priority)]
    if (priority) labels.priority = priority
    else if (data.priority === 0) unset.push('priority')
    const project = typeof data.project?.name === 'string' ? data.project.name.replace(CONTROL, ' ').trim().toLowerCase().slice(0, 256) : ''
    if (project) labels.project = project
    else if (!data.project && !data.projectId) unset.push('project')
    return { labels, unset, owns }
  }
  /** An issue as the API lists it, in the shape its webhook has: its labels are a list there, not a page of one. */
  const listed = (issue: Record<string, any>) => (Array.isArray(issue.labels?.nodes) ? { ...issue, labels: issue.labels.nodes } : issue)
  let organization: Promise<string> | undefined
  // A personal API key goes as it is; an OAuth token is a bearer token.
  const authorization = () => {
    const token = options.token!
    return token.startsWith('lin_api_') || /^bearer /i.test(token) ? token : `Bearer ${token}`
  }
  /** Files uploaded to Linear, as the markdown links its text carries. Links anywhere else are only text. */
  const uploads = (text: unknown): Remote[] | undefined => {
    const found = [...String(text ?? '').matchAll(/!?\[([^\]\n]*)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g)].map((match) => ({ url: match[2]!, name: match[1] || match[2]!.split('/').pop()! }))
    const once = found.filter((file, index) => found.findIndex((other) => other.url === file.url) === index)
    return once.length ? once : undefined
  }
  const postAs = (query: string, variables: unknown, fetcher: typeof fetch) => {
    return send(fetcher, options.api ?? 'https://api.linear.app/graphql', { method: 'POST', headers: { authorization: authorization(), 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
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
      labels: { kind: 'issue', ref: String(issue.identifier ?? ''), ...(issue.state?.name ? { state: slug(String(issue.state.name)) } : {}), ...filing(listed(issue)).labels },
      ...(uploads(issue.description) ? { files: uploads(issue.description)! } : {}),
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
      // When Linear says the issue or comment changed, not when it sent this: a retry is sent later, of the same change.
      const updated = typeof data.updatedAt === 'string' ? { updated: data.updatedAt } : {}
      if (payload.type === 'Issue' && payload.action === 'create') {
        const thread = `issue:${data.id}`
        return [{ id: delivery, author: String(data.creatorId ?? author), place: String(data.team?.key ?? ''), self, kind: 'root', thread, external: thread, text: `${data.title}\n\n${data.description ?? ''}`.trim(), labels: { kind: 'issue', ref: String(data.identifier ?? ''), ...(data.state?.name ? { state: slug(String(data.state.name)) } : {}), ...filing(data).labels }, ...(uploads(data.description) ? { files: uploads(data.description)! } : {}) }]
      }
      if (payload.type === 'Issue' && payload.action === 'update') {
        const filed = filing(data)
        // An update carries the whole issue, so one the board never saw (made before sync was set up) starts its
        // thread from it, as catching up would: by whoever opened it, filed as it is now. A board that has it ignores
        // this. Its description's uploads stay links: the update's own event would otherwise wait for them.
        const opener = typeof data.title === 'string' ? rootOf({ ...data, creator: data.creator ?? (data.creatorId ? { id: data.creatorId } : undefined) }, '') : null
        const parent = opener ? { parent: { author: opener.author, text: opener.text ?? '', labels: opener.labels ?? {} } } : {}
        return [{ id: delivery, author, place: String(data.team?.key ?? ''), self, kind: 'labels', thread: `issue:${data.id}`, external: delivery, ...filed, labels: { ...(data.state?.name ? { state: slug(String(data.state.name)) } : {}), ...filed.labels }, ...parent, ...updated }]
      }
      if (payload.type === 'Comment' && (payload.action === 'update' || payload.action === 'remove')) {
        return [{ id: delivery, author, place: String(data.issue?.team?.key ?? data.team?.key ?? ''), self, kind: payload.action === 'remove' ? 'delete' : 'edit', thread: `issue:${data.issueId ?? data.issue?.id}`, external: `comment:${data.id}`, ...(payload.action === 'update' ? { text: String(data.body ?? ''), ...updated } : {}) }]
      }
      if (payload.type === 'Comment' && payload.action === 'create') {
        // A comment on an issue the board never saw carries the issue's title, not its description or who opened it:
        // its thread starts from the title, put down to the sync, and the comment lands as its first reply.
        const issue = data.issue
        const parent = typeof issue?.title === 'string' ? { parent: { author: '', text: issue.title.trim(), labels: { kind: 'issue', ...(issue.identifier ? { ref: String(issue.identifier) } : {}) } } } : {}
        return [{ id: delivery, author, place: String(data.issue?.team?.key ?? data.team?.key ?? ''), self, kind: 'reply', thread: `issue:${data.issueId ?? data.issue?.id}`, external: `comment:${data.id}`, text: String(data.body ?? ''), ...(uploads(data.body) ? { files: uploads(data.body)! } : {}), ...parent, ...updated }]
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
    async download(file, fetcher, limit) {
      if (!options.token) throw refused('no token to fetch it with')
      // Linear lists no uploads for a comment, so a link is all there is, and anyone who can comment writes it. The
      // key fetches only what its own workspace holds: the first part of an upload's path is the workspace's ID.
      organization ??= send(fetcher, options.api ?? 'https://api.linear.app/graphql', { method: 'POST', headers: { authorization: authorization(), 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ organization { id } }' }) }).then((answer) => {
        const id = answer?.data?.organization?.id
        if (typeof id !== 'string' || !id) throw new Failure('platform_refused', 'Linear did not say which workspace the key is for.')
        return id
      })
      const workspace = await organization.catch((error) => {
        organization = undefined
        throw error
      })
      const path = URL.canParse(file.url) ? new URL(file.url).pathname.split('/')[1] : undefined
      if (path !== workspace) throw refused("not an upload of this board's Linear workspace")
      return fetchFile(fetcher, file.url, { hosts: ['uploads.linear.app'], headers: { authorization: authorization() }, limit })
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
      const issueFields = 'id identifier title description creator { id } team { key } state { name } priority assignee { id name displayName url } project { name } labels { nodes { name } } updatedAt'
      const changed = { updatedAt: { gt: since } }
      const issues = await read('issues', issueFields, { ...changed, team: { key: { in: keys } } })
      const comments = await read('comments', `id body updatedAt user { id } issue { ${issueFields} }`, { ...changed, issue: { team: { key: { in: keys } } } })
      const out: Inbound[] = []
      // Issues first, so a comment on one opened while the board was down lands in its thread.
      for (const issue of issues.nodes) {
        const root = rootOf(issue, `catchup:issue:${issue.id}`)
        out.push(root)
        // Its state now, and what it is filed under: a move or a label missed while down. Importing it on a thread
        // that already says so changes nothing. Linear doesn't say here who moved it, so it is put down to the sync, not to whoever opened the issue.
        if (root.labels?.state) {
          const filedNow = filing(listed(issue))
          out.push({ ...root, id: `catchup:state:${issue.id}:${issue.updatedAt ?? ''}`, author: '', self: false, ...(issue.updatedAt ? { at: String(issue.updatedAt), updated: String(issue.updatedAt) } : {}), kind: 'labels', external: `catchup:state:${issue.id}:${issue.updatedAt ?? ''}`, ...filedNow, labels: { state: root.labels.state, ...filedNow.labels } })
        }
      }
      for (const comment of comments.nodes) {
        if (!comment.issue?.id) continue
        // Each carries its issue: catch-up rows arrive together, and a comment may be imported before its issue's root.
        const { author, text, labels, place } = rootOf(comment.issue, '')
        const by = String(comment.user?.id ?? 'unknown')
        out.push({ id: `catchup:comment:${comment.id}`, author: by, place, self: options.bot !== undefined && by === options.bot, kind: 'reply', thread: `issue:${comment.issue.id}`, external: `comment:${comment.id}`, text: String(comment.body ?? ''), parent: { author, text: text ?? '', labels: labels ?? {} }, ...(uploads(comment.body) ? { files: uploads(comment.body)! } : {}), ...(comment.updatedAt ? { updated: String(comment.updatedAt) } : {}) })
      }
      // Cut short, the next catch-up starts where the list read least far got to; what both read again is known already.
      const cuts = [issues.cut, comments.cut].filter((cut) => cut !== undefined)
      return cuts.length ? { events: out, ...soonest(cuts) } : out
    },
    async deliver(message, target, fetcher, read) {
      const post = (query: string, variables: unknown) => postAs(query, variables, fetcher)
      // Each file is uploaded to Linear's storage first, then linked from the text. The upload URL is signed by
      // Linear and gets only the headers Linear gave for it, never the token.
      const lines: string[] = []
      for (const file of message.attachments) {
        const bytes = read(file.id)
        if (!bytes) {
          lines.push(noteOut(file.name, 'the board no longer has it'))
          continue
        }
        try {
          const made = await post('mutation($type: String!, $name: String!, $size: Int!) { fileUpload(contentType: $type, filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }', { type: file.type, name: file.name, size: bytes.length })
          const upload = made?.data?.fileUpload?.uploadFile
          // The bytes go only to Linear's storage, with only the storage's own headers from Linear's answer.
          const to = URL.canParse(String(upload?.uploadUrl)) ? new URL(String(upload.uploadUrl)) : null
          if (!to || to.protocol !== 'https:' || to.hostname !== 'storage.googleapis.com' || to.port !== '' || to.username !== '' || !String(upload.assetUrl).startsWith('https://uploads.linear.app/')) throw new Failure('platform_refused', 'Linear gave no upload URL.')
          const headers: Record<string, string> = { 'content-type': file.type, 'cache-control': 'public, max-age=31536000' }
          for (const { key, value } of upload.headers ?? []) if (/^(x-goog-[a-z0-9-]+|content-disposition)$/i.test(String(key))) headers[String(key).toLowerCase()] = String(value)
          const put = await fetcher(to.href, { method: 'PUT', headers, body: new Uint8Array(bytes), redirect: 'manual', signal: AbortSignal.timeout(SEND_MS) })
          if (!put.ok) throw new Failure(`platform_${put.status}`, `Linear's storage answered ${put.status}.`)
          lines.push(`${file.type.startsWith('image/') ? '!' : ''}[${file.name.replace(/[[\]\n]/g, '_')}](${upload.assetUrl})`)
        } catch {
          lines.push(noteOut(file.name, 'Linear did not take it'))
        }
      }
      if (target.threadExternal === null) {
        const found = await post('query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }', { key: target.place })
        const teamId = found?.data?.teams?.nodes?.[0]?.id
        if (!teamId) throw new Failure('platform_refused', `Linear has no team "${target.place}".`)
        const [title, ...rest] = message.text.split('\n')
        const made = await post('mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier state { name } } } }', { input: { teamId, title: title!.slice(0, 250), description: withLines(rest.join('\n').trim(), lines) } })
        const created = made?.data?.issueCreate?.issue
        const issue = created?.id
        if (!issue) throw new Failure('platform_refused', 'Linear did not make the issue.')
        const labels: Record<string, string> = { kind: 'issue', ...(created.identifier ? { ref: String(created.identifier) } : {}), ...(created.state?.name ? { state: slug(String(created.state.name)) } : {}) }
        return { external: `issue:${issue}`, thread: `issue:${issue}`, labels }
      }
      const made = await post('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }', { input: { issueId: target.threadExternal!.replace(/^issue:/, ''), body: withLines(message.text, lines) } })
      const id = made?.data?.commentCreate?.comment?.id
      if (!id) throw new Failure('platform_refused', 'Linear did not make the comment.')
      return { external: `comment:${id}` }
    },
  }
}

export type SlackOptions = SyncOptions & {
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
export const slack = (options: SlackOptions): Provider => declared('slack', options, slackWith)

function slackWith(options: Resolved<SlackOptions>): Provider {
  const now = options.now ?? (() => Date.now())
  const base = options.api ?? 'https://slack.com/api'
  /** The files on a message. One Slack only links to, or no longer offers, is named and not fetched. */
  const filesOf = (files: unknown): Remote[] | undefined => {
    if (!Array.isArray(files) || files.length === 0) return undefined
    return files.map((file: Record<string, any>) => {
      const url = String(file.url_private_download ?? file.url_private ?? '')
      const outside = file.mode === 'external' || file.is_external === true || file.filetype === 'remote'
      const skip = outside ? 'a link to somewhere outside Slack' : !url || file.mode === 'tombstone' || file.mode === 'hidden_by_limit' ? 'Slack does not offer it' : undefined
      return { url, id: String(file.id ?? ''), name: String(file.name ?? file.title ?? file.id ?? 'file'), ...(file.mimetype ? { type: String(file.mimetype) } : {}), ...(typeof file.size === 'number' ? { size: file.size } : {}), ...(skip ? { skip } : {}) }
    })
  }
  const isSelf = (message: Record<string, any>) => message.bot_id !== undefined && (options.bot === undefined || message.bot_id === options.bot)
  /** A Web API read. Slack says no with a 200 and `ok: false`, which is a failure here too, never "nothing new". */
  const api = async (fetcher: typeof fetch, method: string, query: Record<string, string>): Promise<SlackPage> => {
    const body = await send(fetcher, `${base}/${method}?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${options.token}` } })
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
    ...(filesOf(each.files) ? { files: filesOf(each.files)! } : {}),
  })
  // Joins, topic changes and replies also sent to the channel: what a webhook ignores, this does too.
  const isPlain = (each: Record<string, any>) => (each.subtype === undefined || each.subtype === 'file_share') && (each.thread_ts === undefined || each.thread_ts === each.ts)
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
        if (reply.ts !== parent.ts && fromTs(reply.ts) > from && (reply.subtype === undefined || reply.subtype === 'file_share')) out.push(inbound(channel, reply, parent.ts, opener))
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
      // A message with files is a `file_share`; any other subtype is Slack's own.
      if (event.subtype !== undefined && event.subtype !== 'file_share') return []
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
        ...(filesOf(event.files) ? { files: filesOf(event.files)! } : {}),
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
      await send(fetcher, `${base}/chat.update`, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel, ts, text }) })
    },
    async remove(external, _place, fetcher) {
      const [channel, ts] = external.split(':')
      await send(fetcher, `${base}/chat.delete`, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel, ts }) })
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
    async download(file, fetcher, limit) {
      if (!options.token) throw refused('no token to fetch it with')
      const got = await fetchFile(fetcher, file.url, { hosts: ['files.slack.com'], headers: { authorization: `Bearer ${options.token}` }, limit, ...(file.size !== undefined ? { size: file.size } : {}) })
      // A web page in place of a file that isn't one is likely Slack's sign-in page: the token can't read files.
      if ((got.type ?? '').startsWith('text/html') && !(file.type ?? '').startsWith('text/html')) throw refused('Slack sent a page, not the file: does the app have files:read?')
      if (file.size !== undefined && got.bytes.length !== file.size) throw refused(`Slack sent ${sizeOf(got.bytes.length)}, not the ${sizeOf(file.size)} it named`)
      return got
    },
    async deliver(message, target, fetcher, read) {
      const [channel, ts] = (target.threadExternal ?? target.place).split(':')
      const auth = { authorization: `Bearer ${options.token}` }
      // Each file's bytes go up first, so a retry never posts the text twice; they are shared into the thread last.
      const uploaded: { id: string; title: string }[] = []
      const lines: string[] = []
      for (const file of message.attachments) {
        const bytes = read(file.id)
        if (!bytes) {
          lines.push(noteOut(file.name, 'the board no longer has it'))
          continue
        }
        try {
          const got = await send(fetcher, `${base}/files.getUploadURLExternal`, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ filename: file.name, length: String(bytes.length) }).toString() })
          const to = new URL(String(got.upload_url ?? 'about:blank'))
          // The bytes go only to Slack's own file host.
          if (got.ok !== true || to.protocol !== 'https:' || to.hostname !== 'files.slack.com') throw new Failure('platform_refused', 'Slack gave no upload URL.')
          const put = await fetcher(to.href, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes), redirect: 'manual', signal: AbortSignal.timeout(SEND_MS) })
          if (!put.ok) throw new Failure(`platform_${put.status}`, `Slack answered ${put.status}.`)
          uploaded.push({ id: String(got.file_id), title: file.name })
        } catch {
          lines.push(noteOut(file.name, 'Slack did not take it'))
        }
      }
      const text = withLines(message.text, lines)
      const made = await send(fetcher, `${base}/chat.postMessage`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, thread_ts: ts, text }),
      })
      if (made.ok !== true) throw new Failure(`slack_${made.error ?? 'error'}`, `Slack refused the message: ${made.error ?? 'unknown'}.`)
      if (uploaded.length) {
        try {
          const shared = await send(fetcher, `${base}/files.completeUploadExternal`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ files: uploaded, channel_id: channel, thread_ts: ts ?? made.ts }) })
          if (shared.ok !== true) throw new Failure(`slack_${shared.error ?? 'error'}`, 'Slack did not share the files.')
        } catch {
          // The text is posted and is the record: it says which files didn't follow. Best effort.
          await send(fetcher, `${base}/chat.update`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel, ts: made.ts, text: withLines(text, uploaded.map((file) => noteOut(file.title, 'Slack did not take it'))) }) }).catch(() => undefined)
          uploaded.length = 0
        }
      }
      return { external: `${channel}:${made.ts}`, ...(target.threadExternal === null ? { thread: `${channel}:${made.ts}` } : {}), ...(uploaded.length ? { files: uploaded.map((file) => file.id) } : {}) }
    },
  }
}

/** Catch-up reads at most this many pages of each Notion database, of 100 each. */
const NOTION_CATCHUP_PAGES = 10
/** The most of a page a thread's first message holds: the rest is on Notion, a link away. */
const NOTION_TEXT_MAX = 9_000
/** Notion takes at most 2,000 characters in one rich text item, and 100 items in a comment. */
const NOTION_RICH_MAX = 2_000

export type NotionOptions = SyncOptions & {
  /** The integration's own bot user ID, so what it writes isn't imported back. */
  bot?: string
  /**
   * A Notion database to a board channel, by its data source ID (or, on an older workspace, the database's own ID),
   * with or without dashes. Two-way unless `mirror: false`.
   */
  databases: Record<string, string | { channel: string; mirror?: boolean }>
  api?: string
  /** The `Notion-Version` its API is asked with. */
  version?: string
}

/**
 * Notion: each page of a mapped database is a thread, its title and text the first message and its Status the
 * `state` label, and its comments are replies, both ways. Notion's webhooks say only what changed, so each event
 * is read from Notion's API on the ticker before it is imported. `secret` is the subscription's verification
 * token, which Notion signs every delivery with.
 */
export const notion = (options: NotionOptions): Provider => declared('notion', options, notionWith)

/** A Notion ID as one form: lowercase, without dashes, so a database named either way is the same one. */
const notionId = (id: unknown) => String(id ?? '').replace(/-/g, '').toLowerCase()

/** Where a Notion subscription's one-time verification token is written for the operator, and nowhere else. */
export const notionTokenFile = () => join(process.env.MUSTER_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'muster'), 'notion-verification-token')

function notionWith(options: Resolved<NotionOptions>): Provider {
  const api = (options.api ?? 'https://api.notion.com/v1').replace(/\/$/, '')
  const databases = new Map(Object.entries(options.databases).map(([id, to]) => [notionId(id), to]))
  const call = (fetcher: typeof fetch, path: string, init: { method?: string; body?: unknown } = {}) => {
    if (!options.token) throw new Failure('platform_refused', 'The Notion sync has no token to read Notion with.')
    return send(fetcher, `${api}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${options.token}`, 'notion-version': options.version ?? '2026-03-11', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  }
  const plain = (rich: unknown) => (Array.isArray(rich) ? rich.map((each: any) => String(each?.plain_text ?? each?.text?.content ?? '')).join('') : '')
  /** Text as Notion's rich text, in items it takes, as much of it as a comment can hold. */
  const rich = (text: string) => {
    const out: { text: { content: string } }[] = []
    for (let at = 0; at < text.length && out.length < 100; at += NOTION_RICH_MAX) out.push({ text: { content: text.slice(at, at + NOTION_RICH_MAX) } })
    return out.length ? out : [{ text: { content: ' ' } }]
  }
  /** The database a page is in, as this sync names it: its data source, or its database on an older workspace. */
  const placeOf = (page: Record<string, any>) => {
    const parent = page.parent ?? {}
    for (const id of [parent.data_source_id, parent.database_id]) if (id && databases.has(notionId(id))) return notionId(id)
    return null
  }
  const titleOf = (page: Record<string, any>) => {
    for (const property of Object.values(page.properties ?? {}) as any[]) if (property?.type === 'title') return plain(property.title).trim()
    return ''
  }
  /** Its Status, or a select called Status, as the thread's `state` label. */
  const stateOf = (page: Record<string, any>) => {
    for (const [name, property] of Object.entries(page.properties ?? {}) as [string, any][]) {
      const value = property?.type === 'status' ? property.status?.name : property?.type === 'select' && /^status$/i.test(name) ? property.select?.name : undefined
      if (typeof value === 'string' && value) return slug(value)
    }
    return undefined
  }
  const byOf = (who: any) => String(who?.id ?? '')
  const selfOf = (who: any) => options.bot !== undefined && who?.id !== undefined && notionId(who.id) === notionId(options.bot)
  /** A page as a thread's first message: its title, a blank line, its text as markdown, cut to what a message holds. */
  const pageText = async (page: Record<string, any>, fetcher: typeof fetch) => {
    const body = await call(fetcher, `/pages/${page.id}/markdown`).then((answer) => String(answer?.markdown ?? ''), () => '')
    const text = `${titleOf(page)}\n\n${body}`.trim()
    return text.length > NOTION_TEXT_MAX ? `${text.slice(0, NOTION_TEXT_MAX)}\n\n… the rest is on Notion: ${String(page.url ?? '')}` : text
  }
  const pageLabels = (page: Record<string, any>) => {
    const state = stateOf(page)
    return { kind: 'page', ...(typeof page.url === 'string' ? { ref: page.url.slice(0, 256) } : {}), ...(state ? { state } : {}) }
  }
  /** What a page is now, as the first message of a thread the board may not have yet. */
  const parentOf = async (page: Record<string, any>, fetcher: typeof fetch) => ({ author: byOf(page.created_by), text: await pageText(page, fetcher), labels: pageLabels(page) })
  const isVerification = (body: string) => {
    try {
      const parsed = JSON.parse(body)
      return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length === 1 && typeof parsed.verification_token === 'string' && /^secret_[A-Za-z0-9]{10,200}$/.test(parsed.verification_token)
    } catch {
      return false
    }
  }
  return {
    type: 'notion',
    verify({ headers, body }) {
      const signature = headers['x-notion-signature']
      // The one request Notion can't sign: the token it will sign with, sent once, to be pasted back into Notion.
      if (signature === undefined && isVerification(body)) return
      if (!same(signature ?? '', `sha256=${hmac(options.secret, body)}`)) throw bad()
    },
    challenge({ headers, body }) {
      if (headers['x-notion-signature'] !== undefined || !isVerification(body)) return null
      // Written for the operator alone, never answered or logged. Anyone can send one: a token Notion didn't send
      // fails when it is pasted into Notion's Verify, so check it there before using it as the secret.
      const file = notionTokenFile()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.parse(body).verification_token}\n`, { mode: 0o600 })
      return 'ok'
    },
    parse({ body }) {
      const payload = JSON.parse(body) as Record<string, any>
      const type = String(payload.type ?? '')
      const entity = payload.entity ?? {}
      const data = payload.data ?? {}
      const author = payload.authors?.[0]
      // Known by Notion's own ID for the event: a retry carries the same one.
      const base = { id: `notion:${payload.id}`, author: byOf(author), place: '', self: selfOf(author), unread: true as const, ...(typeof payload.timestamp === 'string' ? { updated: payload.timestamp } : {}) }
      const page = `page:${notionId(entity.id)}`
      if (type === 'page.created' || type === 'page.undeleted') return [{ ...base, kind: 'root', thread: page, external: page }]
      if (type === 'page.content_updated') return [{ ...base, kind: 'edit', thread: page, external: page }]
      if (type === 'page.properties_updated') return [{ ...base, kind: 'labels', thread: page, external: base.id }]
      if (type === 'page.deleted') return [{ ...base, kind: 'delete', thread: page, external: page }]
      if (type.startsWith('comment.') && data.page_id) {
        const kind = type === 'comment.created' ? 'reply' : type === 'comment.updated' ? 'edit' : type === 'comment.deleted' ? 'delete' : null
        if (kind) return [{ ...base, kind, thread: `page:${notionId(data.page_id)}`, external: `comment:${notionId(entity.id)}` }]
      }
      return []
    },
    async read(event, fetcher) {
      const pageId = event.thread.replace(/^page:/, '')
      const page = await call(fetcher, `/pages/${pageId}`)
      const place = placeOf(page)
      // A page in a database this sync doesn't map is none of the board's.
      if (place === null) return []
      const at = typeof page.last_edited_time === 'string' ? page.last_edited_time : event.updated
      const read: Inbound = { ...event, place, ...(at ? { updated: at } : {}) }
      // A delete is put down to when Notion sent it: nothing is left on Notion to say when it went.
      if (event.kind === 'delete') return [{ ...read, ...(event.updated ? { updated: event.updated } : {}) }]
      if (!event.external.startsWith('comment:')) {
        const text = await pageText(page, fetcher)
        if (event.kind === 'root') return [{ ...read, author: byOf(page.created_by), self: selfOf(page.created_by), text, labels: pageLabels(page) }]
        const parent = { parent: { author: byOf(page.created_by), text, labels: pageLabels(page) } }
        // Its text now, as an edit of the thread's first message, and its Status now, as a label. The edit carries no
        // time: it is what Notion says now, so it can't be older than what the board has, and the label, kept under the
        // same thread, is the one a late event must not undo.
        const { updated: _, ...untimed } = read
        return [
          { ...untimed, kind: 'edit', external: event.thread, author: byOf(page.last_edited_by), self: selfOf(page.last_edited_by), text, ...parent },
          { ...read, id: `${event.id}:labels`, kind: 'labels', external: `${event.id}:labels`, labels: pageLabels(page), ...parent },
        ]
      }
      const comment = await call(fetcher, `/comments/${event.external.replace(/^comment:/, '')}`)
      // A comment's own time, not its page's: an edit is newer than the comment it changes, whatever the page did.
      const changed = typeof comment.last_edited_time === 'string' ? comment.last_edited_time : event.updated
      return [{ ...read, ...(changed ? { updated: changed } : {}), author: byOf(comment.created_by), self: selfOf(comment.created_by), text: plain(comment.rich_text), parent: await parentOf(page, fetcher) }]
    },
    channelFor(place) {
      const to = databases.get(notionId(place))
      const channel = typeof to === 'string' ? to : to?.channel
      return channel ? channelPath(channel) : null
    },
    placeFor(channel) {
      for (const [id, to] of databases) if ((typeof to === 'string' ? to : to.channel) === channel) return id
      return null
    },
    mirrors(place) {
      const to = databases.get(notionId(place))
      return options.token !== undefined && to !== undefined && !(typeof to === 'object' && to.mirror === false)
    },
    async update(external, text, _place, fetcher) {
      if (!external.startsWith('comment:')) return
      await call(fetcher, `/comments/${external.slice('comment:'.length)}`, { method: 'PATCH', body: { rich_text: rich(text) } })
    },
    async remove(external, _place, fetcher) {
      if (!external.startsWith('comment:')) return
      await call(fetcher, `/comments/${external.slice('comment:'.length)}`, { method: 'DELETE' })
    },
    async catchUp(since, fetcher) {
      if (!options.token) return []
      const out: Inbound[] = []
      const cuts: { resume: string; skipped?: string }[] = []
      for (const id of databases.keys()) {
        const pages: Record<string, any>[] = []
        let cursor: string | undefined
        let more = false
        for (let read = 0; read < NOTION_CATCHUP_PAGES; read++) {
          const answer = await call(fetcher, `/data_sources/${id}/query`, { method: 'POST', body: { filter: { timestamp: 'last_edited_time', last_edited_time: { after: since } }, sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }], page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } })
          if (!Array.isArray(answer?.results)) throw new Failure('platform_refused', 'Notion did not list the database\'s pages.')
          pages.push(...answer.results.filter((each: any) => each?.object === 'page'))
          more = Boolean(answer.has_more && answer.next_cursor)
          if (!more) break
          cursor = String(answer.next_cursor)
        }
        for (const page of pages) {
          const pageId = notionId(page.id)
          const thread = `page:${pageId}`
          const text = await pageText(page, fetcher)
          const labels = pageLabels(page)
          const edited = String(page.last_edited_time ?? '')
          out.push({ id: `catchup:page:${pageId}`, author: byOf(page.created_by), place: id, self: selfOf(page.created_by), kind: 'root', thread, external: thread, text, labels })
          // Its text and Status now, in case it was there before and changed while the board was down.
          out.push({ id: `catchup:edit:${pageId}:${edited}`, author: '', place: id, kind: 'edit', thread, external: thread, text, ...(edited ? { updated: edited } : {}) })
          out.push({ id: `catchup:state:${pageId}:${edited}`, author: '', place: id, kind: 'labels', thread, external: `catchup:state:${pageId}:${edited}`, labels, ...(edited ? { at: edited, updated: edited } : {}) })
          const comments = await call(fetcher, `/comments?block_id=${page.id}&page_size=100`)
          for (const comment of Array.isArray(comments?.results) ? comments.results : []) {
            if (!(String(comment.created_time ?? '') > since)) continue
            out.push({ id: `catchup:comment:${notionId(comment.id)}`, author: byOf(comment.created_by), place: id, self: selfOf(comment.created_by), kind: 'reply', thread, external: `comment:${notionId(comment.id)}`, text: plain(comment.rich_text), parent: { author: byOf(page.created_by), text, labels }, ...(comment.last_edited_time ? { updated: String(comment.last_edited_time) } : {}) })
          }
        }
        if (more) cuts.push(cutShort(pages.map((page) => Date.parse(String(page.last_edited_time))), since, false, 0))
      }
      return cuts.length ? { events: out, ...soonest(cuts) } : out
    },
    async deliver(message, target, fetcher, read) {
      // Notion's file uploads aren't sent yet: each file is named in the text, and stays on the board.
      const lines = message.attachments.map((file) => (read(file.id) ? noteOut(file.name, 'the Notion sync sends no files yet') : noteOut(file.name, 'the board no longer has it')))
      if (target.threadExternal === null) {
        // A thread started on the board is a new page in the database, its first line the title.
        const source = await call(fetcher, `/data_sources/${target.place}`)
        const title = Object.entries(source?.properties ?? {}).find(([, property]: [string, any]) => property?.type === 'title')?.[0]
        if (!title) throw new Failure('platform_refused', 'Notion did not say which property is the database\'s title.')
        const [first, ...rest] = message.text.split('\n')
        const body = withLines(rest.join('\n').trim(), lines)
        const made = await call(fetcher, '/pages', { method: 'POST', body: { parent: { data_source_id: target.place }, properties: { [title]: { title: rich(first!.slice(0, NOTION_RICH_MAX)) } }, children: body ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: rich(body) } }] : [] } })
        if (!made?.id) throw new Failure('platform_refused', 'Notion did not make the page.')
        const thread = `page:${notionId(made.id)}`
        return { external: thread, thread, labels: pageLabels(made) }
      }
      const made = await call(fetcher, '/comments', { method: 'POST', body: { parent: { page_id: target.threadExternal.replace(/^page:/, '') }, rich_text: rich(withLines(message.text, lines)) } })
      if (!made?.id) throw new Failure('platform_refused', 'Notion did not make the comment.')
      return { external: `comment:${notionId(made.id)}` }
    },
  }
}
