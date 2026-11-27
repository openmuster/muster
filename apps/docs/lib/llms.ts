import { llms } from 'fumadocs-core/source'
import { forAgents } from './markdown'
import { source } from './source'

type Text = { title: string; description?: string; getText: (type: 'raw' | 'processed') => Promise<string> }

/**
 * The docs as plain text, for agents: `/llms.txt` (an index), `/llms-full.txt` (every page) and a `.md`
 * beside each page (`/docs/quickstart.md`).
 */
export const agentFiles = llms(source, {
  renderPage: async (page) => {
    const data = page.data as unknown as Text
    const lead = data.description ? `\n\n> ${data.description}` : ''
    return `# ${data.title}${lead}\n\n${forAgents(await data.getText('processed'), page.path)}`
  },
})
