import { team } from '@/lib/board'

// The board, as `mu serve` serves it, at /api/board: its routes and the live feed, every request held to a
// token from `mu token create`. A request for a name this page doesn't answer for is refused. The handle here
// has no `sync` yet, so platform webhooks still go to `mu serve` (sync.json).
export const dynamic = 'force-dynamic'

export const GET = team.fetch
export const POST = team.fetch
