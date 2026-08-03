import { PlaceCandidateStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { badRequest, conflict, notFound } from '@/server/http/errors'
import { searchPlaces, type PlaceResult } from '@/server/places/client'

/**
 * Importing venues from Google, and deciding which of them we sell.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: nothing Google returns reaches a
 * traveller until a person has looked at it and typed the parts Google cannot
 * supply.
 *
 * That is structural rather than procedural. Imports land in `place_candidates`,
 * a table the planner cannot see — `itinerary_blocks.activityId` is a foreign
 * key into `activities`, so a candidate is incapable of appearing in a trip no
 * matter what anybody forgets to check. Approval INSERTS an activity; it never
 * flips a flag on a row that was already visible.
 *
 * WHY A HUMAN IS NOT OPTIONAL. Google answers "does this place exist, and
 * where". An Activity has to answer "what is it, how long does it take, what
 * does it cost in taka, and when is it worth doing". Those four are the whole
 * substance of a planned day, and Places carries none of them: no duration, no
 * BDT price, no category in our vocabulary, no sense of whether it suits a
 * morning. An auto-imported row would be a venue we cannot price, cannot
 * schedule, and have never seen.
 *
 * WHAT IS STORED HERE IS SCAFFOLDING. Google's terms allow keeping `place_id`
 * indefinitely and only limited retention of the rest, so an approved Activity
 * is written from the curator's own prose rather than copied from Google's, and
 * this table can be emptied without touching the catalogue.
 */

const CANDIDATE_SELECT = {
  id: true,
  googlePlaceId: true,
  destinationId: true,
  // `timezone` is here so the review screen can seed the shared activity form,
  // whose `ActivityDestination` requires it. Cheap, and the alternative is a
  // second query on a page that already has the row.
  destination: {
    select: { id: true, name: true, country: true, slug: true, timezone: true },
  },
  name: true,
  formattedAddress: true,
  googleTypes: true,
  rating: true,
  userRatingCount: true,
  priceLevel: true,
  websiteUri: true,
  googleMapsUri: true,
  latitude: true,
  longitude: true,
  openingHoursText: true,
  searchQuery: true,
  status: true,
  rejectedReason: true,
  activityId: true,
  activity: { select: { id: true, slug: true, name: true, isActive: true } },
  reviewedBy: { select: { email: true, name: true } },
  reviewedAt: true,
  importedAt: true,
} as const

export interface StageResult {
  /** Newly written rows, waiting for somebody. */
  imported: number
  /** Already in the table — previously imported, approved or rejected. */
  skipped: number
  /** How many Google returned in total. */
  found: number
  /** Names that were skipped, so a curator can see a rejection holding. */
  skippedNames: string[]
}

/**
 * Search Google and write anything new into the queue.
 *
 * IDEMPOTENT BY GOOGLE'S PLACE ID, which is the property that makes a rejection
 * stick. Without it, running the same search again would re-import something a
 * curator had already turned down, and the queue would refill with the same
 * refusals every time anybody searched. `skipped` is reported rather than
 * silently dropped, so "nothing happened" reads differently from "everything
 * here has already been judged".
 *
 * The write is a `createMany` with `skipDuplicates`, so two curators searching
 * at once cannot make each other's insert fail — the unique index decides and
 * both see a correct count afterwards.
 */
export async function searchAndStage(destinationId: string, query: string): Promise<StageResult> {
  const trimmed = query.trim()
  if (trimmed.length < 3) {
    throw badRequest('Search for something a little more specific.')
  }

  const destination = await db.destination.findUnique({
    where: { id: destinationId },
    select: { id: true, latitude: true, longitude: true },
  })

  if (destination === null) throw notFound('That destination was not found.')

  const results: PlaceResult[] = await searchPlaces({
    query: trimmed,
    // Coordinates bias the search where we have them, and are simply absent
    // where we do not — a destination without them still searches, less sharply.
    latitude: destination.latitude === null ? null : Number(destination.latitude),
    longitude: destination.longitude === null ? null : Number(destination.longitude),
  })

  if (results.length === 0) {
    return { imported: 0, skipped: 0, found: 0, skippedNames: [] }
  }

  const ids = results.map((place) => place.googlePlaceId)

  const already = await db.placeCandidate.findMany({
    where: { googlePlaceId: { in: ids } },
    select: { googlePlaceId: true, name: true },
  })

  const seen = new Set(already.map((row) => row.googlePlaceId))
  const fresh = results.filter((place) => !seen.has(place.googlePlaceId))

  if (fresh.length > 0) {
    await db.placeCandidate.createMany({
      data: fresh.map((place) => ({
        googlePlaceId: place.googlePlaceId,
        destinationId,
        name: place.name,
        formattedAddress: place.formattedAddress,
        googleTypes: place.types,
        rating: place.rating,
        userRatingCount: place.userRatingCount,
        priceLevel: place.priceLevel,
        websiteUri: place.websiteUri,
        googleMapsUri: place.googleMapsUri,
        latitude: place.latitude,
        longitude: place.longitude,
        openingHoursText: place.openingHoursText,
        searchQuery: trimmed,
      })),
      skipDuplicates: true,
    })
  }

  return {
    imported: fresh.length,
    skipped: already.length,
    found: results.length,
    skippedNames: already.map((row) => row.name),
  }
}

/** The queue. Oldest first while pending, so nothing sinks out of sight. */
export async function listCandidates(
  status: PlaceCandidateStatus | null = PlaceCandidateStatus.PENDING,
  take = 100
) {
  return db.placeCandidate.findMany({
    where: status === null ? {} : { status },
    orderBy:
      status === PlaceCandidateStatus.PENDING ? { importedAt: 'asc' } : { reviewedAt: 'desc' },
    take,
    select: CANDIDATE_SELECT,
  })
}

/** How many sit in each status, for the tab counts. */
export async function countCandidates(): Promise<Record<PlaceCandidateStatus, number>> {
  const rows = await db.placeCandidate.groupBy({ by: ['status'], _count: { _all: true } })

  const counts: Record<PlaceCandidateStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 }
  for (const row of rows) counts[row.status] = row._count._all

  return counts
}

