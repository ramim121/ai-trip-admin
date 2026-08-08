import 'server-only'
import { z } from 'zod'
import { env } from '@/lib/env'
import { cached } from '@/server/providers/cache'
import { readCachedSetting } from '@/server/settings/read'

/**
 * Viator Partner API — packaged tours and day activities.
 *
 * WHAT THIS IS FOR. Viator is the only source in the stack that knows a tour's
 * departure window, its duration, and whether it includes hotel pickup — the
 * three facts that decide whether something fits a traveller's Tuesday. Google
 * Places knows a place exists; Viator knows what happens there and when.
 *
 * THE KEY NEVER LEAVES THE SERVER. `import 'server-only'` makes that a build
 * error rather than a code-review question.
 *
 * EVERY CALL GOES THROUGH THE CACHE, which is a term of use rather than an
 * optimisation: Viator expects product data to be cached and refreshed
 * periodically instead of fetched per page view. The TTLs below reflect how fast
 * each kind of answer actually goes stale.
 *
 * PRICES ARRIVE IN USD AND LEAVE IN TAKA, converted with the same admin-set
 * `bdtPerUsd` the pricing page uses — so there is exactly one place in the
 * system where a dollar becomes a taka. Asking Viator for BDT directly would
 * create a second rate nobody could reconcile against the first, and every
 * figure here is an estimate the admin replaces anyway.
 */

const PRODUCTION_HOST = 'https://api.viator.com/partner'
const SANDBOX_HOST = 'https://api.sandbox.viator.com/partner'

/**
 * How long each answer stays useful.
 *
 * Destinations are a near-static taxonomy — Krabi will still be Krabi next
 * month. Search results move as inventory does, but a traveller comparing six
 * tours does not need this morning's ordering. Product records sit between the
 * two, and Viator's terms ask for a weekly refresh at minimum.
 */
const TTL = {
  destinations: 7 * 24 * 60 * 60,
  search: 48 * 60 * 60,
  product: 72 * 60 * 60,
} as const

const REQUEST_TIMEOUT_MS = 12_000

export class ViatorError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ViatorError'
    this.status = status
  }
}

/** Whether the integration is configured. Screens ask before offering it. */
export function viatorConfigured(): boolean {
  return resolveKey() !== null
}

/**
 * Which key, and therefore which host.
 *
 * The flag decides rather than NODE_ENV: which host to call is a property of the
 * key you were issued, not of where the process runs, and a staging deploy may
 * legitimately want live inventory.
 */
function resolveKey(): { key: string; host: string } | null {
  const config = env()

  if (config.VIATOR_USE_SANDBOX) {
    const key = config.VIATOR_SANDBOX_API_KEY?.trim()
    return key ? { key, host: SANDBOX_HOST } : null
  }

  const key = config.VIATOR_API_KEY?.trim()
  return key ? { key, host: PRODUCTION_HOST } : null
}

/**
 * One HTTP call to Viator.
 *
 * `Accept: application/json;version=2.0` is not optional — Viator versions its
 * responses through that header, and omitting it returns a shape none of the
 * mappers below understand.
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resolved = resolveKey()

  if (resolved === null) {
    throw new ViatorError('Viator is not configured on this server.', 503)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response

  try {
    response = await fetch(`${resolved.host}${path}`, {
      ...init,
      headers: {
        // A header rather than a query parameter, so the key stays out of any
        // intermediary's URL logs.
        'exp-api-key': resolved.key,
        Accept: 'application/json;version=2.0',
        'Accept-Language': 'en-US',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ViatorError('Viator took too long to answer. Try again.', 504)
    }
    throw new ViatorError('Viator could not be reached.', 502)
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    /*
     * Viator's own message is logged, never forwarded to a page: error payloads
     * can echo the request, and the request carries the key in a header. The
     * status is enough for a caller to act on.
     */
    const detail = await response.text().catch(() => '')
    console.error(`[viator] ${path} failed ${response.status}: ${detail.slice(0, 400)}`)

    /*
     * VIATOR ANSWERS 400, NOT 404, FOR A CODE IT DOES NOT KNOW.
     *
     * Verified against the live API: `GET /products/ZZZZ-NOT-A-PRODUCT` returns
     * `400 BAD_REQUEST — "Invalid product code"`. Both statuses are normalised
     * to 404 here so callers can express "no such thing" once, rather than every
     * caller having to know that this particular vendor spells absence as a
     * malformed request.
     *
     * It matters because a snapshot outlives the product it describes: a tour
     * withdrawn next month must render as gone, not as a crashed page.
     */
    if (response.status === 404 || response.status === 400) {
      throw new ViatorError('Viator does not recognise that.', 404)
    }
    if (response.status === 401 || response.status === 403) {
      throw new ViatorError('Viator refused the key.', 403)
    }
    if (response.status === 429) {
      throw new ViatorError('Viator is rate-limiting us. Try again shortly.', 429)
    }
    throw new ViatorError('Viator returned an error.', 502)
  }

  return (await response.json()) as T
}

