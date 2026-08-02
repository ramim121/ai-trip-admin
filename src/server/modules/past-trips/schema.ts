import { z } from 'zod'
import {
  PackageScope,
  ReviewDimension,
  TripHighlightKind,
  TripLeaderRole,
} from '@/generated/prisma/enums'
import type { DimensionAverage, PastTripCard, PastTripDetail, PastTripLeaderRow } from './service'

/**
 * The wire contract for the past-trips endpoints.
 *
 * Same conventions as the other modules: named schemas with `.meta({ id })` so
 * the generator emits components, and projections written out field by field so
 * nothing leaks by being spread.
 *
 * What is deliberately NOT on the wire is as interesting as what is. There is
 * no participant list — who came on a trip is not a public fact, and a page
 * that named fourteen people would publish a social graph nobody agreed to.
 * `memberCount` is the number; the names stay in the console.
 *
 * Nor is there any unapproved content. The service filters it in SQL, and this
 * layer has no field that could carry it even if that filter were removed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

export const PublicTripLeaderCredit = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    role: z.enum(TripLeaderRole).describe('The role they held on THIS trip.'),
    headline: z.string(),
    bio: z.string(),
    photoUrl: z.string().nullable(),
    yearsExperience: z.int().nullable(),
    tripsLed: z.int().nonnegative(),
    languages: z.array(z.string()),
  })
  .meta({ id: 'PublicTripLeaderCredit' })
export type PublicTripLeaderCredit = z.infer<typeof PublicTripLeaderCredit>

export const PublicTripHighlight = z
  .object({
    id: z.uuid(),
    kind: z
      .enum(TripHighlightKind)
      .describe(
        'MOMENT, MILESTONE — or INCIDENT, which is the thing that went wrong. Incidents are ' +
          'published on purpose: a record containing only the good parts is a brochure.'
      ),
    title: z.string(),
    body: z.string(),
    dayNumber: z
      .int()
      .positive()
      .nullable()
      .describe('Which day it happened on. Null for something that ran through the whole trip.'),
  })
  .meta({ id: 'PublicTripHighlight' })
export type PublicTripHighlight = z.infer<typeof PublicTripHighlight>

export const PublicTripPhoto = z
  .object({
    id: z.uuid(),
    url: z.string(),
    alt: z.string().describe('Never empty: a database CHECK refuses to approve a row without it.'),
    caption: z.string().nullable(),
  })
  .meta({ id: 'PublicTripPhoto' })
export type PublicTripPhoto = z.infer<typeof PublicTripPhoto>

export const PublicTripRating = z
  .object({
    dimension: z.enum(ReviewDimension),
    score: z.int().min(1).max(5),
  })
  .meta({ id: 'PublicTripRating' })
export type PublicTripRating = z.infer<typeof PublicTripRating>

export const PublicTripReview = z
  .object({
    id: z.uuid(),
    author: z
      .string()
      .describe('Their chosen display name, or the account’s. Never an email address.'),
    headline: z.string(),
    body: z.string(),
    createdAt: z.iso.datetime(),
    ratings: z
      .array(PublicTripRating)
      .describe('This reviewer’s own scores, so a reader can see who thought what.'),
  })
  .meta({ id: 'PublicTripReview' })
export type PublicTripReview = z.infer<typeof PublicTripReview>

export const PublicDimensionAverage = z
  .object({
    dimension: z.enum(ReviewDimension),
    average: z
      .number()
      .min(1)
      .max(5)
      .nullable()
      .describe('One decimal. Null when nobody has rated this axis — never 0.'),
    responses: z
      .int()
      .nonnegative()
      .describe('How many reviews scored it. A 5.0 from one person is not a 5.0.'),
  })
  .meta({ id: 'PublicDimensionAverage' })
export type PublicDimensionAverage = z.infer<typeof PublicDimensionAverage>

export const PublicPastTripSummary = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    destinationLabel: z.string(),
    country: z.string(),
    scope: z.enum(PackageScope),
    startDate: z.iso.date().describe('Calendar date, YYYY-MM-DD. Not a timestamp.'),
    endDate: z.iso.date(),
    memberCount: z.int().positive().describe('How many travelled. The names are not published.'),
    heroImageUrl: z.string().nullable(),
    packageSlug: z
      .string()
      .nullable()
      .describe('Set when this was a running of something still on sale.'),
    packageTitle: z.string().nullable(),
    reviewCount: z.int().nonnegative().describe('Approved reviews only.'),
    overallAverage: z
      .number()
      .min(1)
      .max(5)
      .nullable()
      .describe(
        'A mean of the per-axis means, for the card only — so an axis nobody rated cannot pull ' +
          'it. Null until somebody reviews. The detail response deliberately does not lead with ' +
          'this: it carries `ratingSummary`, which is the honest form.'
      ),
    leaders: z.array(PublicTripLeaderCredit),
  })
  .meta({ id: 'PublicPastTripSummary' })
export type PublicPastTripSummary = z.infer<typeof PublicPastTripSummary>

export const PublicPastTrip = PublicPastTripSummary.extend({
  story: z.string(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  highlights: z.array(PublicTripHighlight),
  gallery: z
    .array(PublicTripPhoto)
    .describe('Approved photographs only. Pending and rejected rows are absent, not flagged.'),
  reviews: z.array(PublicTripReview).describe('Approved reviews only, newest first.'),
  ratingSummary: z
    .array(PublicDimensionAverage)
    .describe(
      'One entry per axis anybody has rated. There is no overall score here on purpose — a trip ' +
        'with superb guiding and poor transport averages to something unremarkable, and that ' +
        'single figure hides the two facts a reader would decide on.'
    ),
}).meta({ id: 'PublicPastTrip' })
export type PublicPastTrip = z.infer<typeof PublicPastTrip>

export const PastTripListResponse = z
  .object({ trips: z.array(PublicPastTripSummary) })
  .meta({ id: 'PastTripListResponse' })
export type PastTripListResponse = z.infer<typeof PastTripListResponse>

export const PastTripDetailResponse = z
  .object({ trip: PublicPastTrip })
  .meta({ id: 'PastTripDetailResponse' })
export type PastTripDetailResponse = z.infer<typeof PastTripDetailResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/** A `@db.Date` as the calendar date it is. Postgres returns it at UTC midnight. */
function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function toPublicTripLeaderCredit(row: PastTripLeaderRow): PublicTripLeaderCredit {
  return {
    id: row.leader.id,
    slug: row.leader.slug,
    name: row.leader.name,
    role: row.role,
    headline: row.leader.headline,
    bio: row.leader.bio,
    photoUrl: row.leader.photoUrl,
    yearsExperience: row.leader.yearsExperience,
    tripsLed: row.leader.tripsLed,
    languages: row.leader.languages,
  }
}

