import { z } from 'zod'
import {
  DepartureStatus,
  ItineraryBlockKind,
  PackageKind,
  PackagePricingMode,
  PackageScope,
  TripLeaderRole,
} from '@/generated/prisma/enums'
import type {
  PackageCard,
  PackageDayRow,
  PackageDepartureRow,
  PackageDetail,
  PackageLeaderRow,
} from './service'

/**
 * The wire contract for the Discover endpoints.
 *
 * Same conventions as `modules/catalog/schema.ts`: every schema is named and
 * carries `.meta({ id })` so the generator emits a component rather than
 * inlining an anonymous shape, and every projection is written out field by
 * field. A mapper that spread its input would publish whatever the service adds
 * next — and the service rows carry `sortOrder`, which is a curator's
 * merchandising decision, and `status`, which on a public endpoint is always
 * the same value and so says nothing except that drafts exist.
 *
 * DATES
 *
 * A departure's dates are `@db.Date` and go out as `YYYY-MM-DD`, never as
 * timestamps. "17 October" is a calendar fact about a trip, and rendering it
 * through a timezone is how a departure shows up a day early for half the
 * people reading the page.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Query parameters
// ─────────────────────────────────────────────────────────────────────────────

export const PackageListQuery = z.object({
  scope: z
    .enum(PackageScope)
    .optional()
    .describe(
      'Restrict to one tab. Omit for both — the website asks for both at once and splits them ' +
        'client-side, so switching tabs costs no request.'
    ),
  q: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe('Filter by title, summary, destination label or country, case-insensitively.'),
})
export type PackageListQuery = z.infer<typeof PackageListQuery>

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

export const PublicDeparture = z
  .object({
    id: z.uuid(),
    startDate: z.iso.date().describe('Calendar date, YYYY-MM-DD. Not a timestamp.'),
    endDate: z.iso.date(),
    capacity: z.int().positive(),
    seatsTaken: z.int().nonnegative(),
    seatsLeft: z
      .int()
      .nonnegative()
      .describe('`capacity - seatsTaken`. Published rather than left to each client to subtract.'),
    priceBdt: z
      .int()
      .nullable()
      .describe(
        'Whole taka per person for THIS date, overriding the package price. Null means the ' +
          'package price applies — it does not mean free.'
      ),
    status: z.enum(DepartureStatus),
    notes: z.string().nullable(),
  })
  .meta({ id: 'PublicDeparture' })
export type PublicDeparture = z.infer<typeof PublicDeparture>

export const PublicTripLeader = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    role: z
      .enum(TripLeaderRole)
      .describe('Their role on THIS trip, which may differ from their usual one.'),
    isPrimary: z.boolean().describe('At most one per trip. The name on the card.'),
    headline: z.string(),
    bio: z.string(),
    photoUrl: z.string().nullable(),
    yearsExperience: z.int().nullable(),
    tripsLed: z.int().nonnegative(),
    languages: z.array(z.string()),
  })
  .meta({ id: 'PublicTripLeader' })
export type PublicTripLeader = z.infer<typeof PublicTripLeader>

export const PublicPackageItineraryItem = z
  .object({
    id: z.uuid(),
    kind: z
      .enum(ItineraryBlockKind)
      .describe('The planner’s vocabulary, reused so both kinds of day render the same way.'),
    title: z.string(),
    detail: z.string().nullable(),
    startMinute: z
      .int()
      .nullable()
      .describe(
        'Minutes from local midnight; 540 is 09:00. NULL is deliberate rather than missing — ' +
          '"afternoon at leisure" has no start time and must not be given a fake one.'
      ),
    durationMinutes: z.int().positive().nullable(),
  })
  .meta({ id: 'PublicPackageItineraryItem' })
export type PublicPackageItineraryItem = z.infer<typeof PublicPackageItineraryItem>

export const PublicPackageDay = z
  .object({
    id: z.uuid(),
    dayNumber: z.int().positive().describe('1-based. Day 1 is the first day, not an index.'),
    title: z.string(),
    summary: z.string().nullable(),
    accommodation: z.string().nullable().describe('Null on the last day, when there is none.'),
    meals: z.array(z.string()).describe('Meals included that day, e.g. ["Breakfast","Dinner"].'),
    items: z.array(PublicPackageItineraryItem),
  })
  .meta({ id: 'PublicPackageDay' })
export type PublicPackageDay = z.infer<typeof PublicPackageDay>

export const PublicPackageSummary = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    scope: z.enum(PackageScope).describe('Which tab this belongs under.'),
    kind: z.enum(PackageKind),
    pricingMode: z
      .enum(PackagePricingMode)
      .describe(
        'FIXED_PRICE quotes a number. INTEREST_ONLY has not been costed yet and collects a list ' +
          'of people who would come instead — the price fields are then null by database ' +
          'constraint rather than by convention.'
      ),
    destinationLabel: z.string(),
    country: z.string(),
    destinationSlug: z
      .string()
      .nullable()
      .describe('Set when the trip maps onto a catalog destination the planner also knows.'),
    durationDays: z.int().positive(),
    durationNights: z.int().nonnegative(),
    priceFromBdt: z
      .int()
      .nullable()
      .describe('Whole taka per person. Null for INTEREST_ONLY, and null is not zero.'),
    priceToBdt: z
      .int()
      .nullable()
      .describe('Set only when the price is genuinely a range. Null means `priceFromBdt` is it.'),
    groupSizeMin: z.int().nullable().describe('GROUP trips only; null on an INDIVIDUAL package.'),
    groupSizeMax: z.int().nullable(),
    heroImageUrl: z.string().nullable(),
    cardImageUrl: z.string().nullable(),
    highlights: z.array(z.string()),
    registeredCount: z
      .int()
      .nonnegative()
      .describe(
        'People on the interest list, withdrawals excluded. NOT seats sold — a seat is a ' +
          'commitment on a dated departure and lives on `seatsTaken`.'
      ),
    upcomingDepartureCount: z.int().nonnegative(),
    nextDeparture: PublicDeparture.nullable().describe('The soonest joinable date, or null.'),
    primaryLeader: PublicTripLeader.nullable(),
  })
  .meta({ id: 'PublicPackageSummary' })
export type PublicPackageSummary = z.infer<typeof PublicPackageSummary>

export const PublicPackage = PublicPackageSummary.extend({
  description: z.string(),
  inclusions: z.array(z.string()),
  exclusions: z.array(z.string()),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  days: z
    .array(PublicPackageDay)
    .describe('The published day-by-day. For a package this IS the product description.'),
  departures: z
    .array(PublicDeparture)
    .describe(
      'Every departure from today onwards, CANCELLED ones included — somebody who had that date ' +
        'in mind should see it was cancelled rather than find it missing.'
    ),
  leaders: z.array(PublicTripLeader),
}).meta({ id: 'PublicPackage' })
export type PublicPackage = z.infer<typeof PublicPackage>

export const PackageListResponse = z
  .object({ packages: z.array(PublicPackageSummary) })
  .meta({ id: 'PackageListResponse' })
export type PackageListResponse = z.infer<typeof PackageListResponse>

export const PackageDetailResponse = z
  .object({ package: PublicPackage })
  .meta({ id: 'PackageDetailResponse' })
export type PackageDetailResponse = z.infer<typeof PackageDetailResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Registering interest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The largest party one registration may claim.
 *
 * Not a booking limit — a bound on a public form. A field that accepts
 * 2,000,000,000 is a field somebody eventually types 2,000,000,000 into, and the
 * count it feeds is printed on a card.
 */
