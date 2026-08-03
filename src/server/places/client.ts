import 'server-only'
import { env } from '@/lib/env'

/**
 * Google Places (New) — the only place this app talks to Google about venues.
 *
 * THE KEY NEVER LEAVES THE SERVER. `import 'server-only'` makes that a build
 * error rather than a code-review question, and the whole import flow is
 * server-rendered so no component ever needs it. A Places key in a browser
 * bundle is a key anybody can spend, and the usual way that happens is a map
 * widget somebody adds later.
 *
 * THIS MODULE READS AND RETURNS. It does not write to the database, does not
 * decide what is worth selling, and knows nothing about `activities`. Everything
 * it hands back is a candidate for a human to judge — the places service
 * explains why that boundary is a separate table rather than a flag.
 *
 * WHAT WE ASK FOR IS DELIBERATELY NARROW. Places bills by field mask: photos and
 * reviews cost materially more per call, and neither survives into our
 * catalogue, because an approved Activity carries the curator's own prose and
 * our own images. So the mask below is the smallest set that lets somebody
 * decide "is this real, where is it, and is it worth a look".
 */

const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

/**
 * The fields requested, and therefore the fields billed.
 *
 * `places.id` is the one field Google's terms allow keeping indefinitely; the
 * rest is short-lived reference material for the review screen. Adding
 * `places.photos` or `places.reviews` moves the call into a higher billing tier
 * — do not, without first deciding what they would be for.
 */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.location',
  'places.regularOpeningHours.weekdayDescriptions',
].join(',')

/** How many results one search may return. Places caps this at 20. */
const MAX_RESULTS = 20

const REQUEST_TIMEOUT_MS = 10_000

export interface PlaceResult {
  googlePlaceId: string
  name: string
  formattedAddress: string | null
  types: string[]
  rating: number | null
  userRatingCount: number | null
  /** Google's band, e.g. `PRICE_LEVEL_MODERATE`. Not a price. */
  priceLevel: string | null
  websiteUri: string | null
  googleMapsUri: string | null
  latitude: number | null
  longitude: number | null
  /** Google's own weekday lines, joined. Prose for a curator, not a schedule. */
  openingHoursText: string | null
}

export class PlacesError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'PlacesError'
    this.status = status
  }
}

/** Whether the integration is configured at all. Screens ask before offering it. */
export function placesConfigured(): boolean {
  const key = env().GOOGLE_PLACES_API_KEY
  return typeof key === 'string' && key.trim() !== ''
}

/** Shapes below describe only what FIELD_MASK asks for. */
interface RawPlace {
  id?: string
  displayName?: { text?: string }
  formattedAddress?: string
  types?: string[]
  rating?: number
  userRatingCount?: number
  priceLevel?: string
  websiteUri?: string
  googleMapsUri?: string
  location?: { latitude?: number; longitude?: number }
  regularOpeningHours?: { weekdayDescriptions?: string[] }
}

function toResult(raw: RawPlace): PlaceResult | null {
  // No id means nothing can be de-duplicated against it later, which makes the
  // row unusable rather than merely incomplete.
  if (!raw.id) return null

  const name = raw.displayName?.text?.trim()
  if (!name) return null

  const hours = raw.regularOpeningHours?.weekdayDescriptions
  const location = raw.location

  return {
    googlePlaceId: raw.id,
    name,
    formattedAddress: raw.formattedAddress ?? null,
    types: raw.types ?? [],
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    userRatingCount: typeof raw.userRatingCount === 'number' ? raw.userRatingCount : null,
    priceLevel: raw.priceLevel ?? null,
    websiteUri: raw.websiteUri ?? null,
    googleMapsUri: raw.googleMapsUri ?? null,
    latitude: typeof location?.latitude === 'number' ? location.latitude : null,
    longitude: typeof location?.longitude === 'number' ? location.longitude : null,
    openingHoursText: hours && hours.length > 0 ? hours.join('\n') : null,
  }
}

