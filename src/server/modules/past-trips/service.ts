import type { Prisma } from '@/generated/prisma/client'
import { ModerationStatus, PastTripStatus, type ReviewDimension } from '@/generated/prisma/enums'
import { db } from '@/lib/db'

/**
 * Reading the record of trips we have already run.
 *
 * Everything here is a public read, and two WHERE clauses do the load-bearing
 * work rather than any filtering afterwards:
 *
 *   status = PUBLISHED           on the trip
 *   moderationStatus = APPROVED  on every photograph and every review
 *
 * Both are in the query for the same reason the package reads exclude drafts: a
 * caller handed unapproved rows would have to remember to drop them, and one
 * day one of them would not. The gallery is the case that matters — it is
 * writable by travellers, and "we filtered it in the component" is not a
 * moderation policy.
 *
 * THE RATINGS ARE AGGREGATED PER DIMENSION, NEVER FLATTENED
 *
 * `ratingSummary` returns one row per axis with its own average and its own
 * response count. A trip with superb guiding and poor transport averages to
 * something unremarkable, and that single number is worse than useless — it is
 * the one figure that hides the two facts a reader would decide on.
 */

const LEADER_SELECT = {
  role: true,
  leader: {
    select: {
      id: true,
      slug: true,
      name: true,
      headline: true,
      bio: true,
      photoUrl: true,
      yearsExperience: true,
      tripsLed: true,
      languages: true,
    },
  },
} as const

const CARD_SELECT = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  destinationLabel: true,
  country: true,
  scope: true,
  startDate: true,
  endDate: true,
  memberCount: true,
  heroImageUrl: true,
  package: { select: { slug: true, title: true } },
} as const

export type PastTripLeaderRow = Prisma.PastTripLeaderGetPayload<{ select: typeof LEADER_SELECT }>

/** One axis's standing, computed from approved reviews only. */
export interface DimensionAverage {
  dimension: ReviewDimension
  /** Mean of the scores given, 1–5. Null when nobody has rated this axis. */
  average: number | null
  /** How many reviews scored it. A 5.0 from one person is not a 5.0. */
  responses: number
}

export interface PastTripCard extends Prisma.PastTripGetPayload<{ select: typeof CARD_SELECT }> {
  /** Approved reviews only. */
  reviewCount: number
  /**
   * The single number the CARD shows, and the only place one is computed.
   *
   * A mean of the per-dimension means rather than of every score, so an axis
   * nobody rated cannot pull the figure and a heavily-rated axis cannot
   * dominate it. Null until somebody reviews. The detail page never shows this
   * — it shows the seven axes, which is the honest form.
   */
  overallAverage: number | null
  leaders: PastTripLeaderRow[]
}

/** How many trips one listing request may return. */
export const MAX_PAST_TRIP_LIST = 40

/** One decimal. Averages are computed on read and never stored. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The mean of each axis's mean.
 *
 * Not the mean of every score. The two differ whenever the axes have different
 * response counts, and the difference matters: a trip where everyone rated the
 * leader and only two people rated the food should not have its headline figure
 * decided by whichever question people happened to answer.
 */
function meanOfDimensionMeans(dimensions?: Map<ReviewDimension, number[]>): number | null {
  if (dimensions === undefined || dimensions.size === 0) return null

  const means = [...dimensions.values()].map(
    (scores) => scores.reduce((total, score) => total + score, 0) / scores.length
  )

  return round1(means.reduce((total, mean) => total + mean, 0) / means.length)
}

/**
 * Published trips, most recent first.
 *
 * Ordered by `startDate` descending rather than by `publishedAt`: a trip
 * written up six months late is still a trip from six months ago, and somebody
 * scanning this list is reading a timeline.
 */
export async function listPastTrips(limit = MAX_PAST_TRIP_LIST): Promise<PastTripCard[]> {
  const take = Math.min(MAX_PAST_TRIP_LIST, Math.max(1, limit))

  const trips = await db.pastTrip.findMany({
    where: { status: PastTripStatus.PUBLISHED },
    orderBy: [{ startDate: 'desc' }, { sortOrder: 'asc' }],
    take,
    select: {
      ...CARD_SELECT,
      leaders: { orderBy: { sortOrder: 'asc' }, select: LEADER_SELECT },
      _count: { select: { reviews: { where: { moderationStatus: ModerationStatus.APPROVED } } } },
    },
  })

  if (trips.length === 0) return []

  // One query for every trip's scores rather than one per card. The scores are
  // fetched rather than aggregated in SQL because the figure each card needs is
  // a mean of per-axis means, which `groupBy` cannot express in one pass — and
  // the row count here is reviews × 7, which is small by construction.
  const scores = await db.tripReviewRating.findMany({
    where: {
      review: {
        tripId: { in: trips.map((trip) => trip.id) },
        moderationStatus: ModerationStatus.APPROVED,
      },
    },
    select: { score: true, dimension: true, review: { select: { tripId: true } } },
  })

  const byTrip = new Map<string, Map<ReviewDimension, number[]>>()
  for (const row of scores) {
    const dimensions = byTrip.get(row.review.tripId) ?? new Map<ReviewDimension, number[]>()
    const existing = dimensions.get(row.dimension) ?? []
    existing.push(row.score)
    dimensions.set(row.dimension, existing)
    byTrip.set(row.review.tripId, dimensions)
  }

  return trips.map(({ _count, leaders, ...card }) => ({
    ...card,
    leaders,
    reviewCount: _count.reviews,
    overallAverage: meanOfDimensionMeans(byTrip.get(card.id)),
  }))
}

