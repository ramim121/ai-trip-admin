import type { NextRequest } from 'next/server'
import { route } from '@/server/http/handler'
import { buildOpenApiDocument } from '@/server/openapi/document'

/**
 * GET /api/openapi.json — the machine-readable API contract.
 *
 * The same document `npm run openapi:write` commits to `openapi/v1.json`, with
 * one difference: `servers` names the origin this request actually arrived on,
 * so a client that fetches the spec from a deployment is told about *that*
 * deployment rather than about whoever ran the writer last.
 *
 * Unversioned on purpose. `/api/v1` is the versioned surface; this endpoint
 * describes whatever versions the process currently serves, so pinning it to one
 * of them would be a lie the moment a v2 appeared.
 *
 * The document is rebuilt per request. That costs a handful of
 * zod-to-JSON-Schema conversions over a fixed set of schemas, and it keeps the
 * response honest under hot reload — worth more here than shaving microseconds
 * off a route nobody calls in a loop.
 *
 * Deliberately unauthenticated: it describes the shape of the API, never its
 * data, and the public web client needs it to talk to us at all.
 */
export const GET = route(async (req: NextRequest) => {
  const document = buildOpenApiDocument({
    servers: [{ url: req.nextUrl.origin, description: 'This deployment.' }],
  })

  return Response.json(document, {
    headers: {
      // Revalidated rather than immutable: the spec changes with the code, and a
      // stale contract cached for a day is precisely the drift this pipeline
      // exists to prevent.
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  })
})