export interface SearchPlacesInput {
  /** What to look for, e.g. "beach resorts in Cox's Bazar". */
  query: string
  /**
   * Bias results toward a point, when the destination has coordinates.
   *
   * A BIAS AND NOT A RESTRICTION, deliberately. Restricting would silently drop
   * a genuinely relevant place just outside an arbitrary circle — the jetty for
   * an island trip, an airport an hour away — and a curator is better placed to
   * judge that than a radius is. The address shows on the review screen, so a
   * wrong-country result is obvious rather than hidden.
   */
  latitude?: number | null
  longitude?: number | null
  radiusMetres?: number
}

/**
 * Search Google for venues.
 *
 * Failures throw `PlacesError` carrying a status, so a screen can tell "we are
 * not configured" from "the key was refused" from "Google is down" — three
 * different things to tell somebody, all of which look identical if a failure
 * just returns an empty list.
 */
export async function searchPlaces(input: SearchPlacesInput): Promise<PlaceResult[]> {
  const key = env().GOOGLE_PLACES_API_KEY

  if (!key || key.trim() === '') {
    throw new PlacesError('Google Places is not configured on this server.', 503)
  }

  const query = input.query.trim()
  if (query === '') return []

  const body: Record<string, unknown> = { textQuery: query, maxResultCount: MAX_RESULTS }

  if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
    body.locationBias = {
      circle: {
        center: { latitude: input.latitude, longitude: input.longitude },
        radius: input.radiusMetres ?? 50_000,
      },
    }
  }

  // A hung request would hold a server-rendered page open until the platform
  // timeout, which reads to the curator as a broken screen rather than as a slow
  // upstream.
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response

  try {
    response = await fetch(PLACES_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The key travels as a header rather than a query parameter, so it does
        // not end up in any intermediary's URL logs.
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PlacesError('Google took too long to answer. Try again.', 504)
    }
    throw new PlacesError('Google could not be reached.', 502)
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    /*
     * Google's own message is logged but never forwarded verbatim.
     *
     * Error payloads can quote the request back, and the request carries the key
     * in a header. The status is enough for a curator to act on; the detail
     * belongs in the server log where the key is not being rendered to a page.
     */
    const detail = await response.text().catch(() => '')
    console.error(`[places] search failed ${response.status}: ${detail.slice(0, 500)}`)

    if (response.status === 400) {
      throw new PlacesError('Google rejected that search. Try different wording.', 400)
    }
    /*
     * A 403 here usually means "Places API (New) is not enabled", not "bad key".
     *
     * The two Places products are separate Google Cloud services and a key
     * enabled for one is refused by the other with API_KEY_SERVICE_BLOCKED. So
     * this falls back to the legacy endpoint rather than failing: a project with
     * only legacy enabled — which is this one today — otherwise gets a feature
     * that returns nothing until somebody finds a checkbox in a console.
     *
     * If legacy is off too it raises its own error, so a genuinely bad key still
     * surfaces as one rather than being swallowed by the fallback.
     */
    if (response.status === 403) {
      console.warn('[places] Places API (New) refused the key; falling back to legacy Text Search')
      return searchLegacy(key, input)
    }
    if (response.status === 429) {
      throw new PlacesError('Google is rate-limiting us. Wait a moment and try again.', 429)
    }
    throw new PlacesError('Google returned an error.', 502)
  }

  const payload = (await response.json().catch(() => null)) as { places?: RawPlace[] } | null

  // A missing `places` key is what Google returns for "nothing matched" — a
  // successful search with no results, rather than a failure.
  return (payload?.places ?? [])
    .map(toResult)
    .filter((place): place is PlaceResult => place !== null)
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Places
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The older Text Search endpoint, used only when the new one is switched off.
 *
 * WHY BOTH EXIST. Google has two Places products, and a key enabled for one is
 * refused by the other with `API_KEY_SERVICE_BLOCKED`. Which one a project has
 * is a Google Cloud setting nobody can discover from here without trying. This
 * project's key is currently enabled for legacy and not for New, so a
 * New-only client would ship a feature that returns nothing until somebody
 * notices a console checkbox.
 *
 * NEW IS TRIED FIRST AND THIS IS THE FALLBACK, never the other way round.
 * Legacy is closed to new Google projects and is the one that will eventually
 * stop; preferring it would mean the integration quietly rots on the deprecated
 * path even after the good one becomes available. Enabling "Places API (New)"
 * makes this function stop being called, with no code change.
 *
 * The two return different shapes, and everything below exists to erase that
 * difference — callers see `PlaceResult` and never learn which endpoint served
 * them.
 */