export const MAX_INTEREST_PARTY_SIZE = 40

export const RegisterInterestBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.email().max(254).describe('Lowercased before storage; one registration per address.'),
    phone: z.string().trim().max(40).optional(),
    partySize: z.int().min(1).max(MAX_INTEREST_PARTY_SIZE).default(1),
    message: z.string().trim().max(1_000).optional(),
    departureId: z
      .uuid()
      .optional()
      .describe(
        'Which date they want. Validated against THIS package — a departure id from another ' +
          'trip is a 404, not a silently mis-filed lead.'
      ),
  })
  .meta({ id: 'RegisterInterestBody' })
export type RegisterInterestBody = z.infer<typeof RegisterInterestBody>

export const RegisterInterestResponse = z
  .object({
    created: z
      .boolean()
      .describe(
        'False when this address was already on the list and the details were updated instead. ' +
          'Registering twice is a double-click, not two travellers.'
      ),
    registeredCount: z.int().nonnegative().describe('The list size afterwards.'),
  })
  .meta({ id: 'RegisterInterestResponse' })
export type RegisterInterestResponse = z.infer<typeof RegisterInterestResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/** A `@db.Date` as the calendar date it is. Postgres returns it at UTC midnight. */
function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function toPublicDeparture(row: PackageDepartureRow): PublicDeparture {
  return {
    id: row.id,
    startDate: toIsoDate(row.startDate),
    endDate: toIsoDate(row.endDate),
    capacity: row.capacity,
    seatsTaken: row.seatsTaken,
    // The CHECK constraint already guarantees this is non-negative; the floor is
    // here so a schema violation could never surface as a negative on a page.
    seatsLeft: Math.max(0, row.capacity - row.seatsTaken),
    priceBdt: row.priceBdt,
    status: row.status,
    notes: row.notes,
  }
}

