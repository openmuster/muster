/** How a run ended, as far as the board cares. */
export type ExitKind = 'ok' | 'quota' | 'auth' | 'bad_resume' | 'crash' | 'timeout' | 'stopped'

export type Usage = { input: number; output: number }
export type Parsed = { sessionId?: string; usage?: Usage; costUsd?: number; terminal: boolean; error?: string }

/** `safe` passes no flag that widens what the agent may do. `bypass` is the agent's own skip-permissions flag, and is always asked for by name. */
export type PermissionMode = 'safe' | 'bypass'

/**
 * How to run one agent CLI headlessly and read what it printed. It is code, not config: every agent
 * needed its own parsing state and its own error text.
 */
export type Agent = {
  name: string
  /** `full` loads everything the person's own setup has: plugins, skills, connected tools. The default is lean. */
  command(options: { resume?: string; permissionMode: PermissionMode; model?: string; full?: boolean; writable?: string[] }): { bin: string; args: string[] }
  /** Environment the agent needs beyond PATH and HOME, by name: its own keys and config folders. */
  envKeys: string[]
  /**
   * How the agent reaches its model from a sandbox: the provider's host, the variable its key is read
   * from on the machine that starts the run, the headers that carry the key, and what the sandbox's
   * environment holds instead of it. Absent for an agent whose model isn't ours to know.
   */
  model?: { host: string; keyEnv: string; headers(key: string): Record<string, string>; env(placeholder: string): Record<string, string> }
  parse(stdout: string): Parsed
  classify(result: { code: number | null; signal: NodeJS.Signals | null; parsed: Parsed; stderr: string }): ExitKind
}

/**
 * Whether a string is safe to hand an agent as the session to resume. It comes from a label anyone
 * who can label may set, so it is held to the shape of an ID and can never be read as a flag.
 */
export const isSessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)

/** What a lean Claude Code worker keeps: enough to read, change and run things. */
export const LEAN_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob'

const jsonLines = (stdout: string): Record<string, any>[] =>
  stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, any>]
      } catch {
        return []
      }
    })

const QUOTA = /usage limit|rate limit|quota|5-hour limit|too many requests|credit balance/i
const AUTH = /not logged in|please run \/login|invalid api key|authentication|unauthorized|invalid_grant|refresh token/i

function classifyBy(resume: RegExp) {
  return ({ code, signal, parsed, stderr }: Parameters<Agent['classify']>[0]): ExitKind => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT') return 'stopped'
    if (code === 0 && parsed.terminal && !parsed.error) return 'ok'
    // Only what the agent itself reported as its failure is matched: never the model's own prose.
    const said = `${parsed.error ?? ''}\n${stderr}`
    if (resume.test(said)) return 'bad_resume'
    if (QUOTA.test(said)) return 'quota'
    if (AUTH.test(said)) return 'auth'
    return 'crash'
  }
}

export const claude: Agent = {
  name: 'claude',
  command({ resume, permissionMode, model, full }) {
    const args = ['--print', '--output-format', 'stream-json', '--verbose']
    // A worker needs a shell and files, not the person's whole setup. Measured on one machine: a session starts
    // at about 13,000 tokens this way, against about 52,000 with every plugin, skill and connected tool loaded.
    if (!full) args.push('--strict-mcp-config', '--disable-slash-commands', '--tools', LEAN_TOOLS)
    if (resume) args.push('--resume', resume)
    if (model) args.push('--model', model)
    if (permissionMode === 'bypass') args.push('--dangerously-skip-permissions')
    return { bin: 'claude', args }
  },
  envKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_PROFILE', 'AWS_REGION'],
  model: {
    host: 'api.anthropic.com',
    keyEnv: 'ANTHROPIC_API_KEY',
    headers: (key) => ({ 'x-api-key': key }),
    // Only the model's host is open to the sandbox, so the calls that go elsewhere (telemetry, updates) are turned off.
    env: (placeholder) => ({ ANTHROPIC_API_KEY: placeholder, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }),
  },
  parse(stdout) {
    const out: Parsed = { terminal: false }
    for (const event of jsonLines(stdout)) {
      if (typeof event.session_id === 'string') out.sessionId = event.session_id
      if (event.type !== 'result') continue
      out.terminal = true
      if (typeof event.total_cost_usd === 'number') out.costUsd = event.total_cost_usd
      // Per-model usage counts subagents too; the top-level figure doesn't.
      const models = Object.values((event.modelUsage ?? {}) as Record<string, any>)
      const usage = models.length
        ? models.reduce((sum, model) => ({ input: sum.input + (model.inputTokens ?? 0) + (model.cacheCreationInputTokens ?? 0) + (model.cacheReadInputTokens ?? 0), output: sum.output + (model.outputTokens ?? 0) }), { input: 0, output: 0 })
        : event.usage
          ? { input: (event.usage.input_tokens ?? 0) + (event.usage.cache_creation_input_tokens ?? 0) + (event.usage.cache_read_input_tokens ?? 0), output: event.usage.output_tokens ?? 0 }
          : undefined
      if (usage) out.usage = usage
      if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))) out.error = String(event.result ?? event.subtype)
    }
    return out
  },
  classify: classifyBy(/no conversation found with session id/i),
}

export const codex: Agent = {
  name: 'codex',
  command({ resume, permissionMode, model, writable }) {
    // Found by running it: outside a Git repository Codex refuses to start without the first flag, and its
    // default sandbox can write nowhere, so it could neither do the work nor reach the board's file.
    const args = ['exec', '--json', '--skip-git-repo-check']
    if (model) args.push('--model', model)
    if (permissionMode === 'bypass') args.push('--dangerously-bypass-approvals-and-sandbox')
    else {
      args.push('--sandbox', 'workspace-write')
      for (const dir of writable ?? []) args.push('--add-dir', dir)
    }
    if (resume) args.push('resume', resume)
    args.push('-')
    return { bin: 'codex', args }
  },
  // Codex reads its sign-in from its home folder, not from a key in the environment.
  envKeys: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  model: {
    host: 'api.openai.com',
    keyEnv: 'OPENAI_API_KEY',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    env: (placeholder) => ({ OPENAI_API_KEY: placeholder }),
  },
  parse(stdout) {
    const out: Parsed = { terminal: false }
    for (const event of jsonLines(stdout)) {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') out.sessionId = event.thread_id
      if (event.type === 'turn.completed') {
        out.terminal = true
        const usage = event.usage ?? {}
        out.usage = { input: Math.max(0, (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0)) + (usage.cached_input_tokens ?? 0), output: usage.output_tokens ?? 0 }
      }
      if (event.type === 'turn.failed' || event.type === 'error') out.error = String(event.error?.message ?? event.message ?? 'failed')
    }
    return out
  },
  classify: classifyBy(/no rollout found for thread id/i),
}

/** Any command: the prompt on stdin, and how it exits is all there is to know. */
export const generic = (bin: string, args: string[] = []): Agent => ({
  name: bin,
  command: () => ({ bin, args }),
  envKeys: [],
  parse: () => ({ terminal: true }),
  classify: ({ code, signal }) => (signal ? 'stopped' : code === 0 ? 'ok' : 'crash'),
})

export const AGENTS: Record<string, Agent> = { claude, codex }
