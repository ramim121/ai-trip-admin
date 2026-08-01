import { z } from 'zod'
import {
  getRegisteredRoutes,
  type ResponseBody,
  type ResponseEntry,
  type RouteSpec,
} from './registry'
// Imported for effect: evaluating this module is what fills the registry.
import './routes'

/**
 * The OpenAPI 3.1 document, built from the registry and the live zod schemas.
 *
 * No bridge library. OpenAPI 3.1 dropped its bespoke schema dialect and adopted
 * JSON Schema 2020-12 wholesale, so `z.toJSONSchema(schema, { target:
 * 'draft-2020-12' })` already emits something a Schema Object may legally
 * contain. Everything below is about placement — deciding what becomes a
 * component, what stays inline, and where the `$ref`s point — not about
 * translating between two schema languages.
 *
 * Hoisting is the converter's own doing. Any schema carrying `.meta({ id })` is
 * emitted once into `$defs` and referenced everywhere it appears, which is
 * exactly the structure OpenAPI wants — under a different name. So each
 * conversion is lifted: `$defs` entries move to `components.schemas`, and
 * `#/$defs/X` becomes `#/components/schemas/X`. That is a rename, not a
 * translation, and it keeps this module on zod's documented public API. (There
 * is an `external` option that would emit those addresses directly, but it is
 * absent from the exported parameter type, and a spec generator is a poor place
 * to depend on an untyped escape hatch.)
 *
 * `io` decides which side of a transform gets described. A request body is
 * documented as its input (what a client must send), a response as its output
 * (what it will receive). The distinction is not academic here: `EmailField`
 * normalises before it validates, so its input and output are different schemas.
 */

type JsonSchema = z.core.JSONSchema.BaseSchema

/** Where a schema with `.meta({ id })` is published. */
const SCHEMA_REF_PREFIX = '#/components/schemas/'

/** Where the converter puts it before we move it. */
const DEFS_REF_PREFIX = '#/$defs/'

const JSON_MEDIA_TYPE = 'application/json'

/** The one security scheme. Both audiences present a bearer JWT; the secrets differ. */
const BEARER_SCHEME = 'bearerAuth'

const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

/**
 * Version of the *contract*, not of the package.
 *
 * It moves when the wire format changes, which is a different event from a
 * release of this application, so it is not read from package.json.
 */
const API_VERSION = '1.0.0'

const DEFAULT_SERVERS: readonly OpenApiServer[] = [
  { url: 'http://localhost:3001', description: 'Local development (`npm run dev`).' },
]

const API_TAGS: readonly OpenApiTag[] = [
  {
    name: 'Auth',
    description: 'Traveller accounts and sessions. Public, unauthenticated origins.',
  },
  {
    name: 'Admin Auth',
    description:
      'Staff accounts and sessions. Separate table, separate signing secret, separate audience.',
  },
  {
    name: 'Plans',
    description:
      'What is on sale, priced in whole Bangladeshi taka. Public, because a pricing page behind ' +
      'a login converts nobody.',
  },
  {
    name: 'Entitlements',
    description:
      'What an account may do, how much of it is left, and what would lift a limit. Reported so ' +
      'a client can explain a wall rather than discover it — never so a client can decide one.',
  },
  {
    name: 'Planner',
    description:
      'Trip generation. The teaser is the only surface reachable without an account, and it is a ' +
      'fixed questionnaire rather than a chat, which is what makes its replies cacheable and ' +
      'abuse cheap.',
  },
  {
    name: 'Itineraries',
    description:
      "A traveller's own trips and their timelines. Server-authoritative: the client says what " +
      'it wants and the server decides what happens, down to recomputing every price from the ' +
      "catalog. Conflicts are reported, never resolved by moving somebody's day.",
  },
  {
    name: 'Payments',
    description:
      'Buying an unlock or a subscription. The client names what it wants and never what it ' +
      'costs — the price is read server-side on every call. Payments marked `isTest` were taken ' +
      'by the sandbox gateway: no money moved, the entitlement is real, and any page rendering ' +
      'one must say so.',
  },
  {
    name: 'Catalog',
    description:
      'Destinations and the curated activities we actually sell. Public and unauthenticated: ' +
      'this is what the website browses, and the only inventory the AI planner may recommend. ' +
      'Unpublished rows are never listed, never counted and never addressable.',
  },
]

