import { SWARM, team } from '@/lib/board'
import { snapshot } from '@/lib/swarm'

export const dynamic = 'force-dynamic'

/** One snapshot of the swarm, or of one run. The browser holds no credential: it talks only to this app. */
export async function GET(request: Request) {
  const run = new URL(request.url).searchParams.get('run')
  const scope = run && /^[a-z0-9][a-z0-9-]{0,30}$/.test(run) ? `${SWARM}/${run}` : SWARM
  return Response.json(await snapshot(team(), scope), { headers: { 'cache-control': 'no-store' } })
}