export function toPublicDimensionAverage(row: DimensionAverage): PublicDimensionAverage {
  return { dimension: row.dimension, average: row.average, responses: row.responses }
}

export function toPublicPastTripSummary(row: PastTripCard): PublicPastTripSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    destinationLabel: row.destinationLabel,
    country: row.country,
    scope: row.scope,
    startDate: toIsoDate(row.startDate),
    endDate: toIsoDate(row.endDate),
    memberCount: row.memberCount,
    heroImageUrl: row.heroImageUrl,
    packageSlug: row.package?.slug ?? null,
    packageTitle: row.package?.title ?? null,
    reviewCount: row.reviewCount,
    overallAverage: row.overallAverage,
    leaders: row.leaders.map(toPublicTripLeaderCredit),
  }
}

export function toPublicPastTrip(row: PastTripDetail): PublicPastTrip {
  return {
    ...toPublicPastTripSummary(row),
    story: row.story,
    metaTitle: row.metaTitle,
    metaDescription: row.metaDescription,
    highlights: row.highlights.map((highlight) => ({
      id: highlight.id,
      kind: highlight.kind,
      title: highlight.title,
      body: highlight.body,
      dayNumber: highlight.dayNumber,
    })),
    gallery: row.media.map((photo) => ({
      id: photo.id,
      url: photo.url,
      alt: photo.alt,
      caption: photo.caption,
    })),
    reviews: row.reviews.map((review) => ({
      id: review.id,
      author: review.author,
      headline: review.headline,
      body: review.body,
      createdAt: review.createdAt.toISOString(),
      ratings: review.ratings.map((rating) => ({
        dimension: rating.dimension,
        score: rating.score,
      })),
    })),
    ratingSummary: row.ratingSummary.map(toPublicDimensionAverage),
  }
}
