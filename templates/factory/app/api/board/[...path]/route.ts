import { team } from '@/lib/board'

// The board, as `mu serve` serves it, at /api/board: its routes, the live feed, and the webhooks of the module's
// sync at /api/board/webhooks/<key> (GitHub's: /api/board/webhooks/gh). Every request but a webhook is held to
// a token from `mu token create`, and a request for a name this page doesn't answer for is refused. A webhook
// only brings a thread in: the catch-up and what goes back to the platform run in `host.ts`.
export const dynamic = 'force-dynamic'

export const GET = team.fetch
export const POST = team.fetch
