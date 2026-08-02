import type { Prisma } from '@/generated/prisma/client'
import {
  DepartureStatus,
  PackageInterestStatus,
  PackageScope,
  PackageStatus,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { normalizeEmail } from '@/server/auth/email'
import { conflict, notFound } from '@/server/http/errors'

/**
 * Reading and joining the Discover catalogue.
 *
 * Packages are trips ops designed in advance, as opposed to the ones the
 * planner builds on demand. Everything here is a public read except
 * `registerInterest`, and the reads share one rule: a caller only ever sees
 * PUBLISHED rows. That is a WHERE clause on every query rather than a filter
 * applied afterwards, for the same reason `listDestinations` does it — a client
 * handed drafts would have to remember to drop them, and one day one of them
 * would not.
 *
 * TWO COUNTS THAT LOOK ALIKE AND ARE NOT
 *
 * `registeredCount` counts PackageInterest rows: people who said they would
 * come. `seatsTaken` counts seats actually held on a dated departure. They are
 * deliberately never added together and never substituted for one another — an
 * interest is a lead, a seat is a commitment, and a waiting list that could
 * close a departure is a bug that costs real money to unwind.
 */

/** Departures a traveller can still join. CANCELLED and COMPLETED are neither. */
const JOINABLE_DEPARTURES: readonly DepartureStatus[] = [
  DepartureStatus.SCHEDULED,
  DepartureStatus.GUARANTEED,
  DepartureStatus.SOLD_OUT,
]

/** Interests that occupy a place on the list. A withdrawal frees it. */
const COUNTED_INTERESTS: readonly PackageInterestStatus[] = [
  PackageInterestStatus.NEW,
  PackageInterestStatus.CONTACTED,
  PackageInterestStatus.CONVERTED,
]

/** How many packages one listing request may return. */
export const MAX_PACKAGE_LIST = 60

/**
 * Fields every card needs, and no more.
 *
 * `description` is deliberately absent: it is the long body of the detail page,
 * and shipping twenty of them to render twenty cards is the sort of thing that
 * makes a listing endpoint slow for no visible reason.
 */
const CARD_SELECT = {
  id: true,
  slug: true,
  title: true,
  summary: true,
  scope: true,
  kind: true,
  pricingMode: true,
  destinationLabel: true,
  country: true,
  durationDays: true,
  durationNights: true,
  priceFromBdt: true,
  priceToBdt: true,
  groupSizeMin: true,
  groupSizeMax: true,
  heroImageUrl: true,
  cardImageUrl: true,
  highlights: true,
  destination: { select: { slug: true, name: true } },
} as const

const DEPARTURE_SELECT = {
  id: true,
  startDate: true,
  endDate: true,
  capacity: true,
  seatsTaken: true,
  priceBdt: true,
  status: true,
  notes: true,
} as const

const LEADER_SELECT = {
  role: true,
  isPrimary: true,
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

const DAY_SELECT = {
  id: true,
  dayNumber: true,
  title: true,
  summary: true,
  accommodation: true,
  meals: true,
  items: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      kind: true,
      title: true,
      detail: true,
      startMinute: true,
      durationMinutes: true,
    },
  },
} as const satisfies Prisma.PackageItineraryDayFindManyArgs['select'] & object

export type PackageDepartureRow = Prisma.PackageDepartureGetPayload<{
  select: typeof DEPARTURE_SELECT
}>
export type PackageLeaderRow = Prisma.PackageLeaderGetPayload<{ select: typeof LEADER_SELECT }>
export type PackageDayRow = Prisma.PackageItineraryDayGetPayload<{ select: typeof DAY_SELECT }>

export interface PackageCard extends Prisma.TravelPackageGetPayload<{
  select: typeof CARD_SELECT
}> {
  /** Non-withdrawn PackageInterest rows. People, not seats. */
  registeredCount: number
  /** Joinable departures still ahead of today. */
  upcomingDepartureCount: number
  /** The soonest of those — what the card prints as the probable travel date. */
  nextDeparture: PackageDepartureRow | null
  /** The name on the card: the primary leader, or the first one listed. */
  primaryLeader: PackageLeaderRow | null
}

export interface PackageDetail extends PackageCard {
  description: string
  inclusions: string[]
  exclusions: string[]
  metaTitle: string | null
  metaDescription: string | null
  days: PackageDayRow[]
  departures: PackageDepartureRow[]
  leaders: PackageLeaderRow[]
}

