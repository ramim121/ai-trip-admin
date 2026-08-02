import { randomInt } from 'node:crypto'
import { Prisma } from '@/generated/prisma/client'
import {
  BookingStatus,
  CouponType,
  DepartureStatus,
  PackagePricingMode,
  PackageStatus,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { normalizeEmail } from '@/server/auth/email'
import { badRequest, conflict, notFound } from '@/server/http/errors'

/**
 * Booking a seat on a dated departure, and the coupon engine behind the price.
 *
 * THE SEAT CLAIM IS ONE STATEMENT
 *
 * `claimSeats` is a raw UPDATE whose WHERE clause compares two columns:
 *
 *   SET "seatsTaken" = "seatsTaken" + n WHERE id = ? AND "seatsTaken" + n <= capacity
 *
 * Written through the query builder this would have to be a read of `capacity`
 * followed by a write, and the gap between them is exactly wide enough for two
 * people to book the last seat. Postgres evaluates the predicate against
 * committed state under a row lock, so of two concurrent requests for one seat
 * precisely one updates a row and the other gets zero — a refusal, not a shrug.
 * The CHECK constraint on the table is the second line of defence, and would
 * turn a mistake here into a failed statement rather than an oversold bus.
 *
 * WHY MONEY IS SNAPSHOT AND NEVER RECOMPUTED
 *
 * Every figure is written once, at booking time. Re-deriving a total later from
 * the departure's current price and the coupon's current terms would mean a
 * repricing silently restating what somebody already agreed to pay. The
 * database refuses a booking whose numbers do not add up; this module is what
 * makes sure they do.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The reference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No vowels, no 0/O, no 1/I/L.
 *
 * This string gets read down a phone line and typed back by somebody who is not
 * looking at it. Removing the characters people confuse is worth more than the
 * entropy it costs — and at six characters this alphabet still gives around
 * half a billion combinations.
 */
const REFERENCE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ'
const REFERENCE_LENGTH = 6

/** How many collisions to ride out before admitting something is wrong. */
const MAX_REFERENCE_ATTEMPTS = 5

function mintReference(): string {
  let out = ''
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
    out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]
  }
  return `BB-${out}`
}

/** Postgres unique violation, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002'

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION
}

// ─────────────────────────────────────────────────────────────────────────────
// Coupons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a code was refused, in a form a client can branch on.
 *
 * A closed vocabulary, like the entitlement refusals. The message is for a
 * human and its wording is not part of the contract; the code is.
 */
export const COUPON_REFUSALS = [
  'UNKNOWN',
  'INACTIVE',
  'NOT_STARTED',
  'EXPIRED',
  'WRONG_PACKAGE',
  'BELOW_MIN_SPEND',
  'FULLY_REDEEMED',
  'ALREADY_USED',
] as const
export type CouponRefusal = (typeof COUPON_REFUSALS)[number]

export interface CouponApplied {
  readonly ok: true
  readonly couponId: string
  readonly code: string
  readonly label: string
  /** Whole taka off the subtotal. Always at least 1 — see `evaluateCoupon`. */
  readonly discountBdt: number
}

export interface CouponRejected {
  readonly ok: false
  readonly reason: CouponRefusal
  readonly message: string
}

export type CouponOutcome = CouponApplied | CouponRejected

function reject(reason: CouponRefusal, message: string): CouponRejected {
  return { ok: false, reason, message }
}

/**
 * What a coupon takes off a given subtotal.
 *
 * Rounded DOWN, and capped at the subtotal. Rounding a percentage up would
 * occasionally hand out a taka nobody authorised, and a discount larger than
 * the subtotal would produce a negative total that the database refuses — as a
 * 500 rather than as a sensible refusal.
 */
function discountFor(
  coupon: { type: CouponType; value: number; maxDiscountBdt: number | null },
  subtotalBdt: number
): number {
  const raw =
    coupon.type === CouponType.PERCENT
      ? Math.floor((subtotalBdt * coupon.value) / 100)
      : coupon.value

  const capped = coupon.maxDiscountBdt === null ? raw : Math.min(raw, coupon.maxDiscountBdt)
  return Math.max(0, Math.min(capped, subtotalBdt))
}

