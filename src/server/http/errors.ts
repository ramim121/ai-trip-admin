/**
 * The single error vocabulary for /api/v1.
 *
 * Every non-2xx response in this application has the same shape:
 *
 *   { "error": { "code": ErrorCode, "message": string, "details"?: [...] } }
 *
 * Handlers never build that envelope by hand. They throw an `ApiError` and let
 * `toErrorResponse` serialise it, so a route cannot accidentally invent a new
 * error format or a status the clients do not understand.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL'

/** One field-level complaint. `path` is dotted, e.g. `traveller.email`. */
export interface ErrorDetail {
  path: string
  message: string
}

export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
    details?: ErrorDetail[]
  }
}

/**
 * What clients are told when something we did not anticipate goes wrong.
 *
 * Deliberately constant: a Postgres driver error, a Prisma validation message
 * or a stack frame path all describe our internals, and handing any of them to
 * a caller is an information-disclosure bug. The real error goes to the log.
 */
export const INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred.'

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details?: ErrorDetail[]

  constructor(status: number, code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** 400 — the request was understood but its contents are not acceptable. */
export function badRequest(
  message = 'The request payload failed validation.',
  details?: ErrorDetail[]
): ApiError {
  return new ApiError(400, 'VALIDATION_FAILED', message, details)
}

/**
 * 401 — no usable credentials.
 *
 * The default message says nothing about *why*: distinguishing "expired" from
 * "forged" from "wrong audience" only helps someone probing the API.
 */
export function unauthorized(message = 'Authentication is required.'): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', message)
}

/** 403 — authenticated, but not allowed to do this. */
export function forbidden(
  message = 'You do not have permission to perform this action.'
): ApiError {
  return new ApiError(403, 'FORBIDDEN', message)
}

/** 404 — no such resource, or none this caller is permitted to see. */
export function notFound(message = 'The requested resource was not found.'): ApiError {
  return new ApiError(404, 'NOT_FOUND', message)
}

/** 409 — the request conflicts with current state (duplicate email, stale write). */
export function conflict(
  message = 'The request conflicts with the current state of the resource.'
): ApiError {
  return new ApiError(409, 'CONFLICT', message)
}

/** 429 — too many attempts. */
export function tooManyRequests(message = 'Too many requests. Please try again later.'): ApiError {
  return new ApiError(429, 'RATE_LIMITED', message)
}

/** 500 — our fault, and we are choosing to say so explicitly. */
export function internal(message = INTERNAL_ERROR_MESSAGE): ApiError {
  return new ApiError(500, 'INTERNAL', message)
}

/**
 * Serialise any thrown value into the contract envelope.
 *
 * Known `ApiError`s are reported faithfully. Everything else — a Prisma
 * failure, a TypeError, a rejected string — collapses to an opaque 500 and is
 * logged with its stack, so the detail survives where only we can read it.
 */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    // A 5xx we raised ourselves is still a bug worth a log line.
    if (e.status >= 500) {
      console.error(`[api] ${e.code}: ${e.message}\n${e.stack ?? '(no stack available)'}`)
    }

    const body: ErrorBody = {
      error: {
        code: e.code,
        message: e.message,
        ...(e.details && e.details.length > 0 ? { details: e.details } : {}),
      },
    }

    return Response.json(body, { status: e.status })
  }

  const stack =
    e instanceof Error
      ? (e.stack ?? '(no stack available)')
      : (new Error('non-Error value thrown').stack ?? '(no stack available)')

  console.error(`[api] unhandled error: ${describe(e)}\n${stack}`)

  const body: ErrorBody = {
    error: { code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE },
  }

  return Response.json(body, { status: 500 })
}

/** Best-effort one-line description of a thrown value. For the log only. */
function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e) ?? String(e)
  } catch {
    return Object.prototype.toString.call(e)
  }
}