export interface PackageListOptions {
  scope?: PackageScope
  /** Free text over title, summary, destination label and country. */
  query?: string
  limit?: number
}

/**
 * The date a departure is compared against.
 *
 * `startDate` is a `@db.Date`, which Postgres returns as UTC midnight. Comparing
 * it against `new Date()` would drop a departure leaving *today* at 06:00 the
 * moment the clock passes midnight UTC — while it is still, in Dhaka, a trip
 * somebody could join this morning. Flooring to today's UTC midnight keeps a
 * same-day departure visible for the whole of that day.
 */
function todayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** The primary leader, or the first by curator order. Null when nobody is assigned. */
function pickPrimaryLeader(leaders: PackageLeaderRow[]): PackageLeaderRow | null {
  return leaders.find((entry) => entry.isPrimary) ?? leaders[0] ?? null
}

/**
 * Published packages, in the order ops merchandised them.
 *
 * The counts and the departures are fetched alongside the rows rather than per
 * card, so a page of twenty is one query and not sixty-one. Prisma's filtered
 * `_count` does the interest tally in the same statement as the package.
 */
export async function listPackages(
  options: PackageListOptions = {},
  now: Date = new Date()
): Promise<PackageCard[]> {
  const today = todayUtc(now)
  const take = Math.min(MAX_PACKAGE_LIST, Math.max(1, options.limit ?? MAX_PACKAGE_LIST))

  const search = options.query?.trim()
  const where: Prisma.TravelPackageWhereInput = {
    status: PackageStatus.PUBLISHED,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { summary: { contains: search, mode: 'insensitive' } },
            { destinationLabel: { contains: search, mode: 'insensitive' } },
            { country: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  }

  const packages = await db.travelPackage.findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { publishedAt: 'desc' }, { title: 'asc' }],
    take,
    select: {
      ...CARD_SELECT,
      _count: { select: { interests: { where: { status: { in: [...COUNTED_INTERESTS] } } } } },
      departures: {
        where: { startDate: { gte: today }, status: { in: [...JOINABLE_DEPARTURES] } },
        orderBy: { startDate: 'asc' },
        select: DEPARTURE_SELECT,
      },
      leaders: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], select: LEADER_SELECT },
    },
  })

  return packages.map(({ _count, departures, leaders, ...card }) => ({
    ...card,
    registeredCount: _count.interests,
    upcomingDepartureCount: departures.length,
    nextDeparture: departures[0] ?? null,
    primaryLeader: pickPrimaryLeader(leaders),
  }))
}

/**
 * One published package, with its itinerary, its departures and its people.
 *
 * Returns null rather than throwing, so the caller decides between a 404 and a
 * quiet omission. A DRAFT slug is indistinguishable from one that does not
 * exist, deliberately: a draft trip is not a secret, but it is not an
 * announcement either, and "coming soon, here is the URL" should be ops's
 * decision rather than an accident of the WHERE clause.
 */
