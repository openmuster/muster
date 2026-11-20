// Puts the skills beside the built CLI, so an installed muster can hand them to an agent.
import { cpSync } from 'node:fs'

cpSync(new URL('../../../skills', import.meta.url), new URL('../dist/skills', import.meta.url), { recursive: true, force: true })
