// Builds the E2B template a run's sandbox is made from: Node, git, and the agent's CLI. `mu` itself is
// not in it: each run installs the release of muster that started it, so the template outlives releases.
//
//   E2B_API_KEY=... AGENT_VERSION=<version> node build.mjs
//
// AGENT_PACKAGE   the agent's CLI on npm. Default @anthropic-ai/claude-code; for Codex, @openai/codex.
// AGENT_VERSION   required. `npm view @anthropic-ai/claude-code version` says the current one.
// TEMPLATE        the template's name, which MUSTER_E2B_TEMPLATE then names. Default muster-agents.
import { Template, defaultBuildLogger } from 'e2b'

const agent = process.env.AGENT_PACKAGE ?? '@anthropic-ai/claude-code'
const version = process.env.AGENT_VERSION
const name = process.env.TEMPLATE ?? 'muster-agents'
if (!version) {
  console.error('error: set AGENT_VERSION: an agent CLI installed unpinned is whatever was published last')
  process.exit(2)
}

const template = Template()
  .fromNodeImage('24')
  .aptInstall(['git', 'ca-certificates', 'ripgrep'])
  // npm is Node's own; pnpm fetches the version a repository pins while the registry is open for its install.
  .npmInstall('pnpm', { g: true })
  .npmInstall(`${agent}@${version}`, { g: true })

await Template.build(template, name, { cpuCount: 2, memoryMB: 4096, onBuildLogs: defaultBuildLogger() })
console.log(`built  ${name}`)
