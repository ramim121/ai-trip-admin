import { z } from 'zod'
import { ActivityCategory, ActivityIntensity, TimeOfDay } from '@/generated/prisma/enums'
import {
  MAX_SEARCH_LIMIT,
  MINUTES_IN_DAY,
  type ActivityDetail,
  type ActivitySummary,
  type DestinationSummary,
  type RankedActivity,
} from './service'

/**
 * The wire contract for the public catalog endpoints.
 *
 * Every schema is named and carries `.meta({ id })` so the OpenAPI generator
 * emits it as a component rather than inlining an anonymous shape at each call
 * site — the same convention as `modules/auth/schema.ts`.
 *
 * Request and response shapes live together on purpose. The response schemas are
 * the definition of what leaves the process, so anything absent here — a draft
 * row's `isActive`, a curator's `sortOrder`, the internal `destinationId` on an
 * activity that already carries its destination — has to be a deliberate
 * addition rather than something that leaked in by spreading a Prisma row.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Query parameters
//
// Query strings arrive as strings, always. Rather than `z.coerce`, each numeric
// parameter is declared as the string it actually is and piped into a bounded
// integer. Two things follow, both wanted: the generated OpenAPI parameter says
// `type: string` with the pattern a caller has to satisfy, which is the truth
// about a query string; and `?limit=abc` fails as a validation error naming
// `limit` rather than arriving as NaN and silently becoming a default.
// ─────────────────────────────────────────────────────────────────────────────

/** A non-negative integer written out in a query string. */
function integerParam(min: number, max: number, description: string) {
  return z
    .string()
    .regex(/^\d{1,9}$/, 'Must be a whole number.')
    .transform(Number)
    .pipe(z.int().min(min).max(max))
    .describe(description)
}

/**
 * Repeatable or comma-separated, because both are in the wild and neither is
 * worth a 400. `?interests=beach&interests=temples` and `?interests=beach,temples`
 * mean the same thing.
 */
const InterestsParam = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 10)
  )
  .describe(
    'Interest tags to rank by, e.g. `beach` or `street food`. Repeat the key or separate with ' +
      'commas. Matched loosely against tag slugs and labels, so a plural or a label spelling ' +
      'still finds the tag. At most 10 are considered.'
  )

export const DestinationListQuery = z.object({
  q: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe('Filter by name, slug, country or region, case-insensitively.'),
})
export type DestinationListQuery = z.infer<typeof DestinationListQuery>

export const ActivitySearchQuery = z.object({
  interests: InterestsParam.optional(),
  category: z.enum(ActivityCategory).optional().describe('Restrict to a single category.'),
  timeOfDay: z
    .enum(TimeOfDay)
    .optional()
    .describe(
      'Slot being filled. Activities marked `ANY` suit every slot and are always included, so ' +
        'this narrows rather than excludes.'
    ),
  maxDurationMinutes: integerParam(
    15,
    MINUTES_IN_DAY,
    'Longest activity to return, in minutes, excluding travel to and from.'
  ).optional(),
  maxPricePerPersonBdt: integerParam(
    0,
    1_000_000,
    'Budget ceiling in whole BDT per person. Activities with no listed price — free sights, and ' +
      'anything quoted case by case — are always included; read `priceNote`.'
  ).optional(),
  partySize: integerParam(
    1,
    100,
    'Excludes activities that cannot take a group this size. A null bound on an activity means ' +
      'no bound, so it satisfies any party.'
  ).optional(),
  limit: integerParam(
    1,
    MAX_SEARCH_LIMIT,
    'Maximum activities to return. Defaults to 10.'
  ).optional(),
})
export type ActivitySearchQuery = z.infer<typeof ActivitySearchQuery>

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

export const PublicDestination = z
  .object({
    id: z.uuid(),
    slug: z.string().describe('Stable, URL-safe, and the key the activities endpoint takes.'),
    name: z.string(),
    country: z.string(),
    region: z.string().nullable(),
    summary: z.string(),
    timezone: z
      .string()
      .describe(
        'IANA zone, e.g. `Asia/Dhaka`. Every minutes-from-midnight value in an itinerary for ' +
          'this destination is local time in this zone.'
      ),
    heroImageUrl: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    activityCount: z
      .int()
      .nonnegative()
      .describe('Published activities only. Unpublished drafts are never counted or listed.'),
  })
  .meta({ id: 'PublicDestination' })
export type PublicDestination = z.infer<typeof PublicDestination>

export const PublicTag = z
  .object({
    slug: z.string(),
    label: z.string().describe('What a traveller sees. The slug is what code matches on.'),
  })
  .meta({ id: 'PublicTag' })
export type PublicTag = z.infer<typeof PublicTag>

export const PublicActivityImage = z
  .object({
    id: z.uuid(),
    url: z.string(),
    alt: z.string().describe('Never empty: the column is required precisely so it cannot be.'),
    sortOrder: z.int(),
  })
  .meta({ id: 'PublicActivityImage' })
export type PublicActivityImage = z.infer<typeof PublicActivityImage>

export const PublicOpeningHours = z
  .object({
    dayOfWeek: z.int().min(0).max(6).describe('0 = Sunday through 6 = Saturday.'),
    opensMinute: z.int().describe('Minutes from local midnight. 540 is 09:00.'),
    closesMinute: z
      .int()
      .describe('May exceed 1440 for a venue running past midnight: 1560 is 02:00 the next day.'),
  })
  .meta({ id: 'PublicOpeningHours' })