/**
 * Used when a registration does not supply its own wording. Deliberately
 * describes the contract rather than restating the HTTP status name, since
 * "Bad Request" tells a client nothing it did not already know.
 */
const DEFAULT_RESPONSE_DESCRIPTIONS: Readonly<Record<number, string>> = {
  200: 'Success.',
  201: 'The resource was created.',
  202: 'The request was accepted for processing.',
  204: 'Success, with no response body.',
  400: 'The request payload failed validation.',
  401: 'Authentication is required, or the credentials presented were refused.',
  403: 'Authenticated, but not permitted to perform this action.',
  404: 'The requested resource was not found.',
  409: 'The request conflicts with the current state of the resource.',
  429: 'Too many requests.',
  500: 'An unexpected error occurred.',
}

type Io = 'input' | 'output'

export interface OpenApiServer {
  readonly url: string
  readonly description?: string
}

export interface OpenApiTag {
  readonly name: string
  readonly description: string
}

interface OpenApiMediaType {
  schema: JsonSchema
}

interface OpenApiResponse {
  description: string
  content?: Record<string, OpenApiMediaType>
}

interface OpenApiRequestBody {
  required: boolean
  content: Record<string, OpenApiMediaType>
}

/**
 * A path or query parameter.
 *
 * `style` and `explode` are set only on array-valued query parameters, where the
 * default (`form`, exploded) is what our `parseQuery` actually accepts —
 * `?interests=a&interests=b` — and saying so explicitly stops a generated client
 * from choosing `interests=a,b` and being half right.
 */
interface OpenApiParameter {
  name: string
  in: 'path' | 'query'
  required: boolean
  description?: string
  schema: JsonSchema
  style?: 'form'
  explode?: boolean
}

interface OpenApiOperation {
  operationId: string
  summary: string
  description?: string
  tags: string[]
  security?: Record<string, string[]>[]
  parameters?: OpenApiParameter[]
  requestBody?: OpenApiRequestBody
  responses: Record<string, OpenApiResponse>
}

export interface OpenApiDocument {
  openapi: string
  info: { title: string; version: string; description: string }
  jsonSchemaDialect: string
  servers: OpenApiServer[]
  tags: OpenApiTag[]
  security: Record<string, string[]>[]
  paths: Record<string, Record<string, OpenApiOperation>>
  components: {
    securitySchemes: Record<string, Record<string, string>>
    schemas: Record<string, JsonSchema>
  }
}

export interface BuildOptions {
  /**
   * Overrides the advertised server list. The route handler passes the origin it
   * was actually reached on, so the served document describes the deployment a
   * client is already talking to rather than whatever was true at build time.
   */
  readonly servers?: readonly OpenApiServer[]
}

/** Accumulates `components.schemas` while operations are converted. */
interface Components {
  readonly schemas: Record<string, JsonSchema>
  /** Which `io` first produced each component, for the collision message. */
  readonly firstSeenAs: Map<string, Io>
}

/**
 * Rewrite every `#/$defs/X` reference to `#/components/schemas/X`.
 *
 * Returns a copy rather than editing in place: the same converted object is
 * about to be handed to `publish`, and a rewrite that mutated a schema already
 * stored under another name would corrupt it.
 */
function retargetRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(retargetRefs)
  if (node === null || typeof node !== 'object') return node

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    result[key] =
      key === '$ref' && typeof value === 'string' && value.startsWith(DEFS_REF_PREFIX)
        ? `${SCHEMA_REF_PREFIX}${value.slice(DEFS_REF_PREFIX.length)}`
        : retargetRefs(value)
  }

  return result
}

