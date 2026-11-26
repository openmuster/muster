import { createHash, randomBytes } from 'node:crypto'
import { Failure } from '../failure.ts'
import { BRANCH, CLONE_HOSTS, INSTALL, SHA, bare, memoryBases, shellQuote, type BaseRecord, type CloudRun, type CloudRunner, type VercelRule } from './cloud.ts'
import { PLACEHOLDER, boardPolicy } from './policy.ts'

/**
 * A sandbox's way out, as E2B takes it. A rule is for a host and can only add headers to what goes to
 * it: there is no matching a path or a method, and no answering a request. So what a credential may be
 * used for on its host is not decided here, and has to be decided by whoever takes it.
 */
export type E2bNetwork = { allowOut?: string[]; denyOut?: string[]; rules?: Record<string, { transform: { headers: Record<string, string> } }[]> }

/** A command that ended, or one still running that can be waited on. A command that exits with anything but 0 is thrown, not returned. */
type E2bResult = { exitCode?: number; stdout?: string }
type E2bHandle = E2bResult & { pid?: number; wait?(): Promise<E2bResult> }

/** A sandbox as the `e2b` package hands it back. */
export type E2bMade = {
  sandboxId: string
  commands: {
    run(cmd: string, options?: { cwd?: string; envs?: Record<string, string>; user?: string; timeoutMs?: number; background?: boolean }): Promise<E2bHandle>
    /** A command that is still running, by its process ID, to wait on again after a connection to it was lost. */
    connect?(pid: number, options?: { timeoutMs?: number }): Promise<E2bHandle>
  }
  files: { read(path: string, options: { format: 'stream' }): Promise<AsyncIterable<Uint8Array>> }
  /** Replaces the whole of the sandbox's way out: what is left out is cleared. */
  updateNetwork(network: E2bNetwork): Promise<unknown>
  /** Keeps the sandbox as it is now, to start others from. */
  createSnapshot?(): Promise<{ snapshotId: string }>
  kill(): Promise<unknown>
}

/** How the SDK is told which account, and which E2B: its own cloud, or one you run. */
export type E2bConnection = { apiKey: string; domain?: string }

/** The part of the `e2b` package this runner uses, so it can be handed the real one or a stand-in. */
export type E2bSdk = {
  Sandbox: {
    /** A new sandbox from a template, or from a snapshot by its ID: either way with its own environment and way out. */
    create(template: string, options: E2bConnection & { envs: Record<string, string>; timeoutMs: number; network: E2bNetwork; metadata?: Record<string, string> }): Promise<E2bMade>
    deleteSnapshot?(snapshotId: string, options: E2bConnection): Promise<unknown>
  }
  Secret: {
    create(name: string, value: string, options: E2bConnection & { metadata?: Record<string, string> }): Promise<unknown>
    destroy(name: string, options: E2bConnection): Promise<unknown>
    list(options: E2bConnection): { hasNext: boolean; nextItems(): Promise<{ name: string; createdAt: Date | string; metadata?: Record<string, string> }[]> }
    /** What stands for a stored secret in a header: E2B puts the value in its place on the way out. */
    fill(name: string): string
  }
}

const EVERYWHERE = '0.0.0.0/0'
/** Nothing gets out. */
const CLOSED: E2bNetwork = { denyOut: [EVERYWHERE] }
/** E2B lets a sandbox reach this many hosts by name. */
export const E2B_HOSTS_MAX = 10
/** How long a sandbox lives when nobody said: E2B's own default is five minutes, which no run fits in. */
const DEFAULT_LIFETIME_MS = 40 * 60_000
/** A secret this runner made is removed with its run. One older than this was left by a run that never got to. */
export const E2B_SECRET_KEEP_MS = 26 * 60 * 60_000
const SECRET_PREFIX = 'muster-'
/** Where E2B puts the certificate for the connections it reads, to add a credential to them. Nothing sets these for a program. */
const CA = '/etc/ssl/certs/ca-certificates.crt'
const CA_ENV = { NODE_EXTRA_CA_CERTS: CA, SSL_CERT_FILE: CA, GIT_SSL_CAINFO: CA, CURL_CA_BUNDLE: CA, REQUESTS_CA_BUNDLE: CA }
const MINUTE = 60_000
/** What a finished base holds: one whose making was cut short has no such file. */
const BASE_READY = '/opt/.muster-base-ready'