// ─────────────────────────────────────────────────────────────────────────────
// Destinations
// ─────────────────────────────────────────────────────────────────────────────

export interface ViatorDestination {
  destinationId: number
  name: string
  type: string
  parentId: number | null
}

interface RawDestination {
  destinationId?: number
  name?: string
  type?: string
  parentDestinationId?: number
}

/**
 * Viator's destination taxonomy, cached for a week.
 *
 * Roughly 3,400 near-static rows, fetched whole because every product search
 * needs a destination id and there is no lookup-by-name endpoint — resolving a
 * name means searching this list, so the list has to be here.
 */
export async function listDestinations(): Promise<ViatorDestination[]> {
  return cached(
    { provider: 'viator', endpoint: 'destinations', request: {}, ttlSeconds: TTL.destinations },
    async () => {
      const payload = await call<{ destinations?: RawDestination[] }>('/destinations')

      return (payload.destinations ?? [])
        .filter(
          (d): d is RawDestination & { destinationId: number; name: string } =>
            typeof d.destinationId === 'number' && typeof d.name === 'string'
        )
        .map((d) => ({
          destinationId: d.destinationId,
          name: d.name,
          type: d.type ?? 'UNKNOWN',
          parentId: d.parentDestinationId ?? null,
        }))
    }
  )
}

/** Cities first, then regions, then countries. */
function rank(type: string): number {
  if (type === 'CITY') return 0
  if (type === 'REGION') return 1
  if (type === 'COUNTRY') return 2
  return 3
}

/**
 * The best Viator destination for a name a traveller typed.
 *
 * PREFERS CITIES, then exact matches, then anything containing the words. A
 * traveller who says "Krabi" means the city; matching a region or a country
 * first would search a whole province and return tours four hours away.
 *
 * Returns null rather than guessing when nothing is close, because a wrong
 * destination is worse than none: it produces confident suggestions for
 * somewhere else entirely.
 */
