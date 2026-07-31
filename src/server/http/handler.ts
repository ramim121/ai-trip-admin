import { unstable_rethrow } from 'next/navigation'
import type { NextRequest } from 'next/server'
import { toErrorResponse } from './errors'

/**
 * The wrapper every route export goes through.
 *
 * Route files stay free of try/catch: they throw `ApiError`s (or let a Prisma
 * call blow up) and `route` converts whatever escapes into the contract
 * envelope. Without this, one forgotten catch anywhere is a stack trace served
 * to the internet.
 */

/**
 * Next passes a context object whose `params` shape depends on the route
 * literal (`RouteContext<'/api/v1/users/[id]'>`). Handlers annotate it
 * themselves; `route` only needs to forward it, so it is left untyped rather
 * than made generic over every route in the app.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandlerContext = any

export function route(
  fn: (req: NextRequest, ctx: RouteHandlerContext) => Promise<Response>
): (req: NextRequest, ctx: RouteHandlerContext) => Promise<Response> {
  return async function handler(req, ctx) {
    try {
      return await fn(req, ctx)
    } catch (e) {
      // redirect() and notFound() signal by throwing. Swallowing those would
      // turn a deliberate 307 into a 500, so hand them back to the framework
      // before deciding this is an application error.
      unstable_rethrow(e)
      return toErrorResponse(e)
    }
  }
}

/**
 * A successful JSON response.
 *
 * Success bodies are the resource itself — no envelope. Only errors are
 * wrapped, and only by `toErrorResponse`.
 */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/** 204 for deletes and other successful writes with nothing to return. */
export function noContent(): Response {
  return new Response(null, { status: 204 })
}