/**
 * Convert one zod schema, publishing every named schema it touches.
 *
 * Returns a `$ref` when the schema itself carries an `id`, and the schema body
 * inline when it does not — an anonymous one-off has no useful component name,
 * and inventing one (`Schema7`) would make the spec churn every time an
 * unrelated endpoint is added above it.
 */
function convert(schema: z.core.$ZodType, io: Io, components: Components): JsonSchema {
  const converted = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    // A cycle can only be expressed as a $ref back to a named component. There
    // are none today; if one appears we would rather stop than silently emit a
    // self-referential shape nobody reviewed.
    cycles: 'throw',
    // Hoist named schemas only. An anonymous shape that happens to appear twice
    // is not a concept the API has a word for, and publishing it as `__schema3`
    // would put a meaningless type in the generated client.
    reused: 'inline',
  })

  const body: JsonSchema = { ...converted }
  const definitions = body.$defs

  // `$schema` belongs on a standalone document, not on a Schema Object nested in
  // one; `$defs` is being moved to components; `~standard` is zod's Standard
  // Schema handle and is not JSON at all.
  delete body.$schema
  delete body.$defs
  delete body['~standard']

  if (definitions !== undefined) {
    for (const [name, definition] of Object.entries(definitions)) {
      publish(name, retargetRefs(definition) as JsonSchema, io, components)
    }
  }

  const rooted = retargetRefs(body) as JsonSchema

  // The converter leaves the root inline even when it is named, since a document
  // whose root is a bare `$ref` would say nothing. Its own id has to be read
  // back from the registry.
  const id = z.globalRegistry.get(schema)?.id

  if (id === undefined) return rooted

  publish(id, rooted, io, components)
  return { $ref: `${SCHEMA_REF_PREFIX}${id}` }
}

function publish(name: string, body: JsonSchema, io: Io, components: Components): void {
  const existing = components.schemas[name]

  if (existing === undefined) {
    components.schemas[name] = body
    components.firstSeenAs.set(name, io)
    return
  }

  // The same id must mean the same thing everywhere, or a client generated from
  // this document gets one type for two different shapes. The realistic cause is
  // a schema used on both sides of the wire whose input and output differ — a
  // transform, a default, a coercion.
  if (JSON.stringify(existing) !== JSON.stringify(body)) {
    throw new Error(
      `OpenAPI: schema id "${name}" resolves to two different JSON Schemas ` +
        `(first as ${components.firstSeenAs.get(name)}, now as ${io}). ` +
        'Split it into two ids, or stop using it on both sides of the wire.'
    )
  }
}

/**
 * Fail loudly on a `$ref` that points nowhere.
 *
 * Every reference should have been satisfied by the `$defs` that came back with
 * it, so this can only fire if a rewrite was missed — and a dangling `$ref` is
 * the one defect that breaks a consumer's codegen outright while still looking
 * like a valid JSON document.
 */
function assertReferencesResolve(document: OpenApiDocument): void {
  const dangling = new Set<string>()

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }

    if (node === null || typeof node !== 'object') return

    const record = node as Record<string, unknown>
    const ref = record.$ref

    if (typeof ref === 'string') {
      const name = ref.startsWith(SCHEMA_REF_PREFIX) ? ref.slice(SCHEMA_REF_PREFIX.length) : null
      if (name === null || !Object.hasOwn(document.components.schemas, name)) dangling.add(ref)
    }

    for (const value of Object.values(record)) walk(value)
  }

  walk(document.paths)
  walk(document.components.schemas)

  if (dangling.size > 0) {
    throw new Error(
      `OpenAPI: ${dangling.size} reference(s) resolve to nothing: ${[...dangling].join(', ')}.`
    )
  }
}