export async function resolveDestination(name: string): Promise<ViatorDestination | null> {
  const needle = name.trim().toLowerCase()
  if (needle === '') return null

  const all = await listDestinations()

  const exact = all.filter((d) => d.name.toLowerCase() === needle)
  const pool = exact.length > 0 ? exact : all.filter((d) => d.name.toLowerCase().includes(needle))

  if (pool.length === 0) return null

  return [...pool].sort((a, b) => rank(a.type) - rank(b.type))[0] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Products
// ─────────────────────────────────────────────────────────────────────────────

export interface ViatorProduct {
  productCode: string
  title: string
  description: string | null
  /** The widest variant Viator offered, or null when a product has no imagery. */
  imageUrl: string | null
  rating: number | null
  reviewCount: number | null
  /** Minutes. Both equal for a fixed-length product, a range for a variable one. */
  durationMinMinutes: number | null
  durationMaxMinutes: number | null
  /** Whole taka, converted from Viator's USD `fromPrice`. An estimate. */
  fromPriceBdt: number | null
  /** The affiliate deep link, shown on every card per the partner agreement. */
  productUrl: string | null
  flags: string[]
}

interface RawProduct {
  productCode?: string
  title?: string
  description?: string
  images?: { variants?: { width?: number; height?: number; url?: string }[] }[]
  reviews?: { combinedAverageRating?: number; totalReviews?: number }
  duration?: {
    fixedDurationInMinutes?: number
    variableDurationFromMinutes?: number
    variableDurationToMinutes?: number
  }
  pricing?: { summary?: { fromPrice?: number }; currency?: string }
  productUrl?: string
  flags?: string[]
}

/** The widest variant — cards are wide, and upscaling a thumbnail looks poor. */
function bestImage(raw: RawProduct): string | null {
  const variants = raw.images?.[0]?.variants ?? []
  if (variants.length === 0) return null

  return [...variants].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null
}

function toProduct(raw: RawProduct, bdtRate: number | null): ViatorProduct | null {
  if (!raw.productCode || !raw.title) return null

  const fixed = raw.duration?.fixedDurationInMinutes
  const from = raw.duration?.variableDurationFromMinutes
  const to = raw.duration?.variableDurationToMinutes
  const usd = raw.pricing?.summary?.fromPrice

  return {
    productCode: raw.productCode,
    title: raw.title,
    description: raw.description ?? null,
    imageUrl: bestImage(raw),
    rating:
      typeof raw.reviews?.combinedAverageRating === 'number'
        ? raw.reviews.combinedAverageRating
        : null,
    reviewCount: typeof raw.reviews?.totalReviews === 'number' ? raw.reviews.totalReviews : null,
    durationMinMinutes: typeof fixed === 'number' ? fixed : typeof from === 'number' ? from : null,
    durationMaxMinutes: typeof fixed === 'number' ? fixed : typeof to === 'number' ? to : null,
    // Null when no rate is configured, rather than showing dollars to somebody
    // budgeting in taka — a number in the wrong currency is worse than none.
    fromPriceBdt: typeof usd === 'number' && bdtRate !== null ? Math.round(usd * bdtRate) : null,
    productUrl: raw.productUrl ?? null,
    flags: raw.flags ?? [],
  }
}

/**
 * The admin-set conversion rate, or null when nobody has set one.
 *
 * The same setting and the same short cache the pricing page uses, so a change
 * made in the console reaches tour cards at the moment it reaches plan prices.
 */
async function bdtPerUsd(): Promise<number | null> {
  return readCachedSetting('bdtPerUsd', z.number().positive())
}

export interface SearchProductsInput {
  destinationId: number
  /** 1-based, as Viator counts. */
  start?: number
  count?: number
  /** Narrow to tours that fit inside a slot, in minutes. */
  maxDurationMinutes?: number
}

/**
 * Tours at a destination, most relevant first.
 *
 * Cached for two days against the exact query: a traveller refining a brief runs
 * this repeatedly with small variations, and inventory does not move hourly.
 */
export async function searchProducts(
  input: SearchProductsInput
): Promise<{ products: ViatorProduct[]; totalCount: number }> {
  const request = {
    filtering: {
      destination: String(input.destinationId),
      ...(input.maxDurationMinutes ? { durationInMinutes: { to: input.maxDurationMinutes } } : {}),
    },
    pagination: { start: input.start ?? 1, count: Math.min(input.count ?? 12, 50) },
    currency: 'USD',
  }

  const rate = await bdtPerUsd()

  const payload = await cached<{ products?: RawProduct[]; totalCount?: number }>(
    { provider: 'viator', endpoint: 'products/search', request, ttlSeconds: TTL.search },
    () => call('/products/search', { method: 'POST', body: JSON.stringify(request) })
  )

  return {
    products: (payload.products ?? [])
      .map((raw) => toProduct(raw, rate))
      .filter((p): p is ViatorProduct => p !== null),
    totalCount: payload.totalCount ?? 0,
  }
}

/**
 * Free-text search, for when a traveller names something specific.
 *
 * Kept alongside the destination search rather than replacing it: this one
 * honours phrasing ("island hopping with lunch"), the other honours place. The
 * ranker gets broader candidates from the destination search and better
 * PARTICULAR ones from this.
 */
export async function searchFreetext(
  term: string,
  count = 12,
  destinationId?: number
): Promise<{ products: ViatorProduct[]; totalCount: number }> {
  const trimmed = term.trim()
  if (trimmed === '') return { products: [], totalCount: 0 }

  /*
   * THE DESTINATION FILTER IS NOT OPTIONAL IN PRACTICE, only in the signature.
   *
   * Viator's free-text search is global. Searching "island hopping and
   * snorkelling Phuket" without this returned a Nha Trang tour — Vietnam, 2,000
   * kilometres away — and the ranker dutifully offered it, because the ranker's
   * one hard rule is that it may only choose from the candidates it is given.
   * The model was doing exactly as told; the candidate list was wrong.
   *
   * Caught by running a real trip end to end and reading the titles. Every
   * schema check passed, every call succeeded, and the answer was Vietnam.
   */
  const request = {
    searchTerm: trimmed,
    productFiltering: destinationId === undefined ? {} : { destination: String(destinationId) },
    searchTypes: [{ searchType: 'PRODUCTS', pagination: { start: 1, count: Math.min(count, 50) } }],
    currency: 'USD',
  }

  const rate = await bdtPerUsd()

  const payload = await cached<{ products?: { results?: RawProduct[]; totalCount?: number } }>(
    { provider: 'viator', endpoint: 'search/freetext', request, ttlSeconds: TTL.search },
    () => call('/search/freetext', { method: 'POST', body: JSON.stringify(request) })
  )

  return {
    products: (payload.products?.results ?? [])
      .map((raw) => toProduct(raw, rate))
      .filter((p): p is ViatorProduct => p !== null),
    totalCount: payload.products?.totalCount ?? 0,
  }
}

export interface ViatorProductDetail extends ViatorProduct {
  inclusions: string[]
  exclusions: string[]
  /** e.g. PICKUP_AND_MEET_AT_START_POINT. Null when the product says nothing. */
  pickupType: string | null
  /** What happens, in order. Lets the elicitor describe real formats. */
  itineraryStops: string[]
  /** Named variants of one product — half day vs full day, private vs shared. */
  options: { code: string; title: string; description: string | null }[]
}

interface RawDetail extends RawProduct {
  inclusions?: { otherDescription?: string; typeDescription?: string }[]
  exclusions?: { otherDescription?: string; typeDescription?: string }[]
  logistics?: { travelerPickup?: { pickupOptionType?: string } }
  itinerary?: { itineraryItems?: { description?: string }[] }
  productOptions?: { productOptionCode?: string; title?: string; description?: string }[]
}

/** One inclusion line, however Viator chose to phrase it. */
function describeLine(entry: {
  otherDescription?: string
  typeDescription?: string
}): string | null {
  const text = entry.otherDescription?.trim() || entry.typeDescription?.trim()
  return text && text !== '' ? text : null
}

/**
 * One product in full — what an expanded card and the preference elicitor need.
 *
 * THE ELICITOR EXISTS TO ASK QUESTIONS BUILT FROM REAL PRODUCT DATA rather than
 * invented options, and this is where that data comes from: `options` are the
 * actual named variants, `pickupType` is the actual answer to "do they collect
 * me", and `itineraryStops` is what actually happens. Without this call the
 * elicitor would be guessing, which is the one thing it must never do.
 */
export async function getProduct(productCode: string): Promise<ViatorProductDetail | null> {
  const code = productCode.trim()
  if (code === '') return null

  const rate = await bdtPerUsd()

  const raw = await cached<RawDetail | null>(
    { provider: 'viator', endpoint: 'products/detail', request: { code }, ttlSeconds: TTL.product },
    async () => {
      try {
        return await call<RawDetail>(`/products/${encodeURIComponent(code)}`)
      } catch (error) {
        // A withdrawn product is a 404, and null is the honest answer — cached
        // too, so a dead code is not re-fetched on every render.
        if (error instanceof ViatorError && error.status === 404) return null
        throw error
      }
    }
  )

  if (raw === null) return null

  const base = toProduct(raw, rate)
  if (base === null) return null

  return {
    ...base,
    inclusions: (raw.inclusions ?? []).map(describeLine).filter((l): l is string => l !== null),
    exclusions: (raw.exclusions ?? []).map(describeLine).filter((l): l is string => l !== null),
    pickupType: raw.logistics?.travelerPickup?.pickupOptionType ?? null,
    itineraryStops: (raw.itinerary?.itineraryItems ?? [])
      .map((item) => item.description?.trim())
      .filter((d): d is string => typeof d === 'string' && d !== ''),
    options: (raw.productOptions ?? [])
      .filter(
        (o): o is { productOptionCode: string; title: string; description?: string } =>
          typeof o.productOptionCode === 'string' && typeof o.title === 'string'
      )
      .map((o) => ({
        code: o.productOptionCode,
        title: o.title,
        description: o.description ?? null,
      })),
  }
}
