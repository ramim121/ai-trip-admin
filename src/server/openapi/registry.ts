import { z } from 'zod'
import type { ErrorBody, ErrorCode } from '@/server/http/errors'

/**
 * The route registry the OpenAPI document is built from.
 *
 * beyond-borders-web is a separate git repository, so nothing in this process
 * can stop the two sides drifting apart — except a spec generated from the same
 * zod schemas the handlers actually validate against. That is the whole point of
 * this module: a registration is a claim about an endpoint that a human wrote,
 * but the *shapes* it names are the live schemas, so a field renamed in
 * `modules/auth/schema.ts` changes `openapi/v1.json` on the next write and the
 * web repo's codegen notices.
 *
 * The registry stores declarations only. Turning them into JSON Schema is
 * `document.ts`'s job, and neither file imports a route handler — generating the
 * spec must not need a database, a secret, or a running server.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

/**
 * Which audience's bearer token an endpoint expects.
 *
 * Both are `Authorization: Bearer <jwt>` on the wire and share one
 * `securityScheme`, but they are signed with different secrets and carry
 * different audiences (see auth/jwt.ts), so a traveller token presented to an
 * admin route is refused. The distinction is recorded here so the operation
 * description can say which one is meant.
 */
export type SecurityScheme = 'user' | 'admin'

/** A response body: a zod schema, or the deliberate absence of one. */
export type ResponseBody = z.ZodType | 'noContent'

/** The long form, when the default description for a status is not specific enough. */
export interface ResponseObject {
  readonly schema: ResponseBody
  readonly description?: string
  /**
   * Overrides `application/json` for the one response that is not JSON.
   *
   * The planner's message endpoint answers `text/event-stream`, and its schema
   * describes ONE frame rather than the whole body. Publishing that as JSON
   * would tell a generated client to parse an entire stream as a single
   * document — precisely the sort of confident wrongness a spec exists to
   * prevent.
   */
  readonly mediaType?: string
}

export type ResponseEntry = ResponseBody | ResponseObject

export interface RouteSpec {
  readonly method: HttpMethod
  /**
   * The URL path in OpenAPI template form, e.g. `/api/v1/activities/{id}`.
   *
   * Next writes that same segment as `[id]` on disk. The document has to carry
   * `{id}`, because that is what OpenAPI path templating means and what a
   * generated client substitutes into; `openapi-write.ts` converts the
   * filesystem form to this one before comparing the two sets.
   *
   * Every `{name}` here is published as a required path parameter, so a template
   * variable cannot appear in a path without being described.
   */
  readonly path: string
  readonly summary: string
  readonly description?: string
  readonly tags: readonly string[]
  /**
   * Stable identifier for generated clients. Optional — a deterministic id is
   * derived from method and path when it is omitted — but worth writing by hand,
   * because it becomes a function name in the web repo and a derived one changes
   * whenever the path does.
   */
  readonly operationId?: string
  readonly requestSchema?: z.ZodType
  /**
   * The query string, as one zod object.
   *
   * Each top-level property becomes a `query` parameter, described from the very
   * schema the handler hands to `parseQuery` — the same reason request bodies are
   * declared from live schemas rather than written out by hand.
   *
   * Documented as its INPUT side, so a field that parses `"25"` into `25` is
   * published as the string a caller actually sends rather than the number the
   * handler ends up holding.
   *
   * Do not put `.meta({ id })` on it: parameter schemas are inlined, and a named
   * one would be hoisted into `components.schemas` where nothing references it.
   */
  readonly querySchema?: z.ZodType
  readonly responses: Readonly<Record<number, ResponseEntry>>
  readonly security?: SecurityScheme
}

const registered: RouteSpec[] = []

/**
 * Declare one endpoint.
 *
 * Registering the same method and path twice throws rather than overwriting: a
 * silently replaced registration would publish a contract for an endpoint that
 * no longer matches, which is exactly the failure this pipeline exists to
 * prevent.
 */
export function registerRoute(spec: RouteSpec): RouteSpec {
  const duplicate = registered.find(
    (existing) => existing.method === spec.method && existing.path === spec.path
  )

  if (duplicate) {
    throw new Error(
      `OpenAPI: ${spec.method.toUpperCase()} ${spec.path} is already registered. ` +
        'Each method/path pair may be declared once.'
    )
  }

  if (Object.keys(spec.responses).length === 0) {
    throw new Error(
      `OpenAPI: ${spec.method.toUpperCase()} ${spec.path} declares no responses. ` +
        'An operation must document at least one.'
    )
  }

  registered.push(spec)
  return spec
}

/** Every registration, in declaration order. */
export function getRegisteredRoutes(): readonly RouteSpec[] {
  return registered
}

/** Test-only: drop every registration so a suite can build a document in isolation. */
export function resetRegisteredRoutes(): void {
  registered.length = 0
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared error envelope
//
// Every non-2xx response in this API has one shape. Describing it once here and
// referencing it from every registration means a client can write a single
// error handler and trust it everywhere — and means the spec cannot claim an
// error format the server does not emit, because both are checked against
// `ErrorBody` from server/http/errors.ts at compile time.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Annotated with `z.ZodType<ErrorCode>` on purpose: if someone adds a code to
 * the union in errors.ts and not to this list, this line stops compiling. That
 * is cheaper than discovering the mismatch in the web repo.
 */
export const ErrorCodeSchema: z.ZodType<ErrorCode> = z
  .enum([
    'VALIDATION_FAILED',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'RATE_LIMITED',
    'INTERNAL',
  ])
  .meta({
    id: 'ErrorCode',
    description:
      'Machine-readable classification of the failure. Branch on this, never on the message text.',
  })

export const ErrorDetailSchema = z
  .object({
    path: z
      .string()
      .describe(
        'Dotted path to the offending field, e.g. `traveller.email`. Empty for the body root.'
      ),
    message: z.string(),
  })
  .meta({
    id: 'ErrorDetail',
    description: 'One field-level complaint, suitable for attaching to a form control.',
  })

/**
 * The envelope `toErrorResponse` serialises.
 *
 * `details` is present only for VALIDATION_FAILED and only when there is
 * something field-specific to say, so clients must treat it as optional.
 */
export const ErrorResponse: z.ZodType<ErrorBody> = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string().describe('Human-readable summary. Wording is not part of the contract.'),
      details: z.array(ErrorDetailSchema).optional(),
    }),
  })
  .meta({
    id: 'ErrorResponse',
    description: 'The single error shape returned by every non-2xx response in this API.',
  })

/** Shorthand for an error response with endpoint-specific wording. */
export function errorResponse(description: string): ResponseObject {
  return { schema: ErrorResponse, description }
}