export interface CouponContext {
  code: string
  packageId: string
  subtotalBdt: number
  /** Null for a signed-out booking. See the note on the per-account ceiling. */
  userId: string | null
}

/**
 * Decide whether a code applies, and for how much.
 *
 * Advisory only. This is what the form calls as somebody types, and what the
 * booking path calls again before it writes — the second call is the one that
 * counts, because everything checked here can change between the two.
 *
 * The per-account ceiling is skipped for a signed-out booking, and that is a
 * real hole rather than an oversight: without an account there is nothing to
 * count against. A code relying on `maxPerUser` should therefore also carry
 * `maxRedemptions`, which binds for everybody — the console says so, and this
 * comment is here so the next person does not "fix" the skip by trusting an
 * email address instead.
 */
export async function evaluateCoupon(context: CouponContext): Promise<CouponOutcome> {
  const code = context.code.trim().toUpperCase()
  if (code === '') return reject('UNKNOWN', 'Enter a promo code.')

  const coupon = await db.coupon.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      label: true,
      type: true,
      value: true,
      maxDiscountBdt: true,
      minSpendBdt: true,
      startsAt: true,
      endsAt: true,
      maxRedemptions: true,
      maxPerUser: true,
      packageId: true,
      isActive: true,
    },
  })

  // An unknown code and a switched-off one are told apart, deliberately. There
  // is nothing to protect here — a coupon is not a credential — and "this code
  // is no longer running" is more useful to read than "no such code".
  if (coupon === null) return reject('UNKNOWN', 'That promo code was not recognised.')
  if (!coupon.isActive) return reject('INACTIVE', 'That promo code is no longer active.')

  const now = new Date()
  if (coupon.startsAt !== null && coupon.startsAt > now) {
    return reject('NOT_STARTED', 'That promo code has not started yet.')
  }
  if (coupon.endsAt !== null && coupon.endsAt <= now) {
    return reject('EXPIRED', 'That promo code has expired.')
  }

  if (coupon.packageId !== null && coupon.packageId !== context.packageId) {
    return reject('WRONG_PACKAGE', 'That promo code does not apply to this trip.')
  }

  if (coupon.minSpendBdt !== null && context.subtotalBdt < coupon.minSpendBdt) {
    return reject(
      'BELOW_MIN_SPEND',
      `That promo code needs a booking of at least ৳${coupon.minSpendBdt.toLocaleString('en-GB')}.`
    )
  }

  // Counted from the redemption rows rather than from `redeemedCount`, which is
  // a denormalisation for the console and the wrong thing to enforce against.
  if (coupon.maxRedemptions !== null) {
    const used = await db.couponRedemption.count({ where: { couponId: coupon.id } })
    if (used >= coupon.maxRedemptions) {
      return reject('FULLY_REDEEMED', 'That promo code has been fully claimed.')
    }
  }

  if (context.userId !== null) {
    const mine = await db.couponRedemption.count({
      where: { couponId: coupon.id, userId: context.userId },
    })
    if (mine >= coupon.maxPerUser) {
      return reject('ALREADY_USED', 'You have already used that promo code.')
    }
  }

  const discountBdt = discountFor(coupon, context.subtotalBdt)

  // A code that would take nothing off is refused rather than applied. Showing
  // "promo code applied — ৳0 off" is worse than saying it does not qualify, and
  // the redemption row would consume a ceiling for no benefit.
  if (discountBdt <= 0) {
    return reject('BELOW_MIN_SPEND', 'That promo code takes nothing off this booking.')
  }

  return { ok: true, couponId: coupon.id, code: coupon.code, label: coupon.label, discountBdt }
}

// ─────────────────────────────────────────────────────────────────────────────
// Quoting
// ─────────────────────────────────────────────────────────────────────────────

export interface DepartureQuote {
  packageId: string
  packageSlug: string
  packageTitle: string
  departureId: string
  startDate: Date
  endDate: Date
  partySize: number
  unitPriceBdt: number
  subtotalBdt: number
  discountBdt: number
  totalBdt: number
  coupon: CouponApplied | null
  couponRefusal: CouponRejected | null
  seatsLeft: number
}