export async function readCandidate(id: string) {
  const candidate = await db.placeCandidate.findUnique({ where: { id }, select: CANDIDATE_SELECT })
  if (candidate === null) throw notFound('That imported place was not found.')
  return candidate
}

/**
 * Record that a candidate became an activity.
 *
 * SEPARATE FROM CREATING THE ACTIVITY, deliberately. `createActivity` already
 * owns slug collision, tags, images, opening hours and its own audit entry, and
 * a second implementation here would drift from it the first time a column was
 * added. So the caller creates the activity through that existing path and hands
 * the id here to be linked.
 *
 * Predicated on the row still being PENDING, so two curators approving the same
 * candidate resolve to one — the second is told, rather than silently
 * overwriting the first's link and orphaning an activity.
 */
export async function linkApproval(
  candidateId: string,
  activityId: string,
  adminId: string,
  now: Date = new Date()
) {
  const claimed = await db.placeCandidate.updateMany({
    where: { id: candidateId, status: PlaceCandidateStatus.PENDING },
    data: {
      status: PlaceCandidateStatus.APPROVED,
      activityId,
      reviewedByAdminId: adminId,
      reviewedAt: now,
      rejectedReason: null,
    },
  })

  if (claimed.count === 0) {
    throw conflict('That place has already been decided. Reload to see what happened to it.')
  }
}

/**
 * Decide we will not sell this.
 *
 * A reason is required here and by a CHECK constraint underneath — "we are not
 * selling this" is a judgement the next curator has to be able to read rather
 * than re-derive from the row. The rejection then holds against re-import,
 * because the unique index on `googlePlaceId` means the next search that finds
 * it again skips it instead of queueing it afresh.
 */