/**
 * Every process in the sandbox, as its ID and when it started: what is running before anything of a
 * repository's has. A process ID is used again once its process is gone, and a start time is not.
 */
export const PROCESSES = `for p in /proc/[0-9]*; do s=$(sed 's/.*) //' "$p/stat" 2>/dev/null) || continue; set -- $s; [ -n "\${20}" ] && echo "\${p#/proc/} \${20}"; done`

/**
 * Ends every process that isn't in $MU_KEEP, as root. Closing a sandbox's way out on E2B refuses new
 * connections and leaves the open ones open, so a process left behind by an install could go on talking to
 * wherever it had reached. Its last line is how many are left that it couldn't end.
 */
export const REAP = `left=0
for round in 1 2 3 4 5; do
  left=0
  for p in /proc/[0-9]*; do
    pid=\${p#/proc/}
    s=$(sed 's/.*) //' "$p/stat" 2>/dev/null) || continue
    set -- $s
    [ -n "\${20}" ] || continue
    # This shell, what started it, and the kernel's own threads.
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    [ "$pid" = 2 ] || [ "$2" = 2 ] && continue
    printf '%s\\n' "$MU_KEEP" | grep -qxF "$pid \${20}" && continue
    # What this loop itself started is gone by the time it is looked at again.
    kill -9 "$pid" 2>/dev/null && left=$((left + 1))
  done
  [ "$left" = 0 ] && break
  sleep 0.3
done
echo "left $left"`

/** The exit code of a command the SDK threw for exiting with one, or undefined for anything else it threw. */
const exitOf = (error: unknown): number | undefined => {
  const code = (error as { exitCode?: unknown } | null)?.exitCode
  return typeof code === 'number' ? code : undefined
}

/** Whether a token is marked as one for a sandbox. Read unverified: the board verifies it, and this is about what the board would hold it to. */
function forSandbox(token: string): boolean {
  try {
    return (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sandbox?: unknown }).sandbox === true
  } catch {
    return false
  }
}

/**
 * Runs an agent in an E2B sandbox. The board's token and the model's key are stored with E2B as secrets
 * for the length of the run, and E2B adds them to the sandbox's requests on the way out, so the agent's
 * environment holds placeholders. E2B adds a credential to every request to its host, whatever the path:
 * the board therefore has to hold the token to a sandbox's routes itself (a token made with `sandbox`),
 * and a model key can be used for anything its provider's API offers, which is asked for by name.
 *
 * `setupHosts` are open while the setup commands run, which are ours, and closed before the agent
 * starts. `allowHosts` stay open to the agent, so each one is a way out of the sandbox: add few.
 *
 * With `base`, the setup runs once per template and version of it: its result is kept as a snapshot, with no
 * credential, repository or environment in it, and each run starts from that. A run uses only a snapshot
 * written down in `bases`, which this machine made.
 */
