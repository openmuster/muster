import { agentFiles } from '@/lib/llms'

// Every file is built ahead of time like the pages, and served from the static assets.
export const dynamic = 'force-static'

export async function generateStaticParams() {
  return (await agentFiles.files()).map((file) => ({ path: file.replace(/^\//, '').split('/') }))
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  return (await agentFiles.serve(`/${path.join('/')}`)) ?? new Response('Not found\n', { status: 404 })
}