function normalizeResponse(entry: ResponseEntry): {
  schema: ResponseBody
  description?: string
  mediaType?: string
} {
  if (entry === 'noContent') return { schema: 'noContent' }
  if ('schema' in entry) {
    return { schema: entry.schema, description: entry.description, mediaType: entry.mediaType }
  }
  return { schema: entry }
}

/**
 * `post /api/v1/auth/password/forgot` → `postAuthPasswordForgot`.
 *
 * Only a fallback. An operationId becomes a function name in the generated
 * client, and a derived one silently renames itself when a path moves, so
 * registrations are expected to supply their own.
 */
function deriveOperationId(spec: RouteSpec): string {
  const segments = spec.path
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== 'api' && !/^v\d+$/.test(segment))
    .map((segment) => segment.replace(/[[\]{}.]/g, ''))
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))

  return spec.method + segments.join('')
}

/** `/api/v1/destinations/{slug}/activities` → `['slug']`. */
const PATH_TEMPLATE_VARIABLE = /\{([^}]+)\}/g

/**
 * Every `{name}` in the path, as a required string parameter.
 *
 * Derived rather than declared, because OpenAPI *requires* a path template
 * variable to have a matching parameter — a spec that omits one is invalid, and
 * the invalidity would only surface in whatever the web repo generates from it.
 * Deriving means the two can never disagree.
 */
function pathParameters(path: string): OpenApiParameter[] {
  PATH_TEMPLATE_VARIABLE.lastIndex = 0

  return [...path.matchAll(PATH_TEMPLATE_VARIABLE)].map(([, name]) => ({
    name,
    in: 'path' as const,
    // Always. A path variable is part of the address; there is no request that
    // reaches this operation without it.
    required: true,
    schema: { type: 'string' } as JsonSchema,
  }))
}

/**
 * Turn a query schema into parameter objects.
 *
 * Converted with `io: 'input'`, so a field declared as a string that parses into
 * a number is documented as the string a caller sends. That is not a technicality:
 * everything in a query string is a string, and publishing `type: integer` would
 * describe the handler's variable rather than the wire.
 *
 * Anything that is not a plain object schema is ignored rather than guessed at —
 * a union or an array at the top level has no parameter names to publish, and
 * inventing some would put a contract in the document that no handler honours.
 */
function queryParameters(schema: z.core.$ZodType): OpenApiParameter[] {
  const converted = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    cycles: 'throw',
    // Inlined, not hoisted: a parameter schema published as a component would sit
    // in `components.schemas` with nothing referencing it.
    reused: 'inline',
  })

  const properties = converted.properties
  if (properties === undefined) return []

  const required = new Set(Array.isArray(converted.required) ? converted.required : [])

  return Object.entries(properties).map(([name, property]) => {
    const body: JsonSchema = { ...(property as JsonSchema) }
    const description = typeof body.description === 'string' ? body.description : undefined
    delete body.description

    // `anyOf: [string, array]` is how a repeatable parameter is declared, since
    // one occurrence is a string and two are an array.
    const repeatable =
      Array.isArray(body.anyOf) &&
      body.anyOf.some((member) => (member as JsonSchema).type === 'array')

    return {
      name,
      in: 'query' as const,
      required: required.has(name),
      ...(description !== undefined ? { description } : {}),
      schema: body,
      ...(repeatable ? { style: 'form' as const, explode: true } : {}),
    }
  })
}