export function e2b(options: { sdk: E2bSdk; apiKey: string; domain?: string; template: string; allowHosts?: string[]; setupHosts?: string[]; keyAnyPath?: boolean; modelSecret?: string; base?: boolean; bases?: BaseRecord; now?: () => number }): CloudRunner {
  const { Sandbox, Secret } = options.sdk
  const connection: E2bConnection = { apiKey: options.apiKey, ...(options.domain ? { domain: options.domain } : {}) }
  const now = options.now ?? (() => Date.now())
  const bases = options.bases ?? memoryBases()
  const open = (hosts: string[], rules?: E2bNetwork['rules']): E2bNetwork => (hosts.length ? { denyOut: [EVERYWHERE], allowOut: hosts, ...(rules && Object.keys(rules).length ? { rules } : {}) } : CLOSED)

  /** Removes the secrets a run of this runner left behind: ours by name and by mark, and old enough that no run still uses them. */
  const sweep = async () => {
    const listed = Secret.list(connection)
    for (let page = 0; page < 20; page++) {
      for (const secret of await listed.nextItems()) {
        const age = now() - new Date(secret.createdAt).getTime()
        if (secret.name.startsWith(SECRET_PREFIX) && secret.metadata?.muster === 'run' && age > E2B_SECRET_KEEP_MS) await Secret.destroy(secret.name, connection).catch(() => {})
      }
      if (!listed.hasNext) break
    }
  }

  /**
   * The snapshot runs start from: the template with `setup` run in it, and nothing else. Made once per template and
   * setup by this machine and written down here. Making one removes the older ones this machine made of this
   * template, and nothing else. Null when one couldn't be made, and the run is set up the long way.
   */
  const baseSnapshot = async (setup: string[][]): Promise<string | null> => {
    const scope = `${options.domain ?? 'e2b'}/${createHash('sha256').update(options.apiKey).digest('hex').slice(0, 8)}/${options.template}/`
    const key = `${scope}${createHash('sha256').update(JSON.stringify(setup)).digest('hex').slice(0, 12)}`
    const known = bases.get(key)
    if (known) return known
    let made: E2bMade
    try {
      made = await Sandbox.create(options.template, { ...connection, envs: {}, timeoutMs: 15 * MINUTE, network: (options.setupHosts ?? []).length ? { denyOut: [EVERYWHERE], allowOut: options.setupHosts! } : CLOSED, metadata: { muster: 'base' } })
    } catch {
      return null
    }
    try {
      if (!made.createSnapshot) return null
      for (const command of setup) await made.commands.run(command.map(shellQuote).join(' '), { user: 'root', timeoutMs: 10 * MINUTE })
      await made.commands.run(`touch ${BASE_READY}`, { user: 'root', timeoutMs: MINUTE })
      // Kept with every host closed, as each run that starts from it is until its own way out is set.
      await made.updateNetwork(CLOSED)
      const { snapshotId } = await made.createSnapshot()
      // Another worker on this machine made one meanwhile: theirs is the one written down, and this one goes.
      const theirs = bases.get(key)
      if (theirs) {
        await Sandbox.deleteSnapshot?.(snapshotId, connection).catch(() => {})
        return theirs
      }
      const older = bases.entries().filter(([other]) => other.startsWith(scope) && other !== key)
      bases.set(key, snapshotId)
      for (const [, other] of older) {
        bases.forget(other)
        await Sandbox.deleteSnapshot?.(other, connection).catch(() => {})
      }
      return snapshotId
    } catch {
      return null
    } finally {
      await made.kill().catch(() => {})
    }
  }

  return {
    name: 'e2b',
    async start(request) {
      const { networkPolicy, env } = boardPolicy(request.board)
      if (!forSandbox(request.board.token)) {
        throw new Failure('agent_token_unmarked', "The agent's token isn't one made for a sandbox, and E2B can't hold it to the board's own routes: the run wasn't started.", { hint: "Make one with mu token create --sandbox. If mu run made this one, the board is older than this mu: upgrade it." })
      }
      const [boardHost, boardRules] = Object.entries(networkPolicy.allow)[0]!
      const boardHeaders: Record<string, string> = Object.assign({}, ...boardRules![0]!.transform.map((step) => step.headers))
      const model = request.agent.model && (request.model || options.modelSecret) ? request.agent.model : undefined
      if (model && !options.keyAnyPath) {
        throw new Failure('model_key_unscoped', `E2B adds the model's key to every request to ${model.host}, not only the ones that ask the model: an agent that is steered could use it for anything that key can do there.`, { hint: `Set MUSTER_E2B_KEY_ANY_PATH=1 to accept that, with a key made for this alone. Or unset ${options.modelSecret ? 'MUSTER_E2B_MODEL_SECRET' : model.keyEnv} and sign the agent in inside your template.` })
      }
      const agentHosts = [...new Set([boardHost!, ...(model ? [model.host] : []), ...(options.allowHosts ?? [])])]
      if (agentHosts.length > E2B_HOSTS_MAX) throw new Failure('runner_too_many_hosts', `An E2B sandbox reaches ${E2B_HOSTS_MAX} hosts at most, and this run names ${agentHosts.length}.`, { hint: 'Allow fewer hosts.' })

      // What a run that never ended left stored: best effort, and never a reason not to start this one.
      await sweep().catch(() => {})

      let setup = request.setup ?? []
      const repoName = request.repo ? new URL(request.repo).pathname.split('/').filter(Boolean).pop()!.replace(/\.git$/, '') : undefined
      const lifetime = request.timeoutMs ?? DEFAULT_LIFETIME_MS
      // The secrets of this run that are still stored. Each is removed as soon as nothing needs it, and all of them when the run ends.
      const stored = new Set<string>()
      const store = async (value: string): Promise<string> => {
        const name = `${SECRET_PREFIX}${randomBytes(12).toString('hex')}`
        try {
          await Secret.create(name, value, { ...connection, metadata: { muster: 'run' } })
        } catch (error) {
          const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode
          if (status === 409 || /\b409\b|limit/i.test(error instanceof Error ? error.message : '')) {
            throw new Failure('runner_secrets_full', "E2B wouldn't store this run's credential: the project holds as many secrets as its plan allows (10 on Hobby, 100 on a paid one), and each run holds two.", { hint: 'Run fewer at once. MUSTER_E2B_MODEL_SECRET names one secret of yours that every run uses for the model, which halves what a run holds.' })
          }
          throw new Failure('runner_start_failed', "E2B wouldn't store this run's credential, so the run wasn't started.")
        }
        stored.add(name)
        return Secret.fill(name)
      }
      const forget = async (filled: string) => {
        for (const name of stored) {
          if (Secret.fill(name) !== filled) continue
          await Secret.destroy(name, connection).catch(() => {})
          stored.delete(name)
        }
      }

      const envs = { ...CA_ENV, ...env, ...(model ? model.env(PLACEHOLDER) : {}), ...request.env, MUSTER_TASK: String(request.task) }
      const metadata = { muster: 'run', task: String(request.task) }
      let sandbox: E2bMade | undefined
      if (options.base && setup.length > 0) {
        // Started from a kept sandbox that holds what the setup installs and nothing else, with every host closed.
        const base = await baseSnapshot(setup).catch(() => null)
        const started = base ? await Sandbox.create(base, { ...connection, envs, timeoutMs: lifetime, network: CLOSED, metadata }).catch(() => undefined) : undefined
        if (base && started) {
          const ready = await started.commands.run(`test -f ${BASE_READY}`, { timeoutMs: MINUTE }).then(() => true, () => false)
          if (ready) {
            sandbox = started
            setup = []
          } else await started.kill().catch(() => {})
        }
        // A base that is gone, or whose making was cut short, is forgotten: this run is set up the long way, and the next makes another.
        if (base && !sandbox) {
          bases.forget(base)
          await Sandbox.deleteSnapshot?.(base, connection).catch(() => {})
        }
      }
      // The first way out is the setup's: where mu is installed from, with no credential anywhere in it.
      sandbox ??= await Sandbox.create(options.template, { ...connection, envs, timeoutMs: lifetime, network: setup.length ? open(options.setupHosts ?? []) : CLOSED, metadata })
      /** Ends the run so nothing of it is left: its way out is closed, it is removed, and what was stored for it is too. */
      const end = async () => {
        await sandbox.updateNetwork(CLOSED).catch(() => {})
        await sandbox.kill().catch(() => {})
        for (const name of [...stored]) {
          await Secret.destroy(name, connection).catch(() => {})
          stored.delete(name)
        }
      }
      /** Runs one command to its end. A command that exits with a code is an answer, not an error; anything else thrown is. */
      const sh = async (script: string, opts: { cwd?: string; user?: string; envs?: Record<string, string>; timeoutMs: number }): Promise<{ exitCode: number | null; stdout: string }> => {
        try {
          const done = await sandbox.commands.run(script, opts)
          return { exitCode: done.exitCode ?? 0, stdout: String(done.stdout ?? '') }
        } catch (error) {
          const code = exitOf(error)
          if (code === undefined) throw error
          return { exitCode: code, stdout: String((error as { stdout?: unknown }).stdout ?? '') }
        }
      }

      try {
        for (const command of setup) {
          // As root: a release is installed for every user of the sandbox, and the template's own user may not write there.
          const done = await sh(command.map(shellQuote).join(' '), { user: 'root', timeoutMs: 10 * MINUTE })
          // What it printed stays in the sandbox: an install's output can name private packages and registries.
          if (done.exitCode !== 0) throw new Failure('runner_setup_failed', `Setting up the sandbox failed: \`${command.map(bare).join(' ')}\` exited ${done.exitCode}.`, { hint: 'The sandbox was removed. MUSTER_INSTALL names another muster to install.' })
        }
        // What runs in the sandbox before anything of a repository's does: all that is left running once its install is over.
        const kept = (await sh(PROCESSES, { user: 'root', timeoutMs: MINUTE })).stdout.trim()
        /** Ends what a step left running. A way out that was closed still serves the connections that were open, so they are ended with their processes. */
        const reap = async () => {
          const done = await sh(REAP, { user: 'root', envs: { MU_KEEP: kept }, timeoutMs: 2 * MINUTE })
          if (done.exitCode !== 0 || done.stdout.trim().split('\n').pop() !== 'left 0') throw new Failure('runner_setup_failed', "A process the repository's install left running in the sandbox couldn't be ended, so the run was stopped before the agent started.", { hint: 'Launch only on code you would run. --no-install skips the install.' })
        }
        // The template decides who its user is, and so where a repository goes.
        const home = (await sh('printf %s "$HOME"', { timeoutMs: MINUTE })).stdout.trim()
        const dir = repoName ? `${/^\/[\w./-]+$/.test(home) ? home.replace(/\/$/, '') : '/home/user'}/${repoName}` : undefined

        if (dir) {
          // GitHub's token, when there is one, is stored and on github.com only while this one command of ours
          // runs, before anything of the repository does. E2B can't hold it to this repository's git routes,
          // so it is a token made to read this repository and nothing else.
          const auth = request.github ? await store(`Basic ${Buffer.from(`x-access-token:${request.github.token}`).toString('base64')}`) : undefined
          await sandbox.updateNetwork(open(CLONE_HOSTS, auth ? { 'github.com': [{ transform: { headers: { authorization: auth, host: 'github.com' } } }] } : undefined))
          const cloned = await sh(['git', 'clone', '--quiet', ...(request.ref ? ['--branch', request.ref.branch] : []), '--', request.repo!, dir].map(shellQuote).join(' '), { timeoutMs: 10 * MINUTE })
          // Closed before the token is forgotten, so no request is on its way out with it.
          await sandbox.updateNetwork(CLOSED)
          if (auth) await forget(auth)
          if (cloned.exitCode !== 0) throw new Failure('runner_setup_failed', `Cloning ${bare(request.repo!)} in the sandbox failed (exit ${cloned.exitCode}).`, { hint: 'A private repository needs a GitHub App installed on it.' })
        }

        // A failed install costs the agent its tests, not the run: it is said, and the agent starts.
        let installed: string | undefined
        if (dir && request.install) {
          // Whatever registries the lockfile names: every host, and no credential stored or attached while they are open.
          await sandbox.updateNetwork(open(['*']))
          const done = await sh(INSTALL, { cwd: dir, timeoutMs: 15 * MINUTE }).catch(() => ({ exitCode: null, stdout: '' }))
          const said = done.stdout.trim().split('\n').pop() ?? ''
          installed = done.exitCode !== 0 ? `failed (${done.exitCode === null ? 'no exit code' : `exit ${done.exitCode}`})` : /^installed \w+$/.test(said) ? said.slice('installed '.length) : 'none'
          await sandbox.updateNetwork(CLOSED)
          // Every host was open, and a repository's own configuration runs at install: nothing it started outlives it.
          await reap()
        }

        // Where the checkout started, so what the agent changed can be told from what was there.
        let checkout: { sha: string; branch: string } | undefined
        if (dir) {
          const [sha, branch] = (await sh('git rev-parse HEAD && git rev-parse --abbrev-ref HEAD', { cwd: dir, timeoutMs: MINUTE })).stdout.trim().split('\n')
          if (request.ref) {
            if (sha !== request.ref.sha) throw new Failure('runner_setup_failed', `The sandbox didn't start on ${request.ref.branch} at ${request.ref.sha.slice(0, 12)}, so the run was stopped before the agent started.`, { hint: 'The branch may have moved: run the task again.' })
            checkout = { sha, branch: request.ref.branch }
          } else if (sha && branch && SHA.test(sha) && BRANCH.test(branch)) checkout = { sha, branch }
        }

        // Only now are the agent's credentials stored and attached: nothing above ran with them in reach.
        const rules: NonNullable<E2bNetwork['rules']> = {}
        rules[boardHost!] = [{ transform: { headers: { ...boardHeaders, authorization: await store(boardHeaders.authorization!) } } }]
        if (model) {
          const headers: Record<string, string> = { host: model.host }
          if (options.modelSecret) Object.assign(headers, model.headers(Secret.fill(options.modelSecret)))
          else for (const [name, value] of Object.entries(model.headers(request.model!.key))) headers[name] = value.includes(request.model!.key) ? await store(value) : value
          rules[model.host] = [{ transform: { headers } }]
        }
        await sandbox.updateNetwork(open(agentHosts, rules))

        // E2B sends a request without its credential when the secret can't be found, and says nothing. Asked
        // here, as the agent will ask, so that is a run that didn't start and not an agent that can't work.
        const who = await sh('mu whoami --json', { timeoutMs: 2 * MINUTE }).catch(() => ({ exitCode: null, stdout: '' }))
        if (who.exitCode !== 0) throw new Failure('runner_setup_failed', "The sandbox couldn't reach the board as the agent, so the run was stopped before the agent started.", { hint: 'The board has to be at an HTTPS address E2B can reach, and mu has to be in the sandbox: MUSTER_E2B_TEMPLATE names a template built from templates/e2b-runner.' })

        const { bin, args } = request.agent.command({ permissionMode: request.permissionMode ?? 'safe' })
        // The prompt goes in on stdin through a shell, so no part of it is ever read as a flag. The agent starts in the repository.
        let agent = await sandbox.commands.run(`printf %s ${shellQuote(request.prompt)} | ${[bin, ...args].map(shellQuote).join(' ')}`, { background: true, timeoutMs: lifetime, ...(dir ? { cwd: dir } : {}) })
        const pid = agent.pid
        const waitable = typeof agent.wait === 'function'

        return {
          id: sandbox.sandboxId,
          stop: end,
          exec: (command) => sh([command.cmd, ...command.args].map(shellQuote).join(' '), { timeoutMs: 10 * MINUTE, ...(dir ? { cwd: dir } : {}), ...(command.env ? { envs: command.env } : {}) }),
          // Read no further than `max` bytes, whatever the file says it is: null when there is none, or it is bigger.
          readFile: async (path, max) => {
            let stream: AsyncIterable<Uint8Array>
            try {
              stream = await sandbox.files.read(path, { format: 'stream' })
            } catch {
              return null
            }
            const chunks: Buffer[] = []
            let size = 0
            for await (const chunk of stream) {
              size += chunk.length
              if (size > max) return null
              chunks.push(Buffer.from(chunk))
            }
            return Buffer.concat(chunks)
          },
          // Only closing is asked of a run once it has started: what E2B can express of a host's rules is less than a caller could mean.
          setPolicy: async (rules: Record<string, VercelRule[]> | 'deny-all') => {
            if (rules !== 'deny-all') throw new Failure('push_unsupported', "An E2B sandbox's way out can be closed once it runs, not changed.")
            await sandbox.updateNetwork(CLOSED)
            // And nothing the agent left running holds a connection open, or changes what is read out next.
            await reap()
          },
          ...(checkout ? { checkout } : {}),
          ...(installed ? { installed } : {}),
          ...(waitable
            ? {
                // A command that exits with a code is thrown by the SDK: that is how the agent ended. Anything else thrown is a
                // lost connection: the command is found again by its process, so the next time this is asked it is still the
                // agent that is waited on, and not a connection that is gone.
                wait: async () => {
                  try {
                    return { exitCode: (await agent.wait!()).exitCode ?? 0 }
                  } catch (error) {
                    const code = exitOf(error)
                    if (code !== undefined) return { exitCode: code }
                    if (pid !== undefined && sandbox.commands.connect) agent = await sandbox.commands.connect(pid, { timeoutMs: lifetime }).catch(() => agent)
                    throw error
                  }
                },
              }
            : {}),
        } satisfies CloudRun
      } catch (error) {
        await end()
        throw error
      }
    },
  }
}