export async function getPackage(
  slug: string,
  now: Date = new Date()
): Promise<PackageDetail | null> {
  const today = todayUtc(now)

  const row = await db.travelPackage.findFirst({
    where: { slug, status: PackageStatus.PUBLISHED },
    select: {
      ...CARD_SELECT,
      description: true,
      inclusions: true,
      exclusions: true,
      metaTitle: true,
      metaDescription: true,
      _count: { select: { interests: { where: { status: { in: [...COUNTED_INTERESTS] } } } } },
      days: { orderBy: { dayNumber: 'asc' }, select: DAY_SELECT },
      departures: {
        // Past departures are dropped, but a CANCELLED one still ahead of us is
        // kept: a traveller who had that date in mind deserves to see it was
        // cancelled rather than find it silently missing.
        where: { startDate: { gte: today } },
        orderBy: { startDate: 'asc' },
        select: DEPARTURE_SELECT,
      },
      leaders: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], select: LEADER_SELECT },
    },
  })

  if (row === null) return null

  const { _count, ...rest } = row
  const joinable = rest.departures.filter((departure) =>
    JOINABLE_DEPARTURES.includes(departure.status)
  )

  return {
    ...rest,
    registeredCount: _count.interests,
    upcomingDepartureCount: joinable.length,
    nextDeparture: joinable[0] ?? null,
    primaryLeader: pickPrimaryLeader(rest.leaders),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registering interest
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisterInterestInput {
  slug: string
  name: string
  email: string
  phone?: string | null
  partySize: number
  message?: string | null
  /** Which running of it, when they picked one. */
  departureId?: string | null
  /** Set when the caller was signed in. */
  userId?: string | null
}

export interface InterestResult {
  /** True when this call created the row; false when it already existed. */
  created: boolean
  /** The list's size afterwards, which is what the page re-renders with. */
  registeredCount: number
}

/**
 * Add somebody to a package's interest list.
 *
 * Idempotent on (package, email), which is what the unique index is for.
 * Registering twice is a double-click or a second visit, not two travellers,
 * and this count is printed on a public card — so a duplicate would inflate the
 * exact number the feature exists to communicate.
 *
 * A repeat registration UPDATES the details rather than being refused. Somebody
 * coming back to correct a phone number or change a party size is doing the
 * obvious thing, and "you already registered" would leave them no way to fix it.
 * What it does not do is quietly reopen a WITHDRAWN row: that is a person who
 * asked to come off the list, so their return is filed as a fresh NEW lead
 * rather than left looking withdrawn to whoever works the queue.
 */
export async function registerInterest(input: RegisterInterestInput): Promise<InterestResult> {
  const email = normalizeEmail(input.email)

  const pkg = await db.travelPackage.findFirst({
    where: { slug: input.slug, status: PackageStatus.PUBLISHED },
    select: { id: true },
  })
  if (pkg === null) throw notFound('That trip was not found.')

  // A departure id from the client is a claim, and this is where it stops being
  // one. Checking it belongs to THIS package is what stops a registration being
  // filed against another trip's date.
  if (input.departureId != null) {
    const departure = await db.packageDeparture.findFirst({
      where: { id: input.departureId, packageId: pkg.id },
      select: { id: true, status: true },
    })
    if (departure === null) throw notFound('That departure was not found on this trip.')
    if (
      departure.status === DepartureStatus.CANCELLED ||
      departure.status === DepartureStatus.COMPLETED
    ) {
      throw conflict('That departure is no longer taking registrations.')
    }
  }

  const existing = await db.packageInterest.findUnique({
    where: { packageId_email: { packageId: pkg.id, email } },
    select: { id: true, status: true },
  })

  if (existing === null) {
    await db.packageInterest.create({
      data: {
        packageId: pkg.id,
        departureId: input.departureId ?? null,
        userId: input.userId ?? null,
        name: input.name.trim(),
        email,
        phone: input.phone?.trim() || null,
        partySize: input.partySize,
        message: input.message?.trim() || null,
      },
      select: { id: true },
    })
  } else {
    await db.packageInterest.update({
      where: { id: existing.id },
      data: {
        departureId: input.departureId ?? null,
        // Only attach the account when we have one. A signed-out correction
        // must not detach the row from the account that first made it.
        ...(input.userId != null ? { userId: input.userId } : {}),
        name: input.name.trim(),
        phone: input.phone?.trim() || null,
        partySize: input.partySize,
        message: input.message?.trim() || null,
        ...(existing.status === PackageInterestStatus.WITHDRAWN
          ? { status: PackageInterestStatus.NEW, contactedAt: null }
          : {}),
      },
      select: { id: true },
    })
  }

  const registeredCount = await db.packageInterest.count({
    where: { packageId: pkg.id, status: { in: [...COUNTED_INTERESTS] } },
  })

  return { created: existing === null, registeredCount }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console reads
// ─────────────────────────────────────────────────────────────────────────────

/** Every package, drafts included. For the console only. */
export async function listAllPackages(take = 200) {
  return db.travelPackage.findMany({
    orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }, { title: 'asc' }],
    take,
    select: {
      id: true,
      slug: true,
      title: true,
      scope: true,
      kind: true,
      pricingMode: true,
      status: true,
      priceFromBdt: true,
      priceToBdt: true,
      durationDays: true,
      destinationLabel: true,
      publishedAt: true,
      sortOrder: true,
      _count: {
        select: {
          departures: true,
          days: true,
          leaders: true,
          interests: { where: { status: { in: [...COUNTED_INTERESTS] } } },
        },
      },
    },
  })
}

/** The interest list, newest first, for the console's leads screen. */
export async function listInterests(take = 100) {
  return db.packageInterest.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      partySize: true,
      message: true,
      status: true,
      contactedAt: true,
      createdAt: true,
      package: { select: { slug: true, title: true, pricingMode: true } },
      departure: { select: { startDate: true, endDate: true } },
      user: { select: { email: true } },
    },
  })
}