export type PublicOpeningHours = z.infer<typeof PublicOpeningHours>

export const PublicActivitySummary = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    summary: z.string(),
    category: z.enum(ActivityCategory),
    durationMinutes: z
      .int()
      .positive()
      .describe('Excludes travel to and from. The planner adds transit blocks for that.'),
    pricePerPersonBdt: z
      .int()
      .nullable()
      .describe(
        'Whole taka per person. Null means free, or price on request — `priceNote` carries the ' +
          'nuance. There is no minor unit and no decimal: this is an integer.'
      ),
    priceNote: z.string().nullable(),
    bestTimeOfDay: z.enum(TimeOfDay),
    intensity: z.enum(ActivityIntensity),
    bookingRequired: z.boolean(),
    minPartySize: z.int().nullable().describe('Null means no lower bound.'),
    maxPartySize: z.int().nullable().describe('Null means no upper bound.'),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    tags: z.array(PublicTag),
    primaryImage: PublicActivityImage.nullable(),
  })
  .meta({ id: 'PublicActivitySummary' })
export type PublicActivitySummary = z.infer<typeof PublicActivitySummary>

/** A search hit, carrying why it ranked where it did. */
export const RankedActivitySummary = PublicActivitySummary.extend({
  matchedInterests: z
    .array(z.string())
    .describe(
      'Which of the requested `interests` this activity answered, echoed back in the wording ' +
        'they were sent in. Empty when none were requested.'
    ),
}).meta({ id: 'RankedActivitySummary' })
export type RankedActivitySummary = z.infer<typeof RankedActivitySummary>

/**
 * Where an activity is, as much of it as an activity page needs.
 *
 * Deliberately not the full `PublicDestination`. Nesting that here would mean
 * every activity response carried the destination's hero image, its prose
 * summary and a count of its other activities — three fields nobody rendering an
 * activity is going to use, on every row of every response.
 */
export const PublicActivityDestination = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    country: z.string(),
    timezone: z.string().describe('IANA zone. Opening hours are local time in this zone.'),
  })
  .meta({ id: 'PublicActivityDestination' })
export type PublicActivityDestination = z.infer<typeof PublicActivityDestination>

export const PublicActivity = PublicActivitySummary.extend({
  destination: PublicActivityDestination,
  description: z.string(),
  sourceUrl: z.string().nullable().describe('Where a curator last verified price and hours.'),
  images: z.array(PublicActivityImage),
  openingHours: z
    .array(PublicOpeningHours)
    .describe(
      'An EMPTY array means always available — a public beach, a viewpoint. Once any window ' +
        'exists, a weekday with no window is closed that day. Do not read empty as closed.'
    ),
}).meta({ id: 'PublicActivity' })
export type PublicActivity = z.infer<typeof PublicActivity>

export const DestinationListResponse = z
  .object({ destinations: z.array(PublicDestination) })
  .meta({ id: 'DestinationListResponse' })
export type DestinationListResponse = z.infer<typeof DestinationListResponse>

export const DestinationActivitiesResponse = z
  .object({
    destination: PublicDestination,
    activities: z.array(RankedActivitySummary),
    total: z
      .int()
      .nonnegative()
      .describe('Activities that passed the filters, before `limit` was applied.'),
    truncated: z
      .boolean()
      .describe(
        'True when the candidate pool filled up and there may be more behind it. Narrow the ' +
          'filters rather than paging: this endpoint has no cursor.'
      ),
  })
  .meta({ id: 'DestinationActivitiesResponse' })
export type DestinationActivitiesResponse = z.infer<typeof DestinationActivitiesResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Projections
//
// Written out field by field, like the auth module's. A mapper that spread its
// input would publish every column the service adds later, and the service rows
// carry `isActive` and `sortOrder` — a draft flag and a curator's ordering,
// neither of which is any of a traveller's business.
// ─────────────────────────────────────────────────────────────────────────────

export function toPublicDestination(row: DestinationSummary): PublicDestination {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    country: row.country,
    region: row.region,
    summary: row.summary,
    timezone: row.timezone,
    heroImageUrl: row.heroImageUrl,
    latitude: row.location?.latitude ?? null,
    longitude: row.location?.longitude ?? null,
    activityCount: row.activityCount,
  }
}

export function toPublicActivitySummary(row: ActivitySummary): PublicActivitySummary {
  return {
    id: row.id,
    slug: row.slug,
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
    latitude: row.location?.latitude ?? null,
    longitude: row.location?.longitude ?? null,
    tags: row.tags,
    primaryImage: row.primaryImage,
  }
}

export function toRankedActivitySummary(row: RankedActivity): RankedActivitySummary {
  return { ...toPublicActivitySummary(row), matchedInterests: row.matchedInterests }
}

export function toPublicActivity(row: ActivityDetail): PublicActivity {
  return {
    ...toPublicActivitySummary(row),
    destination: {
      id: row.destination.id,
      slug: row.destination.slug,
      name: row.destination.name,
      country: row.destination.country,
      timezone: row.destination.timezone,
    },
    description: row.description,
    sourceUrl: row.sourceUrl,
    images: row.images,
    openingHours: row.openingHours.map((window) => ({
      dayOfWeek: window.dayOfWeek,
      opensMinute: window.opensMinute,
      closesMinute: window.closesMinute,
    })),
  }
}