function buildOperation(spec: RouteSpec, components: Components): OpenApiOperation {
  const responses: Record<string, OpenApiResponse> = {}

  for (const [status, entry] of Object.entries(spec.responses)) {
    const { schema, description, mediaType } = normalizeResponse(entry)
    const wording =
      description ?? DEFAULT_RESPONSE_DESCRIPTIONS[Number(status)] ?? 'Undocumented response.'

    responses[status] =
      schema === 'noContent'
        ? { description: wording }
        : {
            description: wording,
            content: {
              // JSON unless a registration says otherwise. The only exception
              // today is the planner's event stream, whose schema describes one
              // frame rather than the whole body.
              [mediaType ?? JSON_MEDIA_TYPE]: { schema: convert(schema, 'output', components) },
            },
          }
  }

  // Path variables first, then the query string: the order a reader meets them
  // in the URL.
  const parameters = [
    ...pathParameters(spec.path),
    ...(spec.querySchema !== undefined ? queryParameters(spec.querySchema) : []),
  ]

  // Assembled in one literal so the emitted JSON reads top to bottom — what the
  // operation is, then what it takes, then what it gives back. This document is
  // read by people as often as by generators.
  return {
    operationId: spec.operationId ?? deriveOperationId(spec),
    summary: spec.summary,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    tags: [...spec.tags],
    // An absent `security` inherits the document default, which is `[]` — no
    // auth. Only the endpoints that genuinely check a token carry a requirement.
    ...(spec.security !== undefined ? { security: [{ [BEARER_SCHEME]: [] }] } : {}),
    // Omitted entirely when empty, so the twelve operations that take neither a
    // path variable nor a query string emit exactly the JSON they did before.
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(spec.requestSchema !== undefined
      ? {
          requestBody: {
            required: true,
            content: {
              [JSON_MEDIA_TYPE]: { schema: convert(spec.requestSchema, 'input', components) },
            },
          },
        }
      : {}),
    responses,
  }
}

/** Alphabetical, so the emitted file diffs cleanly when a schema is added. */
function sortByKey(schemas: Record<string, JsonSchema>): Record<string, JsonSchema> {
  return Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)))
}

export function buildOpenApiDocument(options: BuildOptions = {}): OpenApiDocument {
  const components: Components = { schemas: {}, firstSeenAs: new Map() }
  const paths: Record<string, Record<string, OpenApiOperation>> = {}
  const operationIds = new Set<string>()

  for (const spec of getRegisteredRoutes()) {
    const operation = buildOperation(spec, components)

    // Generated clients key their methods off operationId, so a collision would
    // drop one endpoint from the web repo's client with no error at all.
    if (operationIds.has(operation.operationId)) {
      throw new Error(
        `OpenAPI: operationId "${operation.operationId}" is used by more than one operation.`
      )
    }
    operationIds.add(operation.operationId)

    const item = (paths[spec.path] ??= {})
    item[spec.method] = operation
  }

  const document: OpenApiDocument = {
    openapi: '3.1.1',
    info: {
      title: 'Beyond Borders API',
      version: API_VERSION,
      description:
        'The contract between beyond-borders-admin (which serves it) and beyond-borders-web ' +
        '(which consumes it). Generated from the same zod schemas the route handlers validate ' +
        'against, so it cannot describe a shape the server does not accept.\n\n' +
        'Success responses return the resource directly, with no envelope. Every non-2xx response ' +
        'is an `ErrorResponse`. Branch on `error.code`, never on `error.message` — the wording is ' +
        'not part of the contract.',
    },
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    servers: [...(options.servers ?? DEFAULT_SERVERS)],
    tags: [...API_TAGS],
    // No authentication by default: most of the auth surface is deliberately
    // reachable without a token, and saying so explicitly beats leaving it to
    // be inferred from the absence of a key.
    security: [],
    paths,
    components: {
      securitySchemes: {
        [BEARER_SCHEME]: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'The `accessToken` from a login or refresh response, sent as ' +
            '`Authorization: Bearer <token>`. Traveller and staff tokens are signed with ' +
            'different secrets and carry different audiences, so one is never accepted where the ' +
            'other is expected. Access tokens are short-lived and are not revocable — call the ' +
            'matching refresh endpoint when one expires.',
        },
      },
      schemas: sortByKey(components.schemas),
    },
  }

  assertReferencesResolve(document)

  return document
}