/**
 * Price a party on a departure, applying a code if one was given.
 *
 * The single place a total is computed, used by the quote endpoint and by the
 * booking write. Two implementations of this arithmetic would eventually
 * disagree, and the one a traveller saw is not necessarily the one they were
 * charged.
 */
export async function quoteDeparture(input: {
  slug: string
  departureId: string
  partySize: number
  couponCode?: string | null
  userId: string | null
}): Promise<DepartureQuote> {
  const departure = await db.packageDeparture.findFirst({
    where: {
      id: input.departureId,
      package: { slug: input.slug, status: PackageStatus.PUBLISHED },
    },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      capacity: true,
      seatsTaken: true,
      priceBdt: true,
      status: true,
      package: {
        select: { id: true, slug: true, title: true, priceFromBdt: true, pricingMode: true },
      },
    },
  })

  if (departure === null) throw notFound('That departure was not found on this trip.')

  if (departure.package.pricingMode === PackagePricingMode.INTEREST_ONLY) {
    throw conflict(
      'This trip is not costed yet, so it cannot be booked. Register your interest instead.'
    )
  }

  if (
    departure.status === DepartureStatus.CANCELLED ||
    departure.status === DepartureStatus.COMPLETED
  ) {
    throw conflict('That departure is no longer taking bookings.')
  }

  // The departure's override, or the package price. Never a figure from the
  // request — the client sends a party size and a code, and nothing else that
  // touches money.
  const unitPriceBdt = departure.priceBdt ?? departure.package.priceFromBdt
  if (unitPriceBdt === null) {
    throw conflict('This trip has no price set. Please contact us to book it.')
  }

  const subtotalBdt = unitPriceBdt * input.partySize

  let coupon: CouponApplied | null = null
  let couponRefusal: CouponRejected | null = null

  if (input.couponCode != null && input.couponCode.trim() !== '') {
    const outcome = await evaluateCoupon({
      code: input.couponCode,
      packageId: departure.package.id,
      subtotalBdt,
      userId: input.userId,
    })

    // A bad code does not fail the quote. Somebody mistyping a promo code
    // should still see what the trip costs, with the reason beside the field —
    // throwing here would replace the price with an error.
    if (outcome.ok) coupon = outcome
    else couponRefusal = outcome
  }

  const discountBdt = coupon?.discountBdt ?? 0

  return {
    packageId: departure.package.id,
    packageSlug: departure.package.slug,
    packageTitle: departure.package.title,
    departureId: departure.id,
    startDate: departure.startDate,
    endDate: departure.endDate,
    partySize: input.partySize,
    unitPriceBdt,
    subtotalBdt,
    discountBdt,
    totalBdt: subtotalBdt - discountBdt,
    coupon,
    couponRefusal,
    seatsLeft: Math.max(0, departure.capacity - departure.seatsTaken),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Holding the seats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Take `seats` from a departure, or take none.
 *
 * One statement, with the capacity comparison inside the WHERE clause so
 * Postgres evaluates it against committed state under a row lock. Two requests
 * for the last seat therefore see 15 and then 16 of 16, and exactly one of them
 * updates a row.
 *
 * Returns whether the claim succeeded. Zero rows is a refusal — the departure
 * filled, or was cancelled between the quote and the write — never an error to
 * swallow.
 */
async function claimSeats(
  tx: Prisma.TransactionClient,
  departureId: string,
  seats: number
): Promise<boolean> {
  const claimed = await tx.$executeRaw`
    UPDATE "package_departures"
       SET "seatsTaken" = "seatsTaken" + ${seats},
           "updatedAt"  = NOW()
     WHERE "id" = ${departureId}::uuid
       AND "status" NOT IN ('CANCELLED', 'COMPLETED')
       AND "seatsTaken" + ${seats} <= "capacity"
  `

  return claimed === 1
}

/** Give the seats back. Guarded so it can never drive the count negative. */
async function releaseSeats(
  tx: Prisma.TransactionClient,
  departureId: string,
  seats: number
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "package_departures"
       SET "seatsTaken" = "seatsTaken" - ${seats},
           "updatedAt"  = NOW()
     WHERE "id" = ${departureId}::uuid
       AND "seatsTaken" >= ${seats}
  `
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating a booking
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateBookingInput {
  slug: string
  departureId: string
  partySize: number
  contactName: string
  contactEmail: string
  contactPhone?: string | null
  notes?: string | null
  couponCode?: string | null
  userId: string | null
}

export interface BookingCreated {
  bookingId: string
  reference: string
  totalBdt: number
  discountBdt: number
  subtotalBdt: number
  unitPriceBdt: number
  partySize: number
  couponCode: string | null
}

/**
 * Hold the seats and write the booking.
 *
 * Everything happens inside one transaction, and the ORDER matters: the seats
 * are claimed FIRST. A booking row written before the claim would exist for a
 * departure that turned out to be full, and the compensating delete is a code
 * path that only runs when something has already gone wrong — which is the code
 * path least likely to be correct.
 *
 * The coupon is re-evaluated rather than trusted from the quote the client was
 * shown. Everything the quote checked can change in between: the code can be
 * exhausted by somebody else, the window can close, the traveller can spend it
 * on another booking in a second tab.
 */
export async function createBooking(input: CreateBookingInput): Promise<BookingCreated> {
  const quote = await quoteDeparture({
    slug: input.slug,
    departureId: input.departureId,
    partySize: input.partySize,
    couponCode: input.couponCode,
    userId: input.userId,
  })

  // A code that was typed and then refused stops the booking, unlike on the
  // quote. Silently charging the full price for a booking somebody submitted
  // expecting a discount is the one outcome nobody would forgive.
  if (quote.couponRefusal !== null) {
    throw badRequest(quote.couponRefusal.message, [
      { path: 'couponCode', message: quote.couponRefusal.reason },
    ])
  }

  const contactEmail = normalizeEmail(input.contactEmail)

  for (let attempt = 1; attempt <= MAX_REFERENCE_ATTEMPTS; attempt += 1) {
    const reference = mintReference()

    try {
      return await db.$transaction(async (tx) => {
        const claimed = await claimSeats(tx, quote.departureId, input.partySize)
        if (!claimed) {
          throw conflict(
            `There are not enough seats left on that departure for ${input.partySize} ` +
              `${input.partySize === 1 ? 'traveller' : 'travellers'}.`
          )
        }

        const booking = await tx.packageBooking.create({
          data: {
            reference,
            userId: input.userId,
            packageId: quote.packageId,
            departureId: quote.departureId,
            partySize: input.partySize,
            unitPriceBdt: quote.unitPriceBdt,
            subtotalBdt: quote.subtotalBdt,
            discountBdt: quote.discountBdt,
            totalBdt: quote.totalBdt,
            status: BookingStatus.PENDING_PAYMENT,
            contactName: input.contactName.trim(),
            contactEmail,
            contactPhone: input.contactPhone?.trim() || null,
            notes: input.notes?.trim() || null,
          },
          select: { id: true, reference: true },
        })

        if (quote.coupon !== null) {
          await tx.couponRedemption.create({
            data: {
              couponId: quote.coupon.couponId,
              userId: input.userId,
              bookingId: booking.id,
              discountBdt: quote.coupon.discountBdt,
            },
            select: { id: true },
          })

          // The console's counter. The ceiling is enforced against the rows
          // above; this is bookkeeping, incremented in the same transaction so
          // it cannot drift from them.
          await tx.coupon.update({
            where: { id: quote.coupon.couponId },
            data: { redeemedCount: { increment: 1 } },
            select: { id: true },
          })
        }

        return {
          bookingId: booking.id,
          reference: booking.reference,
          totalBdt: quote.totalBdt,
          discountBdt: quote.discountBdt,
          subtotalBdt: quote.subtotalBdt,
          unitPriceBdt: quote.unitPriceBdt,
          partySize: input.partySize,
          couponCode: quote.coupon?.code ?? null,
        }
      })
    } catch (e) {
      // Only a reference collision is worth retrying, and the retry is a new
      // reference rather than a new booking. Anything else — including the seat
      // refusal above — propagates.
      if (isUniqueViolation(e) && attempt < MAX_REFERENCE_ATTEMPTS) continue
      throw e
    }
  }

  throw conflict('That booking could not be created just now. Please try again.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark a booking paid. Called by the settlement, never by a client.
 *
 * The seats are NOT claimed here — they were held when the booking was made.
 * Claiming again would double-count the party, which is the bug this comment
 * exists to stop somebody helpfully introducing.
 *
 * Idempotent through the WHERE clause: a replayed callback matches nothing,
 * because the row is no longer PENDING_PAYMENT.
 */
export async function confirmBooking(
  tx: Prisma.TransactionClient,
  bookingId: string,
  now: Date
): Promise<boolean> {
  const updated = await tx.packageBooking.updateMany({
    where: { id: bookingId, status: BookingStatus.PENDING_PAYMENT },
    data: { status: BookingStatus.CONFIRMED, confirmedAt: now },
  })

  return updated.count === 1
}

/**
 * Cancel a booking and give the seats back.
 *
 * The release is inside the same transaction as the status change and shares
 * its predicate: a booking already cancelled matches nothing, so the seats are
 * released exactly once however many times this runs.
 */
export async function cancelBooking(
  bookingId: string,
  reason: string,
  now: Date = new Date()
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const booking = await tx.packageBooking.findUnique({
      where: { id: bookingId },
      select: { departureId: true, partySize: true, status: true },
    })

    if (booking === null) return false
    if (booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.REFUNDED) {
      return false
    }

    const cancelled = await tx.packageBooking.updateMany({
      where: {
        id: bookingId,
        status: { in: [BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED] },
      },
      data: {
        // A confirmed booking that is cancelled is money we have to give back,
        // and the two states are worth telling apart in every report that ever
        // reads this column.
        status:
          booking.status === BookingStatus.CONFIRMED
            ? BookingStatus.REFUNDED
            : BookingStatus.CANCELLED,
        cancelledAt: now,
        cancellationReason: reason,
      },
    })

    if (cancelled.count !== 1) return false

    await releaseSeats(tx, booking.departureId, booking.partySize)
    return true
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

const BOOKING_SELECT = {
  id: true,
  reference: true,
  partySize: true,
  unitPriceBdt: true,
  subtotalBdt: true,
  discountBdt: true,
  totalBdt: true,
  status: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  confirmedAt: true,
  cancelledAt: true,
  createdAt: true,
  package: { select: { slug: true, title: true, destinationLabel: true, country: true } },
  departure: { select: { startDate: true, endDate: true, status: true } },
  redemption: { select: { discountBdt: true, coupon: { select: { code: true, label: true } } } },
} as const

export type BookingRow = Prisma.PackageBookingGetPayload<{ select: typeof BOOKING_SELECT }>

/** One booking, scoped to its owner. Somebody else's is indistinguishable from absent. */
export async function readBooking(userId: string, bookingId: string): Promise<BookingRow> {
  const booking = await db.packageBooking.findFirst({
    where: { id: bookingId, userId },
    select: BOOKING_SELECT,
  })

  if (booking === null) throw notFound('That booking was not found.')
  return booking
}

/** A traveller's own bookings, newest first. */
export async function listMyBookings(userId: string, take = 50): Promise<BookingRow[]> {
  return db.packageBooking.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: BOOKING_SELECT,
  })
}

/** Every booking, for the console. */
export async function listAllBookings(take = 100) {
  return db.packageBooking.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      ...BOOKING_SELECT,
      user: { select: { email: true } },
      payments: { select: { id: true, status: true, isTest: true, settledAt: true } },
    },
  })
}

/** Every coupon, with how much of its ceiling is gone. Console only. */
export async function listCoupons(take = 100) {
  return db.coupon.findMany({
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
    take,
    select: {
      id: true,
      code: true,
      label: true,
      description: true,
      type: true,
      value: true,
      maxDiscountBdt: true,
      minSpendBdt: true,
      startsAt: true,
      endsAt: true,
      maxRedemptions: true,
      maxPerUser: true,
      redeemedCount: true,
      isActive: true,
      package: { select: { slug: true, title: true } },
      _count: { select: { redemptions: true } },
    },
  })
}
