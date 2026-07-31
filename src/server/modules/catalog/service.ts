import type { Prisma } from '@/generated/prisma/client'
import type {
  ActivityCategory,
  ActivityIntensity,
  TimeOfDay,
  TransitMode,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'

/**
 * Reads against the curated catalog.
 *
 * Everything the planner may recommend passes through here, and every search
 * filters on `isActive` by default. That is not a convenience: an activity ops
 * has retired is inventory we cannot sell, and the one place a retired row must
 * never reappear is a plan the model is building right now. Callers that need to
 * see retired rows — the admin console, and id resolution on an itinerary that
 * already exists — have to ask for them explicitly, and get `isActive` reported
 * back rather than hidden.
 *
 * Everything in this file is a READ. Catalog writes live in `admin.ts` behind a
 * staff guard, so nothing the AI layer can reach — directly or through a tool —
 * is able to change a row. Callers describe what they want in typed arguments;
 * the SQL is assembled here, so no caller can smuggle in a predicate we did not
 * write.
 *
 * Three ideas run through the module:
 *
 *   • Ranking is a pure function over rows already fetched. Interest matching is
 *     fuzzy — "street food" has to find `street-food` — and fuzzy logic inside a
 *     SQL string is logic nobody can unit test. Postgres does the *filtering*,
 *     which it is good at; the ordering happens in `rankActivities`, which a
 *     test drives with three object literals and no database at all.
 *
 *   • Travel time is an ESTIMATE and says so in its own return type. We have
 *     coordinates, not a routing engine. A number presented as measured would be
 *     believed, and a traveller who misses a ferry because we implied a
 *     precision we never had was let down by us, not by the road.
 *
 *   • Opening hours follow schema.prisma's convention exactly. Getting it
 *     backwards would either hide every public beach from every search, or
 *     schedule a museum on the day it shuts.
 *
 * Nothing here imports the AI SDK. `tools.ts` wraps these functions into tool
 * definitions; keeping the two apart means the itinerary service can reuse the
 * same reads without pulling a model provider into scope.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Limits
//
// Every list this module can return is bounded. An unbounded `take` is one bad
// caller away from loading the catalog into memory — and, since these results
// are fed to a language model, one bad caller away from an unbounded token bill.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 25
export const MAX_DESTINATION_RESULTS = 50

/**
 * How many rows are fetched before ranking.
 *
 * Ranking happens in memory, so the pool has to be wider than the limit — a
 * strong interest match sitting at position 26 by curated order would otherwise
 * never be seen. It is still bounded: this is curated inventory in the low
 * thousands, not a web index.
 */
export const CANDIDATE_POOL_SIZE = 200

export const MAX_EXCLUDED_IDS = 100
export const MAX_INTERESTS = 20

/** Minutes from local midnight. Matches ItineraryBlock and ActivityOpeningHours. */
export const MINUTES_IN_DAY = 1440

/** A block may run to the following midnight, so 2880 is the outer bound. */
export const MAX_BLOCK_END_MINUTE = MINUTES_IN_DAY * 2

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** Coordinates as plain numbers. Decimal(9,6) in, float out, converted once. */
export interface GeoPoint {
  latitude: number
  longitude: number
}

/** One opening window, minutes from local midnight. `closes` may exceed 1440. */
export interface OpeningWindow {
  /** 0 = Sunday … 6 = Saturday, matching JavaScript's Date#getDay(). */
  dayOfWeek: number
  opensMinute: number
  closesMinute: number
}

export interface OpeningWindowRow extends OpeningWindow {
  id: string
}

export interface TagSummary {
  slug: string
  label: string
}

export interface ActivityImageSummary {
  id: string
  url: string
  alt: string
  sortOrder: number
}

export interface DestinationSummary {
  id: string
  slug: string
  name: string
  country: string
  region: string | null
  summary: string
  timezone: string
  heroImageUrl: string | null
  location: GeoPoint | null
  isActive: boolean
  sortOrder: number
  /** Published activities only — a draft is not something to advertise a count of. */
  activityCount: number
}

/** The destination as seen from one of its activities. */
export interface ActivityDestination {
  id: string
  slug: string
  name: string
  country: string
  timezone: string
}

export interface ActivitySummary {
  id: string
  slug: string
  destinationId: string
  name: string
  summary: string
  category: ActivityCategory
  durationMinutes: number
  pricePerPersonBdt: number | null
  priceNote: string | null
  bestTimeOfDay: TimeOfDay
  intensity: ActivityIntensity
  bookingRequired: boolean
  minPartySize: number | null
  maxPartySize: number | null
  location: GeoPoint | null
  tags: TagSummary[]
  isActive: boolean
  sortOrder: number
  destination: ActivityDestination
  primaryImage: ActivityImageSummary | null
}

export interface ActivityDetail extends ActivitySummary {
  description: string
  sourceUrl: string | null
  images: ActivityImageSummary[]
  openingHours: OpeningWindowRow[]
  createdAt: Date
  updatedAt: Date
}

/** A search hit, annotated with why it ranked where it did. */
export interface RankedActivity extends ActivitySummary {
  /** Weighted tag overlap. See `scoreInterestMatch` for the weights. */
  matchScore: number
  /** The caller's own interest strings that hit something, verbatim. */
  matchedInterests: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Prisma selections
//
// Written out field by field rather than spread from a model. Selecting a table
// wholesale means every column added later is published by default, and the
// catalog will grow internal columns — cost price, supplier, review notes — that
// have no business reaching a traveller, let alone a language model.
// ─────────────────────────────────────────────────────────────────────────────

const DESTINATION_SELECT = {
  id: true,
  slug: true,
  name: true,
  country: true,
  region: true,
  summary: true,
  timezone: true,
  heroImageUrl: true,
  latitude: true,
  longitude: true,
  isActive: true,
  sortOrder: true,
  // Filtered relation count: the public number must not include drafts.
  _count: { select: { activities: { where: { isActive: true } } } },
} satisfies Prisma.DestinationSelect

const ACTIVITY_SELECT = {
  id: true,
  slug: true,
  destinationId: true,
  name: true,
  summary: true,
  category: true,
  durationMinutes: true,
  pricePerPersonBdt: true,
  priceNote: true,
  bestTimeOfDay: true,
  intensity: true,
  bookingRequired: true,
  minPartySize: true,
  maxPartySize: true,
  latitude: true,
  longitude: true,
  isActive: true,
  sortOrder: true,
  // Enough of the destination to render an activity on its own page, and no
  // more. The full destination record — hero image, summary, activity count —
  // belongs to the destination endpoints.
  destination: { select: { id: true, slug: true, name: true, country: true, timezone: true } },
  tags: { select: { tag: { select: { slug: true, label: true } } } },
  images: {
    select: { id: true, url: true, alt: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  },
} satisfies Prisma.ActivitySelect

const ACTIVITY_DETAIL_SELECT = {
  ...ACTIVITY_SELECT,
  description: true,
  sourceUrl: true,
  createdAt: true,
  updatedAt: true,
  openingHours: {
    select: { id: true, dayOfWeek: true, opensMinute: true, closesMinute: true },
    orderBy: [{ dayOfWeek: 'asc' }, { opensMinute: 'asc' }],
  },
} satisfies Prisma.ActivitySelect

/**
 * Prisma returns Decimal columns as decimal.js instances so a coordinate
 * survives the round trip exactly. Arithmetic needs a float, so the conversion
 * happens once, here, through the string form — `Number(d)` would rely on
 * `valueOf`, which decimal.js does define but which is not part of any contract
 * worth depending on.
 */
type DecimalLike = { toString(): string }

export function toCoordinate(
  value: DecimalLike | string | number | null | undefined
): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(parsed) ? parsed : null
}

export function toPoint(
  latitude: DecimalLike | string | number | null | undefined,
  longitude: DecimalLike | string | number | null | undefined
): GeoPoint | null {
  const lat = toCoordinate(latitude)
  const lon = toCoordinate(longitude)
  // A half-known position is worse than none: it would place an activity on the
  // equator or the prime meridian and make every estimate around it wrong.
  return lat === null || lon === null ? null : { latitude: lat, longitude: lon }
}

interface ActivityRow {
  id: string
  slug: string
  destinationId: string
  name: string
  summary: string
  category: ActivityCategory
  durationMinutes: number
  pricePerPersonBdt: number | null
  priceNote: string | null
  bestTimeOfDay: TimeOfDay
  intensity: ActivityIntensity
  bookingRequired: boolean
  minPartySize: number | null
  maxPartySize: number | null
  latitude: DecimalLike | null
  longitude: DecimalLike | null
  isActive: boolean
  sortOrder: number
  destination: ActivityDestination
  tags: { tag: TagSummary }[]
  images: ActivityImageSummary[]
}

function toSummary(row: ActivityRow): ActivitySummary {
  return {
    id: row.id,
    slug: row.slug,
    destinationId: row.destinationId,
    name: row.name,
    summary: row.summary,
    category: row.category,
    durationMinutes: row.durationMinutes,
    pricePerPersonBdt: row.pricePerPersonBdt,
    priceNote: row.priceNote,
    bestTimeOfDay: row.bestTimeOfDay,
    intensity: row.intensity,
    bookingRequired: row.bookingRequired,
    minPartySize: row.minPartySize,
    maxPartySize: row.maxPartySize,
    location: toPoint(row.latitude, row.longitude),
    tags: row.tags.map((link) => link.tag),
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    destination: row.destination,
    primaryImage: row.images[0] ?? null,
  }
}

type ActivityDetailRow = ActivityRow & {
  description: string
  sourceUrl: string | null
  createdAt: Date
  updatedAt: Date
  openingHours: OpeningWindowRow[]
}

function toDetail(row: ActivityDetailRow): ActivityDetail {
  return {
    ...toSummary(row),
    description: row.description,
    sourceUrl: row.sourceUrl,
    images: row.images,
    openingHours: row.openingHours,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

interface DestinationRow {
  id: string
  slug: string
  name: string
  country: string
  region: string | null
  summary: string
  timezone: string
  heroImageUrl: string | null
  latitude: DecimalLike | null
  longitude: DecimalLike | null
  isActive: boolean
  sortOrder: number
  _count: { activities: number }
}

function toDestinationSummary(row: DestinationRow): DestinationSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    country: row.country,
    region: row.region,
    summary: row.summary,
    timezone: row.timezone,
    heroImageUrl: row.heroImageUrl,
    location: toPoint(row.latitude, row.longitude),
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    activityCount: row._count.activities,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interest matching
//
// A trip brief says "street food and temples, nothing strenuous". The catalog
// says `street-food` and `temples`. Reconciling those is a text problem, not a
// SQL problem, and doing it here rather than in a `LIKE` makes it both testable
// and cheap to change as the interest vocabulary grows.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `"  Street  Food! "` → `street-food`.
 *
 * Lowercased, whitespace and underscores folded to hyphens, anything that is not
 * a letter, a digit or a hyphen dropped. The result is directly comparable with
 * a `Tag.slug`, which the seed writes by the same rules.
 */
export function normaliseInterest(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The crudest possible stemmer, and deliberately so.
 *
 * It exists for one job: making "beaches" find `beach` and "temple" find
 * `temples`. It is applied to BOTH sides of every comparison, so it does not
 * have to be linguistically correct — only consistent.
 *
 * The order of the rules is the whole of the difficulty. Stripping `es` first
 * and unconditionally turns "temples" into `templ` while "temple" stays whole,
 * and the two never meet — which is exactly the bug the tests caught. So `es`
 * comes off only after a sibilant, where English actually inserts it
 * ("beaches", "buses", "boxes"), and everything else loses a bare `s`.
 *
 * The `ss` guard keeps "glass" from becoming "glas", and the length guards keep
 * real three-letter slugs — `bus`, `spa` — intact.
 */
export function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 4 && /(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function stemAll(slug: string): string[] {
  return slug.split('-').filter(Boolean).map(stemToken)
}

/** Weight for an interest that names a whole tag: "snorkelling" → `snorkelling`. */
export const EXACT_TAG_MATCH_WEIGHT = 2

/** Weight for a partial hit: "heritage" → `cultural-heritage`. */
export const PARTIAL_TAG_MATCH_WEIGHT = 1

/**
 * How strongly one interest matches one tag.
 *
 * Two levels, exact and partial, rather than a similarity score. A curated
 * vocabulary of a hundred slugs does not need edit distance, and a score nobody
 * can predict is a score nobody can debug when a traveller asks why a temple was
 * suggested for a beach holiday.
 */
export function scoreInterestMatch(interest: string, tag: TagSummary): number {
  const wanted = normaliseInterest(interest)
  if (wanted.length === 0) return 0

  const slug = normaliseInterest(tag.slug)
  const label = normaliseInterest(tag.label)

  if (wanted === slug || wanted === label) return EXACT_TAG_MATCH_WEIGHT

  const wantedTokens = new Set(stemAll(wanted))
  if (wantedTokens.size === 0) return 0

  const slugTokens = stemAll(slug)
  const labelTokens = stemAll(label)

  // Exact means the interest and the tag describe the SAME thing once plurals
  // are folded: "beaches" against `beach`, "temple" against `temples`. It is a
  // set comparison, not a containment test — "heritage" covers one token of
  // `cultural-heritage` and is not the same interest, so it must not score as
  // highly as a tag the traveller actually named.
  const sameConcept = (tokens: string[]): boolean =>
    tokens.length === wantedTokens.size && tokens.every((token) => wantedTokens.has(token))

  if (sameConcept(slugTokens) || sameConcept(labelTokens)) return EXACT_TAG_MATCH_WEIGHT

  const tagTokens = new Set([...slugTokens, ...labelTokens])
  return [...wantedTokens].some((token) => tagTokens.has(token)) ? PARTIAL_TAG_MATCH_WEIGHT : 0
}

/** The minimum an activity needs in order to be ranked. */
export interface Rankable {
  name: string
  sortOrder: number
  tags: TagSummary[]
}

export interface RankOutcome {
  matchScore: number
  matchedInterests: string[]
}

/**
 * Score one activity against the requested interests.
 *
 * Each interest contributes its single best tag hit, not the sum over every tag
 * it touches. Otherwise an activity carrying `beach`, `beaches` and `seaside`
 * would beat a better one three times over for the single word "beach", and the
 * ranking would reward tag spam by whoever wrote the row.
 */
export function scoreActivity(activity: Rankable, interests: readonly string[]): RankOutcome {
  let matchScore = 0
  const matchedInterests: string[] = []

  for (const interest of interests) {
    let best = 0
    for (const tag of activity.tags) {
      const score = scoreInterestMatch(interest, tag)
      if (score > best) best = score
    }
    if (best > 0) {
      matchScore += best
      matchedInterests.push(interest)
    }
  }

  return { matchScore, matchedInterests }
}

/**
 * Order a candidate set.
 *
 * Interest overlap first, then curated position, then name.
 *
 * There is no rating column in the catalog — nothing collects traveller scores
 * yet — so `sortOrder`, which is the content team's own judgement of what to
 * lead with, is the whole of the secondary signal. A rating belongs between the
 * two once one exists, and this is the only place that would need to change.
 *
 * The name is a final tie-break so the ordering is total. Two activities with
 * equal score and equal `sortOrder` must not swap places between two identical
 * requests: the planner shows a shortlist, the traveller reloads, and a list
 * that reshuffles itself looks broken.
 */
export function rankActivities<T extends Rankable>(
  activities: readonly T[],
  interests: readonly string[]
): (T & RankOutcome)[] {
  const scored = activities.map((activity) => ({
    ...activity,
    ...scoreActivity(activity, interests),
  }))

  return scored.sort((a, b) => {
    if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore
    if (a.matchedInterests.length !== b.matchedInterests.length) {
      return b.matchedInterests.length - a.matchedInterests.length
    }
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    if (a.name === b.name) return 0
    // Code-unit order, not localeCompare: the point of this tie-break is that it
    // gives the same answer on every machine, and collation is locale-dependent.
    return a.name < b.name ? -1 : 1
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Destinations
// ─────────────────────────────────────────────────────────────────────────────

export interface ListDestinationsOptions {
  /** Matched against name, slug, country and region, case-insensitively. */
  query?: string | undefined
  /** Staff listings need retired destinations; the public API never does. */
  includeInactive?: boolean | undefined
  limit?: number | undefined
}

/** Every destination Beyond Borders sells, in curated order. */
export async function listDestinations(
  options: ListDestinationsOptions = {}
): Promise<DestinationSummary[]> {
  const query = options.query?.trim()
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit ?? MAX_DESTINATION_RESULTS)),
    MAX_DESTINATION_RESULTS
  )

  const rows = await db.destination.findMany({
    where: {
      ...(options.includeInactive ? {} : { isActive: true }),
      ...(query
        ? {
            OR: [
              { name: { contains: query, mode: 'insensitive' as const } },
              { slug: { contains: query, mode: 'insensitive' as const } },
              { country: { contains: query, mode: 'insensitive' as const } },
              { region: { contains: query, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    },
    select: DESTINATION_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: limit,
  })

  return rows.map(toDestinationSummary)
}

export async function getDestinationBySlug(
  slug: string,
  options: { includeInactive?: boolean } = {}
): Promise<DestinationSummary | null> {
  const row = await db.destination.findUnique({ where: { slug }, select: DESTINATION_SELECT })

  if (row === null) return null
  // "Unknown slug" and "retired destination" are the same answer to a public
  // caller, so the route can turn both into one 404.
  if (!row.isActive && !options.includeInactive) return null

  return toDestinationSummary(row)
}

/**
 * Best-effort match from the free text in a brief to a catalog destination.
 *
 * Returns null rather than guessing when the text matches nothing, or matches
 * several places equally well. An itinerary carrying the wrong `destinationId`
 * would draw its activities from the wrong city — a far more expensive mistake
 * than leaving the id null and keeping the traveller's own label.
 */
export async function matchDestination(label: string): Promise<DestinationSummary | null> {
  const trimmed = label.trim()
  if (trimmed.length === 0) return null

  const candidates = await listDestinations({ query: trimmed })
  if (candidates.length === 0) return null

  const exact = candidates.find((row) => row.name.toLowerCase() === trimmed.toLowerCase())
  if (exact) return exact

  return candidates.length === 1 ? candidates[0] : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

export interface SearchActivitiesInput {
  destinationId?: string | undefined
  destinationSlug?: string | undefined
  /** Free-text interests from the trip brief, matched against tag slugs and labels. */
  interests?: readonly string[] | undefined
  category?: ActivityCategory | undefined
  /** An activity whose best time is ANY fits every slot and is never filtered out. */
  timeOfDay?: TimeOfDay | undefined
  maxDurationMinutes?: number | undefined
  maxPricePerPersonBdt?: number | undefined
  partySize?: number | undefined
  /** Already scheduled, or already rejected. Stops a second call repeating itself. */
  excludeActivityIds?: readonly string[] | undefined
  limit?: number | undefined
  /** Free text matched against name, summary and slug. */
  query?: string | undefined
  /** Staff listings only. The public API and every AI tool leave this false. */
  includeUnpublished?: boolean | undefined
}

export interface SearchActivitiesResult {
  activities: RankedActivity[]
  /** Candidates that passed the filters, before `limit` was applied. */
  matched: number
  /** True when the candidate pool filled up and there may be more behind it. */
  truncated: boolean
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_SEARCH_LIMIT)
}

/**
 * Build the WHERE clause.
 *
 * Split out because two of these rules are counter-intuitive enough to be worth
 * stating on their own:
 *
 *   • `pricePerPersonBdt` is null both for free sights AND for "price on
 *     request". A budget filter that dropped nulls would hide every free beach
 *     and viewpoint in the catalog, which is the opposite of what a
 *     budget-conscious traveller asked for. Nulls stay; `priceNote` explains
 *     them.
 *
 *   • `bestTimeOfDay = ANY` means "works whenever", so it satisfies every
 *     `timeOfDay` request rather than none of them.
 *
 * Every disjunction is collected into one `AND` list rather than assigned to
 * `OR` in turn — a second `OR:` key would silently replace the first and quietly
 * widen the search.
 */
function buildActivityWhere(input: SearchActivitiesInput): Prisma.ActivityWhereInput {
  const and: Prisma.ActivityWhereInput[] = []

  if (input.destinationId !== undefined) and.push({ destinationId: input.destinationId })
  if (input.destinationSlug !== undefined) and.push({ destination: { slug: input.destinationSlug } })
  if (input.category !== undefined) and.push({ category: input.category })

  if (input.timeOfDay !== undefined && input.timeOfDay !== 'ANY') {
    and.push({ bestTimeOfDay: { in: [input.timeOfDay, 'ANY'] } })
  }

  if (input.maxDurationMinutes !== undefined) {
    and.push({ durationMinutes: { lte: input.maxDurationMinutes } })
  }

  if (input.maxPricePerPersonBdt !== undefined) {
    and.push({
      OR: [{ pricePerPersonBdt: null }, { pricePerPersonBdt: { lte: input.maxPricePerPersonBdt } }],
    })
  }

  if (input.partySize !== undefined) {
    // A null bound means "no bound", so it satisfies any party size.
    and.push({ OR: [{ minPartySize: null }, { minPartySize: { lte: input.partySize } }] })
    and.push({ OR: [{ maxPartySize: null }, { maxPartySize: { gte: input.partySize } }] })
  }

  if (input.query !== undefined && input.query.trim() !== '') {
    const query = input.query.trim()
    and.push({
      OR: [
        { name: { contains: query, mode: 'insensitive' as const } },
        { summary: { contains: query, mode: 'insensitive' as const } },
        { slug: { contains: query, mode: 'insensitive' as const } },
      ],
    })
  }

  const excluded = [...new Set(input.excludeActivityIds ?? [])].slice(0, MAX_EXCLUDED_IDS)
  if (excluded.length > 0) and.push({ id: { notIn: excluded } })

  const published: Prisma.ActivityWhereInput = input.includeUnpublished
    ? {}
    : { isActive: true, destination: { isActive: true } }

  return { ...published, ...(and.length > 0 ? { AND: and } : {}) }
}

/**
 * Find sellable activities matching a brief.
 *
 * Postgres filters, then `rankActivities` orders by interest overlap. Callers get
 * back only what they can act on — no cost price, no supplier, and no draft rows
 * unless staff asked for them.
 */
export async function searchActivities(
  input: SearchActivitiesInput
): Promise<SearchActivitiesResult> {
  const limit = clampLimit(input.limit)
  const interests = (input.interests ?? [])
    .slice(0, MAX_INTERESTS)
    .filter((interest) => interest.trim() !== '')

  const rows = await db.activity.findMany({
    where: buildActivityWhere(input),
    select: ACTIVITY_SELECT,
    // Curated order, so the pool that gets ranked is the pool the content team
    // would have led with anyway when no interests were supplied.
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: CANDIDATE_POOL_SIZE,
  })

  const candidates = rows.map(toSummary)
  const ranked = rankActivities(candidates, interests)

  return {
    activities: ranked.slice(0, limit),
    matched: candidates.length,
    truncated: candidates.length === CANDIDATE_POOL_SIZE,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Single activity
// ─────────────────────────────────────────────────────────────────────────────

export interface GetActivityOptions {
  includeUnpublished?: boolean
}

/**
 * One activity with everything needed to render it or to schedule it.
 *
 * Returns null rather than throwing. "Unknown id" and "unpublished" are the same
 * answer to a public caller, and the route turns both into one 404, so an id
 * cannot be probed for existence.
 */
export async function getActivity(
  id: string,
  options: GetActivityOptions = {}
): Promise<ActivityDetail | null> {
  const row = await db.activity.findUnique({ where: { id }, select: ACTIVITY_DETAIL_SELECT })

  if (row === null) return null
  if (!options.includeUnpublished && !row.isActive) return null

  return toDetail(row)
}

export async function getActivityBySlug(
  slug: string,
  options: GetActivityOptions = {}
): Promise<ActivityDetail | null> {
  const row = await db.activity.findUnique({ where: { slug }, select: ACTIVITY_DETAIL_SELECT })

  if (row === null) return null
  if (!options.includeUnpublished && !row.isActive) return null

  return toDetail(row)
}

/**
 * Resolve ids to rows, retired ones included.
 *
 * Used on two paths that must not behave alike: validating a *new* ACTIVITY
 * block, which checks `isActive` itself and refuses a retired row, and rendering
 * an *existing* plan, which has to show the block that is already there — the
 * alternative is a traveller's saved itinerary silently losing a day because ops
 * archived a museum.
 */
export async function getActivitiesByIds(
  ids: readonly string[]
): Promise<Map<string, ActivityDetail>> {
  if (ids.length === 0) return new Map()

  const rows = await db.activity.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: ACTIVITY_DETAIL_SELECT,
  })

  return new Map(rows.map((row) => [row.id, toDetail(row)]))
}

/** The whole interest vocabulary, for admin pickers and for search hints. */
export async function listTags(): Promise<TagSummary[]> {
  return db.tag.findMany({ select: { slug: true, label: true }, orderBy: { label: 'asc' } })
}

// ─────────────────────────────────────────────────────────────────────────────
// Travel time
//
// WHAT THIS IS: the straight-line distance between two catalog coordinates,
// inflated by a per-mode detour factor to approximate a route, divided by a
// per-mode door-to-door average speed, plus a per-mode fixed overhead.
//
// WHAT THIS IS NOT: a routing engine. There is no road graph, no traffic feed, no
// ferry timetable, no elevation. Two activities either side of a river whose only
// bridge is twenty kilometres upstream will be badly underestimated, and nothing
// in this module can know that.
//
// The assumptions, written down so a reviewer can argue with the numbers instead
// of guessing at them:
//
//   averageSpeedKmh  Door to door, INCLUDING junctions, lights and congestion —
//                    not a vehicle's cruising speed. Calibrated for South and
//                    Southeast Asian traffic, where 26 km/h by car is optimistic
//                    in Dhaka at five o'clock and pessimistic on the Marine Drive
//                    at dawn.
//   detourFactor     Real routes are longer than straight lines. ~1.3 is the usual
//                    figure for a dense street grid; water and air routes run
//                    closer to direct, so they carry less.
//   overheadMinutes  Fixed cost that does not scale with distance: parking and the
//                    walk from it, hailing and waiting, buying a ticket, queueing
//                    to board, clearing an airport. This is what makes a
//                    two-kilometre ferry hop cost more than a two-kilometre walk,
//                    which is the whole reason it is modelled separately.
//
// Results are rounded UP to a five-minute step. "23 minutes" claims a precision we
// do not have; "25" reads as the estimate it is. Rounding up rather than to
// nearest also keeps a day from silently tightening block by block.
// ─────────────────────────────────────────────────────────────────────────────

export interface TransitProfile {
  averageSpeedKmh: number
  overheadMinutes: number
  detourFactor: number
}

export const TRANSIT_PROFILES: Record<TransitMode, TransitProfile> = {
  WALK: { averageSpeedKmh: 4.5, overheadMinutes: 0, detourFactor: 1.25 },
  BICYCLE: { averageSpeedKmh: 13, overheadMinutes: 5, detourFactor: 1.25 },
  CAR: { averageSpeedKmh: 26, overheadMinutes: 10, detourFactor: 1.35 },
  TAXI: { averageSpeedKmh: 26, overheadMinutes: 8, detourFactor: 1.35 },
  RIDESHARE: { averageSpeedKmh: 26, overheadMinutes: 8, detourFactor: 1.35 },
  BUS: { averageSpeedKmh: 17, overheadMinutes: 15, detourFactor: 1.4 },
  TRAIN: { averageSpeedKmh: 45, overheadMinutes: 25, detourFactor: 1.2 },
  FERRY: { averageSpeedKmh: 22, overheadMinutes: 30, detourFactor: 1.1 },
  BOAT: { averageSpeedKmh: 18, overheadMinutes: 20, detourFactor: 1.1 },
  FLIGHT: { averageSpeedKmh: 650, overheadMinutes: 180, detourFactor: 1.05 },
}

/** Mean Earth radius (IUGG). */
export const EARTH_RADIUS_KM = 6371.0088

export const TRAVEL_ROUNDING_MINUTES = 5

/**
 * Great-circle distance in kilometres, by the haversine formula.
 *
 * Haversine rather than the flat-earth shortcut because the catalog spans
 * Bangladesh to Bali and the equirectangular approximation drifts badly over a
 * thousand kilometres. Not Vincenty: the ellipsoidal correction is worth about
 * 0.3%, and we are about to divide by an average speed that is a guess to within
 * 30%.
 */
export function greatCircleKm(from: GeoPoint, to: GeoPoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180

  const deltaLat = toRadians(to.latitude - from.latitude)
  const deltaLon = toRadians(to.longitude - from.longitude)
  const fromLat = toRadians(from.latitude)
  const toLat = toRadians(to.latitude)

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2

  // asin is clamped: floating point can push `a` a hair above 1 for antipodal
  // points, and while Math.sqrt of that is fine, Math.asin of it is NaN.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Turn a straight-line distance into a travel time for one mode.
 *
 * Never returns zero. Two activities sharing a coordinate are still two different
 * places — a temple and the market outside its gate share a pin — and a day whose
 * blocks touch with no gap is a day nobody can actually walk.
 */
export function estimateMinutesForDistance(distanceKm: number, mode: TransitMode): number {
  const profile = TRANSIT_PROFILES[mode]
  const routeKm = Math.max(0, distanceKm) * profile.detourFactor
  const raw = (routeKm / profile.averageSpeedKmh) * 60 + profile.overheadMinutes

  const rounded = Math.ceil(raw / TRAVEL_ROUNDING_MINUTES) * TRAVEL_ROUNDING_MINUTES
  return Math.max(TRAVEL_ROUNDING_MINUTES, rounded)
}

export type TravelEstimateBasis = 'COORDINATES' | 'COORDINATES_MISSING'

/**
 * `isEstimate` is typed `true`, not `boolean`, on purpose: no code path in this
 * module produces a measured duration, so no consumer can branch on the flag and
 * quietly present one of these as though it had been routed.
 */
export interface TravelEstimate {
  /** Null when either endpoint has no coordinates. */
  minutes: number | null
  isEstimate: true
  basis: TravelEstimateBasis
  distanceKm: number | null
  mode: TransitMode
  from: { id: string; name: string }
  to: { id: string; name: string }
  /** Plain-language caveat, safe to show a traveller and to hand to the model. */
  note: string
}

const MISSING_COORDINATES_NOTE =
  'No coordinates are recorded for one or both of these activities, so no distance could be ' +
  'computed. Leave a generous transfer block and say the timing still needs confirming.'

function estimateNote(mode: TransitMode, distanceKm: number): string {
  const profile = TRANSIT_PROFILES[mode]
  return (
    `Estimated from a ${distanceKm.toFixed(1)} km straight-line distance, using an assumed ` +
    `${profile.averageSpeedKmh} km/h door-to-door average, a ${profile.detourFactor}x detour ` +
    `allowance and ${profile.overheadMinutes} minutes of fixed overhead. This is not a measured ` +
    'or routed duration: traffic, timetables and road closures are not modelled.'
  )
}

/**
 * Estimate the transfer between two catalog activities.
 *
 * Returns null only when an id does not resolve. A pair that resolves but has no
 * coordinates comes back with `minutes: null` and a note, because "we do not
 * know" is a useful answer and an invented number is not.
 */
export async function estimateTravelMinutes(
  fromActivityId: string,
  toActivityId: string,
  mode: TransitMode
): Promise<TravelEstimate | null> {
  const rows = await db.activity.findMany({
    where: { id: { in: [...new Set([fromActivityId, toActivityId])] } },
    select: { id: true, name: true, latitude: true, longitude: true },
  })

  const from = rows.find((row) => row.id === fromActivityId)
  const to = rows.find((row) => row.id === toActivityId)

  if (from === undefined || to === undefined) return null

  const endpoints = { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name } }

  const fromPoint = toPoint(from.latitude, from.longitude)
  const toPointResolved = toPoint(to.latitude, to.longitude)

  if (fromPoint === null || toPointResolved === null) {
    return {
      minutes: null,
      isEstimate: true,
      basis: 'COORDINATES_MISSING',
      distanceKm: null,
      mode,
      ...endpoints,
      note: MISSING_COORDINATES_NOTE,
    }
  }

  const distanceKm = greatCircleKm(fromPoint, toPointResolved)

  return {
    minutes: estimateMinutesForDistance(distanceKm, mode),
    isEstimate: true,
    basis: 'COORDINATES',
    distanceKm: Math.round(distanceKm * 10) / 10,
    mode,
    ...endpoints,
    note: estimateNote(mode, distanceKm),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening hours
//
// schema.prisma states the convention and this is its only implementation, so the
// two have to agree exactly:
//
//   • NO rows at all  → always available. A public beach, a viewpoint, a stretch
//     of coast road. Reading that as "closed" would delete half the catalog from
//     every plan.
//   • ANY row present → a weekday with no row is CLOSED that day.
//   • `closesMinute` may exceed 1440 for a venue running past midnight; 1560 is
//     02:00 the following morning.
//
// The last rule has a consequence that is easy to miss: a block at 01:00 on
// Tuesday is served by MONDAY's window, not Tuesday's. A night market that shuts
// at 02:00 has one row on Monday reading 1080–1560 and nothing on Tuesday. So the
// previous day's overrunning windows are folded into the day being asked about
// before anything is compared.
// ─────────────────────────────────────────────────────────────────────────────

export type AvailabilityReason = 'ALWAYS_OPEN' | 'WITHIN_HOURS' | 'CLOSED_ON_DAY' | 'OUTSIDE_HOURS'

export interface AvailabilityWindow {
  opensMinute: number
  closesMinute: number
}

export interface AvailabilityResult {
  isOpen: boolean
  reason: AvailabilityReason
  /**
   * Merged windows applying to the requested weekday, in minutes from that day's
   * local midnight. Empty when the activity keeps no hours at all.
   */
  windowsOnDay: AvailabilityWindow[]
}

/**
 * Merge overlapping and touching windows.
 *
 * Touching windows merge: 09:00–12:00 followed by 12:00–17:00 is a venue with two
 * rows for some administrative reason, not a venue that shuts at noon for zero
 * minutes. A real midday break leaves a gap, and a gap survives this.
 */
function mergeWindows(windows: readonly AvailabilityWindow[]): AvailabilityWindow[] {
  const sorted = [...windows].sort((a, b) => a.opensMinute - b.opensMinute)
  const merged: AvailabilityWindow[] = []

  for (const window of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && window.opensMinute <= last.closesMinute) {
      last.closesMinute = Math.max(last.closesMinute, window.closesMinute)
      continue
    }
    merged.push({ opensMinute: window.opensMinute, closesMinute: window.closesMinute })
  }

  return merged
}

/** Windows that apply to `dayOfWeek`, including the previous day's overrun. */
export function windowsForDay(
  windows: readonly OpeningWindow[],
  dayOfWeek: number
): AvailabilityWindow[] {
  const previousDay = (dayOfWeek + 6) % 7

  const sameDay = windows
    .filter((window) => window.dayOfWeek === dayOfWeek)
    .map((window) => ({ opensMinute: window.opensMinute, closesMinute: window.closesMinute }))

  // Yesterday's 22:00–02:00 is today's 00:00–02:00. Clamped at zero rather than
  // carried negative, so each interval describes this day and only this day.
  const overrun = windows
    .filter((window) => window.dayOfWeek === previousDay && window.closesMinute > MINUTES_IN_DAY)
    .map((window) => ({
      opensMinute: Math.max(0, window.opensMinute - MINUTES_IN_DAY),
      closesMinute: window.closesMinute - MINUTES_IN_DAY,
    }))

  return mergeWindows([...sameDay, ...overrun])
}

/**
 * Is `startMinute`–`endMinute` entirely inside opening hours on this weekday?
 *
 * Containment, not intersection. A tour that starts twenty minutes before the
 * gate opens is not "partly open" — it is a traveller standing at a locked gate
 * holding a plan that told them otherwise.
 *
 * Pure, and separated from the database call for exactly that reason: this is the
 * rule worth testing, and it needs no Postgres to be tested.
 */
export function evaluateOpeningWindows(
  windows: readonly OpeningWindow[],
  dayOfWeek: number,
  startMinute: number,
  endMinute: number
): AvailabilityResult {
  if (windows.length === 0) {
    return { isOpen: true, reason: 'ALWAYS_OPEN', windowsOnDay: [] }
  }

  const windowsOnDay = windowsForDay(windows, dayOfWeek)

  if (windowsOnDay.length === 0) {
    return { isOpen: false, reason: 'CLOSED_ON_DAY', windowsOnDay }
  }

  const covered = windowsOnDay.some(
    (window) => window.opensMinute <= startMinute && endMinute <= window.closesMinute
  )

  return { isOpen: covered, reason: covered ? 'WITHIN_HOURS' : 'OUTSIDE_HOURS', windowsOnDay }
}

export class InvalidTimeWindowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTimeWindowError'
  }
}

/** Refuse a nonsensical window before it reaches the comparison. */
export function assertValidTimeWindow(
  dayOfWeek: number,
  startMinute: number,
  endMinute: number
): void {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    throw new InvalidTimeWindowError('dayOfWeek must be an integer from 0 (Sunday) to 6 (Saturday).')
  }
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= MINUTES_IN_DAY) {
    throw new InvalidTimeWindowError('startMinute must be from 0 to 1439, counted from midnight.')
  }
  if (!Number.isInteger(endMinute) || endMinute <= startMinute) {
    throw new InvalidTimeWindowError('endMinute must be an integer greater than startMinute.')
  }
  if (endMinute > MAX_BLOCK_END_MINUTE) {
    throw new InvalidTimeWindowError(
      `endMinute must be at most ${MAX_BLOCK_END_MINUTE}: a block may run to the next midnight, no further.`
    )
  }
}

export interface ActivityAvailability extends AvailabilityResult {
  activityId: string
  name: string
  dayOfWeek: number
  startMinute: number
  endMinute: number
  /** What the catalog quotes, so a caller can spot a slot that is simply too short. */
  durationMinutes: number
}

/**
 * Can this activity be scheduled in this slot on this weekday?
 *
 * Returns null for an unknown or unpublished activity, so this cannot be used to
 * discover that an id exists.
 */
export async function isOpenAt(
  activityId: string,
  dayOfWeek: number,
  startMinute: number,
  endMinute: number
): Promise<ActivityAvailability | null> {
  assertValidTimeWindow(dayOfWeek, startMinute, endMinute)

  const activity = await db.activity.findUnique({
    where: { id: activityId },
    select: {
      id: true,
      name: true,
      isActive: true,
      durationMinutes: true,
      openingHours: {
        select: { dayOfWeek: true, opensMinute: true, closesMinute: true },
        orderBy: [{ dayOfWeek: 'asc' }, { opensMinute: 'asc' }],
      },
    },
  })

  if (activity === null || !activity.isActive) return null

  const result = evaluateOpeningWindows(activity.openingHours, dayOfWeek, startMinute, endMinute)

  return {
    ...result,
    activityId: activity.id,
    name: activity.name,
    dayOfWeek,
    startMinute,
    endMinute,
    durationMinutes: activity.durationMinutes,
  }
}