export interface PastTripDetail extends PastTripCard {
  story: string
  metaTitle: string | null
  metaDescription: string | null
  highlights: Prisma.TripHighlightGetPayload<{
    select: { id: true; kind: true; title: true; body: true; dayNumber: true }
  }>[]
  media: Prisma.TripMediaGetPayload<{
    select: { id: true; url: true; alt: true; caption: true }
  }>[]
  reviews: {
    id: string
    headline: string
    body: string
    /** What they asked to be called, falling back to the account's name. */
    author: string
    createdAt: Date
    ratings: { dimension: ReviewDimension; score: number }[]
  }[]
  /** One entry per axis anybody has rated. */
  ratingSummary: DimensionAverage[]
}

/**
 * One published trip, with everything approved that belongs to it.
 *
 * Returns null rather than throwing, so the caller decides between a 404 and a
 * quiet omission. A DRAFT slug is indistinguishable from one that does not
 * exist — the same rule the package detail follows, for the same reason.
 */
export async function getPastTrip(slug: string): Promise<PastTripDetail | null> {
  const trip = await db.pastTrip.findFirst({
    where: { slug, status: PastTripStatus.PUBLISHED },
    select: {
      ...CARD_SELECT,
      story: true,
      metaTitle: true,
      metaDescription: true,
      leaders: { orderBy: { sortOrder: 'asc' }, select: LEADER_SELECT },
      highlights: {
        orderBy: { sortOrder: 'asc' },
        select: { id: true, kind: true, title: true, body: true, dayNumber: true },
      },
      media: {
        where: { moderationStatus: ModerationStatus.APPROVED },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, url: true, alt: true, caption: true },
      },
      reviews: {
        where: { moderationStatus: ModerationStatus.APPROVED },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          headline: true,
          body: true,
          displayName: true,
          createdAt: true,
          user: { select: { name: true } },
          ratings: { select: { dimension: true, score: true } },
        },
      },
    },
  })

  if (trip === null) return null

  const { reviews, ...rest } = trip

  // Averaged from the reviews already loaded rather than by a second query.
  // They are the same rows the page renders, so the summary at the top cannot
  // disagree with the individual scores printed underneath it.
  const scoresByDimension = new Map<ReviewDimension, number[]>()
  for (const review of reviews) {
    for (const rating of review.ratings) {
      const existing = scoresByDimension.get(rating.dimension) ?? []
      existing.push(rating.score)
      scoresByDimension.set(rating.dimension, existing)
    }
  }

  const ratingSummary: DimensionAverage[] = [...scoresByDimension.entries()].map(
    ([dimension, scores]) => ({
      dimension,
      average: round1(scores.reduce((total, score) => total + score, 0) / scores.length),
      responses: scores.length,
    })
  )

  return {
    ...rest,
    reviewCount: reviews.length,
    overallAverage: meanOfDimensionMeans(scoresByDimension),
    ratingSummary,
    reviews: reviews.map((review) => ({
      id: review.id,
      headline: review.headline,
      body: review.body,
      // Their chosen name wins. Somebody who asked to be "Sadia N." asked for a
      // reason, and falling through to the account name would override it.
      author: review.displayName ?? review.user.name,
      createdAt: review.createdAt,
      ratings: review.ratings,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console reads
// ─────────────────────────────────────────────────────────────────────────────

/** Every trip, drafts included, with its moderation backlog. Console only. */
export async function listAllPastTrips(take = 100) {
  return db.pastTrip.findMany({
    orderBy: [{ startDate: 'desc' }],
    take,
    select: {
      id: true,
      slug: true,
      title: true,
      status: true,
      destinationLabel: true,
      country: true,
      scope: true,
      startDate: true,
      endDate: true,
      memberCount: true,
      publishedAt: true,
      _count: {
        select: {
          leaders: true,
          highlights: true,
          participants: true,
          media: { where: { moderationStatus: ModerationStatus.PENDING } },
          reviews: { where: { moderationStatus: ModerationStatus.PENDING } },
        },
      },
    },
  })
}

/**
 * Everything waiting on a human, oldest first.
 *
 * Both queues in one call because they are one job: somebody sits down to clear
 * the backlog, and splitting it across two screens is how the smaller queue
 * goes unlooked-at for a month. Oldest first, because the person who has been
 * waiting longest is the one to answer next.
 */
export async function listModerationQueue(take = 50) {
  const [media, reviews] = await Promise.all([
    db.tripMedia.findMany({
      where: { moderationStatus: ModerationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take,
      select: {
        id: true,
        url: true,
        alt: true,
        caption: true,
        createdAt: true,
        trip: { select: { slug: true, title: true } },
        uploadedByUser: { select: { email: true, name: true } },
      },
    }),
    db.tripReview.findMany({
      where: { moderationStatus: ModerationStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take,
      select: {
        id: true,
        headline: true,
        body: true,
        displayName: true,
        createdAt: true,
        trip: { select: { slug: true, title: true } },
        user: { select: { email: true, name: true } },
        ratings: { select: { dimension: true, score: true } },
      },
    }),
  ])

  return { media, reviews }
}
