import { team } from '@/lib/board'

// The board, as `mu serve` serves it, at /api/board: its routes, the live feed and webhooks, every request
// held to a token from `mu token create`. A request for a name this page doesn't answer for is refused.
export const dynamic = 'force-dynamic'

const serve = (request: Request) => team().fetch(request)
export { serve as GET, serve as POST }
