import { NextResponse, type NextRequest } from 'next/server'
import { answersFor } from './lib/host'

/** Every request, before any page or route: one that came for another name is refused. */
export function proxy(request: NextRequest) {
  if (answersFor(request.headers.get('host'), process.env.ALLOW_HOSTS)) return NextResponse.next()
  return new NextResponse('This page answers only for this machine. Name another host in ALLOW_HOSTS, behind something that asks who is there.', { status: 403 })
}

// The board's routes check the host themselves (`team.fetch`, given ALLOW_HOSTS) and need a token. Left out
// here because Next.js reads a body that passes through a proxy into memory and cuts it at 10 MB, under the
// board's own limit for a file.
export const config = { matcher: ['/((?!api/board/).*)'] }
