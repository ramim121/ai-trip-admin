import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError } from '@/server/http/errors'
import { parseJson, parseOptionalJson } from '@/server/http/validate'

/**
 * The two body parsers differ in exactly one behaviour, and these tests exist to
 * pin it down: `parseJson` refuses an absent body and `parseOptionalJson`
 * accepts one. Everything else about them must stay identical, so most of what
 * is asserted below is the sameness rather than the difference.
 *
 * The last group is the point. A plain `fetch(url, { method: 'POST' })` sends
 * neither a body nor a content-type — the simplest call any client can make, and
 * exactly what the web app's `request()` helper produces when given no body. On
 * a route whose fields are all optional that must succeed, or the simplest
 * correct call is the one that fails.
 */

const AllOptional = z.object({ note: z.string().trim().max(10).optional() })
const Required = z.object({ accept: z.boolean() })

function post(body?: string): Request {
  return new Request('https://example.test/x', {
    method: 'POST',
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  })
}

/** The status an ApiError carries, or a description of anything else that happened. */
async function statusOf(run: () => Promise<unknown>): Promise<number | string> {
  try {
    await run()
    return 'threw nothing'
  } catch (error) {
    return error instanceof ApiError ? error.status : `threw ${String(error)}`
  }
}

describe('parseJson', () => {
  it('parses a well-formed body', async () => {
    await expect(parseJson(post('{"accept":true}'), Required)).resolves.toEqual({ accept: true })
  })

  it('rejects an absent body — a POST that forgot its payload is a bug', async () => {
    expect(await statusOf(() => parseJson(post(), Required))).toBe(400)
  })

  it('rejects a body that fails the schema', async () => {
    expect(await statusOf(() => parseJson(post('{"accept":"yes"}'), Required))).toBe(400)
  })
})

describe('parseOptionalJson', () => {
  it('parses a well-formed body exactly as parseJson would', async () => {
    await expect(parseOptionalJson(post('{"note":"hi"}'), AllOptional)).resolves.toEqual({
      note: 'hi',
    })
  })

  it('still applies the schema — an optional body is not an unvalidated one', async () => {
    expect(
      await statusOf(() => parseOptionalJson(post('{"note":"far too long to pass"}'), AllOptional))
    ).toBe(400)
  })

  it('still rejects malformed JSON rather than treating it as absent', async () => {
    expect(await statusOf(() => parseOptionalJson(post('{"note":'), AllOptional))).toBe(400)
  })

  // ── The whole point ───────────────────────────────────────────────────────

  it('accepts a POST with no body at all', async () => {
    await expect(parseOptionalJson(post(), AllOptional)).resolves.toEqual({})
  })

  it('accepts an empty-string body, which is what the web BFF forwards for no body', async () => {
    await expect(parseOptionalJson(post(''), AllOptional)).resolves.toEqual({})
  })

  it('accepts a whitespace-only body', async () => {
    await expect(parseOptionalJson(post('  \n '), AllOptional)).resolves.toEqual({})
  })

  it('still enforces a genuinely required field, so it is not a way around validation', async () => {
    expect(await statusOf(() => parseOptionalJson(post(), Required))).toBe(400)
  })
})