const LEGACY_ENDPOINT = 'https://maps.googleapis.com/maps/api/place/textsearch/json'

interface LegacyPlace {
  place_id?: string
  name?: string
  formatted_address?: string
  types?: string[]
  rating?: number
  user_ratings_total?: number
  price_level?: number
  geometry?: { location?: { lat?: number; lng?: number } }
  opening_hours?: { open_now?: boolean }
}

/**
 * Legacy's 0–4 integer, spelled the way the new API spells it.
 *
 * Normalised at the boundary rather than stored raw, so nothing downstream has
 * to know which endpoint a row came from. It is a band either way and never a
 * price — `PRICE_LEVEL_MODERATE` says nothing in taka, which is exactly why the
 * curator types a real figure.
 */
const LEGACY_PRICE_LEVELS = [
  'PRICE_LEVEL_FREE',
  'PRICE_LEVEL_INEXPENSIVE',
  'PRICE_LEVEL_MODERATE',
  'PRICE_LEVEL_EXPENSIVE',
  'PRICE_LEVEL_VERY_EXPENSIVE',
] as const

function fromLegacy(raw: LegacyPlace): PlaceResult | null {
  if (!raw.place_id) return null

  const name = raw.name?.trim()
  if (!name) return null

  const location = raw.geometry?.location
  const level =
    typeof raw.price_level === 'number' ? (LEGACY_PRICE_LEVELS[raw.price_level] ?? null) : null

  return {
    googlePlaceId: raw.place_id,
    name,
    formattedAddress: raw.formatted_address ?? null,
    types: raw.types ?? [],
    rating: typeof raw.rating === 'number' ? raw.rating : null,
    userRatingCount: typeof raw.user_ratings_total === 'number' ? raw.user_ratings_total : null,
    priceLevel: level,
    // Text Search returns neither on this endpoint. Null rather than a guessed
    // URL: the review screen links to Google by place id instead.
    websiteUri: null,
    googleMapsUri: null,
    latitude: typeof location?.lat === 'number' ? location.lat : null,
    longitude: typeof location?.lng === 'number' ? location.lng : null,
    // Legacy text search carries only `open_now`, which is a fact about the
    // moment of the request rather than a schedule, and useless a minute later.
    // Left null so the curator fills in real hours from the venue itself.
    openingHoursText: null,
  }
}

async function searchLegacy(key: string, input: SearchPlacesInput): Promise<PlaceResult[]> {
  const url = new URL(LEGACY_ENDPOINT)
  url.searchParams.set('query', input.query.trim())
  url.searchParams.set('key', key)

  if (typeof input.latitude === 'number' && typeof input.longitude === 'number') {
    url.searchParams.set('location', `${input.latitude},${input.longitude}`)
    url.searchParams.set('radius', String(input.radiusMetres ?? 50_000))
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response

  try {
    response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PlacesError('Google took too long to answer. Try again.', 504)
    }
    throw new PlacesError('Google could not be reached.', 502)
  } finally {
    clearTimeout(timeout)
  }

  const payload = (await response.json().catch(() => null)) as {
    status?: string
    results?: LegacyPlace[]
    error_message?: string
  } | null

  /*
   * Legacy answers 200 with a status string, so `response.ok` proves nothing.
   *
   * ZERO_RESULTS is a successful search that matched nothing; everything else
   * that is not OK is a failure the curator needs told about.
   */
  if (payload?.status === 'ZERO_RESULTS') return []

  if (!response.ok || payload?.status !== 'OK') {
    console.error(
      `[places] legacy search failed http=${response.status} status=${payload?.status ?? 'none'}: ${
        payload?.error_message ?? ''
      }`
    )

    if (payload?.status === 'OVER_QUERY_LIMIT') {
      throw new PlacesError('Google is rate-limiting us. Wait a moment and try again.', 429)
    }
    if (payload?.status === 'REQUEST_DENIED') {
      throw new PlacesError('Google refused the key for Places searches.', 403)
    }
    throw new PlacesError('Google returned an error.', 502)
  }

  return (payload.results ?? [])
    .map(fromLegacy)
    .filter((place): place is PlaceResult => place !== null)
}
