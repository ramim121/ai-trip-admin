import type { z } from 'zod'
import { badRequest, type ErrorDetail } from './errors'

/**
 * Request parsing.
 *
 * Nothing from the wire reaches a handler untyped. Both helpers turn any
 * rejection — unreadable body, wrong shape, missing field — into the same
 * VALIDATION_FAILED envelope, so clients get one predictable failure mode
 * instead of a 400 here and an unhandled SyntaxError 500 there.
 */

/** Structural view of a zod issue; avoids depending on zod's internal generics. */
type ZodIssueLike = {
  readonly path: PropertyKey[]
  readonly message: string
}

/**
 * `['traveller', 'contacts', 0, 'email']` becomes `traveller.contacts.0.email`.
 *
 * Array indices are kept as plain segments rather than bracket notation: the
 * clients treat this as an opaque field identifier, and one join rule is easier
 * to rely on than two.
 */
function formatPath(path: readonly PropertyKey[]): string {
  return path.map((segment) => String(segment)).join('.')
}

function toDetails(issues: readonly ZodIssueLike[]): ErrorDetail[] {
  return issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
  }))
}

/**
 * Read and validate a JSON request body.
 *
 * `Request.json()` throws a SyntaxError on anything that is not JSON — an empty
 * body, a form post, a truncated upload. Left uncaught that surfaces as a 500,
 * which blames us for the caller's malformed request, so it is caught here and
 * reported as a validation failure at the body root (empty `path`).
 *
 * Parsing is asynchronous so schemas carrying async refinements work unchanged.
 */
export async function parseJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown

  try {
    raw = await req.json()
  } catch {
    throw badRequest('Request body must be valid JSON.', [
      { path: '', message: 'Expected a JSON body.' },
    ])
  }

  const result = await schema.safeParseAsync(raw)

  if (!result.success) {
    throw badRequest('The request payload failed validation.', toDetails(result.error.issues))
  }

  return result.data
}

/**
 * Read and validate a JSON body the caller need not send at all.
 *
 * For endpoints where EVERY field is optional. `parseJson` rejects an empty
 * body, which is right for the great majority of routes — a POST that forgot its
 * payload is a bug, and saying so is more useful than inventing `{}`. But on a
 * route whose schema is entirely optional, "no body" is not a malformed request,
 * it is the commonest correct one: a plain `fetch(url, { method: 'POST' })`
 * sends neither a body nor a content-type, so refusing it makes the simplest
 * possible call the one that fails.
 *
 * An absent body becomes `{}` and is validated normally, so defaults and
 * refinements still apply. Malformed JSON is still a 400 — this is deliberately
 * not a blanket "ignore anything unparseable".
 */
export async function parseOptionalJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const text = (await req.text()).trim()

  let raw: unknown = {}

  if (text !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      throw badRequest('Request body must be valid JSON.', [
        { path: '', message: 'Expected a JSON body.' },
      ])
    }
  }

  const result = await schema.safeParseAsync(raw)

  if (!result.success) {
    throw badRequest('The request payload failed validation.', toDetails(result.error.issues))
  }

  return result.data
}

/**
 * Validate a URL's query string.
 *
 * Repeated keys (`?tag=a&tag=b`) collapse to an array so `z.array(...)` works;
 * a key seen once stays a bare string. Absent keys are simply absent, which
 * lets `.optional()` and `.default()` behave as written.
 *
 * Synchronous, so query schemas must not use async refinements.
 */
export function parseQuery<T>(url: URL, schema: z.ZodType<T>): T {
  const raw: Record<string, string | string[]> = {}

  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    raw[key] = values.length > 1 ? values : values[0]
  }

  const result = schema.safeParse(raw)

  if (!result.success) {
    throw badRequest('The query parameters failed validation.', toDetails(result.error.issues))
  }

  return result.data
}