export function toPublicTripLeader(row: PackageLeaderRow): PublicTripLeader {
  return {
    id: row.leader.id,
    slug: row.leader.slug,
    name: row.leader.name,
    // The package's role wins over the person's usual one: the same guide is a
    // LEADER on eight trips and a GUIDE on the ninth.
    role: row.role,
    isPrimary: row.isPrimary,
    headline: row.leader.headline,
    bio: row.leader.bio,
    photoUrl: row.leader.photoUrl,
    yearsExperience: row.leader.yearsExperience,
    tripsLed: row.leader.tripsLed,
    languages: row.leader.languages,
  }
}

export function toPublicPackageDay(row: PackageDayRow): PublicPackageDay {
  return {
    id: row.id,
    dayNumber: row.dayNumber,
    title: row.title,
    summary: row.summary,
    accommodation: row.accommodation,
    meals: row.meals,
    items: row.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      startMinute: item.startMinute,
      durationMinutes: item.durationMinutes,
    })),
  }
}

export function toPublicPackageSummary(row: PackageCard): PublicPackageSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    scope: row.scope,
    kind: row.kind,
    pricingMode: row.pricingMode,
    destinationLabel: row.destinationLabel,
    country: row.country,
    destinationSlug: row.destination?.slug ?? null,
    durationDays: row.durationDays,
    durationNights: row.durationNights,
    priceFromBdt: row.priceFromBdt,
    priceToBdt: row.priceToBdt,
    groupSizeMin: row.groupSizeMin,
    groupSizeMax: row.groupSizeMax,
    heroImageUrl: row.heroImageUrl,
    cardImageUrl: row.cardImageUrl,
    highlights: row.highlights,
    registeredCount: row.registeredCount,
    upcomingDepartureCount: row.upcomingDepartureCount,
    nextDeparture: row.nextDeparture === null ? null : toPublicDeparture(row.nextDeparture),
    primaryLeader: row.primaryLeader === null ? null : toPublicTripLeader(row.primaryLeader),
  }
}

export function toPublicPackage(row: PackageDetail): PublicPackage {
  return {
    ...toPublicPackageSummary(row),
    description: row.description,
    inclusions: row.inclusions,
    exclusions: row.exclusions,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    days: row.days.map(toPublicPackageDay),
    departures: row.departures.map(toPublicDeparture),
    leaders: row.leaders.map(toPublicTripLeader),
  }
}