export async function rejectCandidate(
  candidateId: string,
  adminId: string,
  reason: string,
  now: Date = new Date()
) {
  const trimmed = reason.trim()
  if (trimmed === '') throw badRequest('Say why, so the next person does not have to guess.')

  const claimed = await db.placeCandidate.updateMany({
    where: { id: candidateId, status: PlaceCandidateStatus.PENDING },
    data: {
      status: PlaceCandidateStatus.REJECTED,
      rejectedReason: trimmed,
      reviewedByAdminId: adminId,
      reviewedAt: now,
    },
  })

  if (claimed.count === 0) {
    throw conflict('That place has already been decided. Reload to see what happened to it.')
  }
}

/**
 * Put a rejected place back in the queue.
 *
 * Rejections are judgements rather than facts, and they age: a restaurant closed
 * for renovation reopens, a hotel changes hands. Without this the only way back
 * would be deleting the row, which would also delete the record that somebody
 * had once said no and why.
 */
export async function reopenCandidate(candidateId: string) {
  const claimed = await db.placeCandidate.updateMany({
    where: { id: candidateId, status: PlaceCandidateStatus.REJECTED },
    data: {
      status: PlaceCandidateStatus.PENDING,
      rejectedReason: null,
      reviewedByAdminId: null,
      reviewedAt: null,
    },
  })

  if (claimed.count === 0) throw conflict('Only a rejected place can be reopened.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestions for the approval form
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A first guess at our category, from Google's type strings.
 *
 * EXPLICITLY A GUESS, and the form treats it as one: it pre-selects a dropdown
 * the curator can change, and nothing depends on it being right. Google's
 * taxonomy is built for maps rather than itineraries — `point_of_interest` and
 * `establishment` are on almost everything and tell us nothing — so this is
 * ordered most-specific-first and falls through to SIGHTSEEING, the least wrong
 * default for a place somebody searched as an attraction.
 */
const TYPE_TO_CATEGORY: readonly (readonly [string, string])[] = [
  ['spa', 'WELLNESS'],
  ['night_club', 'NIGHTLIFE'],
  ['bar', 'NIGHTLIFE'],
  ['shopping_mall', 'SHOPPING'],
  ['market', 'SHOPPING'],
  ['store', 'SHOPPING'],
  ['restaurant', 'FOOD'],
  ['cafe', 'FOOD'],
  ['bakery', 'FOOD'],
  ['food', 'FOOD'],
  ['museum', 'CULTURE'],
  ['art_gallery', 'CULTURE'],
  ['hindu_temple', 'CULTURE'],
  ['mosque', 'CULTURE'],
  ['church', 'CULTURE'],
  ['place_of_worship', 'CULTURE'],
  ['historical_landmark', 'CULTURE'],
  ['national_park', 'NATURE'],
  ['zoo', 'NATURE'],
  ['campground', 'NATURE'],
  ['beach', 'NATURE'],
  ['park', 'NATURE'],
  ['amusement_park', 'ADVENTURE'],
  ['airport', 'TRANSPORT'],
  ['bus_station', 'TRANSPORT'],
  ['train_station', 'TRANSPORT'],
  ['ferry_terminal', 'TRANSPORT'],
]

export function suggestCategory(googleTypes: readonly string[]): string {
  const types = new Set(googleTypes)

  for (const [needle, category] of TYPE_TO_CATEGORY) {
    if (types.has(needle)) return category
  }

  return 'SIGHTSEEING'
}

/**
 * A slug from the venue name, prefixed with the destination.
 *
 * Prefixed because activity slugs are globally unique and beach names are not —
 * more than one coastal town has a "Laboni Point", and the second import would
 * collide. The curator can edit it; this only has to be a sensible start.
 */
export function suggestSlug(destinationSlug: string, name: string): string {
  return (
    `${destinationSlug}-${name}`
      .toLowerCase()
      .normalize('NFKD')
      // Apostrophes are dropped rather than replaced, so "Cox's" does not become
      // "cox-s" with a hyphen in the middle of a word.
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120)
      .replace(/-+$/, '')
  )
}
