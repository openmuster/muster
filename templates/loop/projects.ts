// The loop's workflows for several projects on one board. A project is a channel subtree, `cards/<project>/`,
// with its own repository: loop-projects.json (beside workflows.json) names each one, and this writes the
// template's three workflows once more for each, as `triage.<project>`, `planning.<project>` and
// `card.<project>`, with that project's repository, runner, template and model. The prompts are written once,
// in workflows.json; only where they run changes. The daemon reads workflows.json when it starts:
//
//   node templates/loop/projects.ts ~/.config/muster/loop-projects.json > ~/.config/muster/workflows.json
//
// then restart `mu serve`. With no projects, it writes the template's workflows as they are.
import { readFileSync } from 'node:fs'

/**
 * A project: a repository whose cards are in `cards/<project>/`, one channel per source as the board module's
 * `sync` maps them (`cards/acme/linear`). `trusted` and `public` replace LOOP_TRUSTED and LOOP_PUBLIC on its
 * cards (`public` names its sources: `["github"]` by default); `maxRuns` caps its runs going at once.
 */
export type Project = { repo: string; runner?: 'vercel' | 'cloudflare' | 'e2b'; template?: string; model?: string; trusted?: string[]; public?: string[]; maxRuns?: number }

/** A workflow as workflows.json has it: only what this reads or changes is named. */
type Workflow = { name: string; channels: string[]; workers: Record<string, unknown> } & Record<string, unknown>

/** Source channel names a project can't take: a card from them sits right under `cards/` already. */
const TAKEN = new Set(['slack', 'linear', 'github', 'notion', 'app'])

/** A project's name: a channel segment with no `.`, which separates it from the workflow's name. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

/**
 * Checks loop-projects.json as read, and returns its projects by name. Throws with what is wrong: a bad name, no
 * repository, or a setting of the wrong kind. Anything it doesn't know is refused, so a typo isn't ignored.
 */
export function readProjects(json: unknown): Record<string, Project> {
  const projects: unknown = (json as { projects?: unknown } | null)?.projects ?? {}
  if (typeof projects !== 'object' || Array.isArray(projects)) throw new Error('loop-projects.json needs a "projects" object, by project name.')
  const known = new Set(['repo', 'runner', 'template', 'model', 'trusted', 'public', 'maxRuns'])
  for (const [name, project] of Object.entries(projects as Record<string, Record<string, unknown>>)) {
    if (!NAME.test(name) || TAKEN.has(name)) throw new Error(`Project "${name}" needs a name of lowercase letters, numbers, "_" and "-", and not one of ${[...TAKEN].join(', ')}.`)
    if (typeof project !== 'object' || project === null) throw new Error(`Project "${name}" needs settings.`)
    for (const key of Object.keys(project)) if (!known.has(key)) throw new Error(`Project "${name}" has "${key}", which isn't a project setting: ${[...known].join(', ')}.`)
    if (typeof project.repo !== 'string' || !project.repo.startsWith('https://')) throw new Error(`Project "${name}" needs a "repo": its HTTPS clone address.`)
    if (project.runner !== undefined && !['vercel', 'cloudflare', 'e2b'].includes(project.runner as string)) throw new Error(`Project "${name}" needs a "runner" of "vercel", "cloudflare" or "e2b".`)
    if (project.template !== undefined && project.runner !== 'e2b') throw new Error(`Project "${name}" has a "template", which is for "runner": "e2b".`)
    for (const key of ['template', 'model']) if (project[key] !== undefined && (typeof project[key] !== 'string' || project[key] === '')) throw new Error(`Project "${name}" has a "${key}" that isn't a name.`)
    for (const key of ['trusted', 'public']) if (project[key] !== undefined && !(Array.isArray(project[key]) && (project[key] as unknown[]).every((each) => typeof each === 'string'))) throw new Error(`Project "${name}" has a "${key}" that isn't a list of strings.`)
    if (project.maxRuns !== undefined && !(Number.isInteger(project.maxRuns) && (project.maxRuns as number) >= 1)) throw new Error(`Project "${name}" has a "maxRuns" that isn't a whole number from 1.`)
  }
  return projects as Record<string, Project>
}

/** The template's workflows, then each one again for each project, held to the project's cards and repository. */
export function projectWorkflows(base: Workflow[], projects: Record<string, Project>): Workflow[] {
  const out = [...base]
  for (const [name, project] of Object.entries(projects)) {
    for (const workflow of base) {
      const { template: _, model: __, ...workers } = workflow.workers
      out.push({
        ...workflow,
        name: `${workflow.name}.${name}`,
        // The daemon refuses a request for it on any other project's cards.
        channels: [`cards/${name}/`],
        workers: { ...workers, repo: project.repo, ...(project.runner ? { runner: project.runner } : {}), ...(project.template ? { template: project.template } : {}), ...(project.model ? { model: project.model } : {}) },
      })
    }
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [projectsPath, basePath = new URL('./workflows.json', import.meta.url).pathname] = process.argv.slice(2)
  const projects = projectsPath ? readProjects(JSON.parse(readFileSync(projectsPath, 'utf8'))) : {}
  const base = (JSON.parse(readFileSync(basePath, 'utf8')) as { workflows: Workflow[] }).workflows
  process.stdout.write(`${JSON.stringify({ workflows: projectWorkflows(base, projects) }, null, 2)}\n`)
}
