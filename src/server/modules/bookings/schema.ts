import { z } from 'zod'
import { BookingStatus, DepartureStatus } from '@/generated/prisma/enums'
import { COUPON_REFUSALS, type BookingRow, type DepartureQuote } from './service'

/**
 * The wire contract for quoting and booking a departure.
 *
 * WHAT IS NOT IN A REQUEST BODY: an amount, a unit price, a discount, or a
 * total. The same rule the payments module states at length — the client names
 * a departure, a party size and at most a code; every figure comes back from
 * the server. These are plain `z.object()`s, so a body carrying `totalBdt: 1`
 * has that key stripped before any handler sees it.
 *
 * A REFUSED CODE IS NOT AN ERROR ON A QUOTE
 *
 * `QuoteResponse` carries `coupon` and `couponRefusal` side by side, and at
 * most one is set. Somebody mistyping a promo code should still see what the
 * trip costs, with the reason beside the field — answering 400 would replace
 * the price with an error. On the BOOKING itself a refused code IS a 400, since
 * charging full price for a booking submitted in expectation of a discount is
 * the one outcome nobody would forgive.
 */

const CouponRefusalSchema = z
  .enum(COUPON_REFUSALS)
  .describe(
    'Why the code did not apply. A closed vocabulary — branch on this rather than on the message.'
  )

export const AppliedCoupon = z
  .object({
    code: z.string(),
    label: z.string().describe('What to show when it applies, e.g. "Early bird — 15% off".'),
    discountBdt: z.int().positive().describe('Whole taka off the subtotal. Never zero.'),
  })
  .meta({ id: 'AppliedCoupon' })
export type AppliedCoupon = z.infer<typeof AppliedCoupon>

export const RejectedCoupon = z
  .object({
    reason: CouponRefusalSchema,
    message: z.string().describe('Safe to show a traveller. Wording is not part of the contract.'),
  })
  .meta({ id: 'RejectedCoupon' })
export type RejectedCoupon = z.infer<typeof RejectedCoupon>

export const QuoteBody = z
  .object({
    departureId: z.uuid(),
    partySize: z
      .int()
      .min(1)
      .max(40)
      .describe('Seats wanted. Bounded so a public form cannot ask for two billion.'),
    couponCode: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe('Case-insensitive; uppercased before lookup.'),
  })
  .meta({ id: 'QuoteBody' })
export type QuoteBody = z.infer<typeof QuoteBody>

export const QuoteResponse = z
  .object({
    departureId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    partySize: z.int().positive(),
    unitPriceBdt: z.int().nonnegative().describe('Per person, whole taka. The server’s figure.'),
    subtotalBdt: z.int().nonnegative().describe('`unitPriceBdt * partySize`.'),
    discountBdt: z.int().nonnegative(),
    totalBdt: z.int().nonnegative().describe('`subtotalBdt - discountBdt`. What will be charged.'),
    seatsLeft: z.int().nonnegative(),
    coupon: AppliedCoupon.nullable(),
    couponRefusal: RejectedCoupon.nullable().describe(
      'Set when a code was sent and did not apply. The quote still carries a full price.'
    ),
  })
  .meta({ id: 'QuoteResponse' })
export type QuoteResponse = z.infer<typeof QuoteResponse>

export const CreateBookingBody = QuoteBody.extend({
  contactName: z.string().trim().min(1).max(120),
  contactEmail: z.email().max(254).describe('Lowercased before storage.'),
  contactPhone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(1_000).optional(),
}).meta({ id: 'CreateBookingBody' })
export type CreateBookingBody = z.infer<typeof CreateBookingBody>

export const CreateBookingResponse = z
  .object({
    bookingId: z.uuid(),
    reference: z
      .string()
      .describe('Short human code, e.g. `BB-7F3K2Q`. What a traveller quotes on the phone.'),
    partySize: z.int().positive(),
    unitPriceBdt: z.int().nonnegative(),
    subtotalBdt: z.int().nonnegative(),
    discountBdt: z.int().nonnegative(),
    totalBdt: z.int().nonnegative(),
    couponCode: z.string().nullable(),
  })
  .meta({ id: 'CreateBookingResponse' })
export type CreateBookingResponse = z.infer<typeof CreateBookingResponse>

export const PublicBooking = z
  .object({
    id: z.uuid(),
    reference: z.string(),
    status: z.enum(BookingStatus),
    partySize: z.int().positive(),
    unitPriceBdt: z.int().nonnegative(),
    subtotalBdt: z.int().nonnegative(),
    discountBdt: z.int().nonnegative(),
    totalBdt: z.int().nonnegative(),
    couponCode: z.string().nullable(),
    couponLabel: z.string().nullable(),
    packageSlug: z.string(),
    packageTitle: z.string(),
    destinationLabel: z.string(),
    country: z.string(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    departureStatus: z.enum(DepartureStatus),
    contactName: z.string(),
    contactEmail: z.string(),
    contactPhone: z.string().nullable(),
    bookedAt: z.iso
      .datetime()
      .describe('When the booking was made — the date a traveller looks for on a receipt.'),
    confirmedAt: z.iso
      .datetime()
      .nullable()
      .describe('When the payment settled. Null while it is still awaiting payment.'),
    cancelledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'PublicBooking' })
export type PublicBooking = z.infer<typeof PublicBooking>

export const BookingListResponse = z
  .object({ bookings: z.array(PublicBooking) })
  .meta({ id: 'BookingListResponse' })
export type BookingListResponse = z.infer<typeof BookingListResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/** A `@db.Date` as the calendar date it is. Postgres returns it at UTC midnight. */
function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function toQuoteResponse(quote: DepartureQuote): QuoteResponse {
  return {
    departureId: quote.departureId,
    startDate: toIsoDate(quote.startDate),
    endDate: toIsoDate(quote.endDate),
    partySize: quote.partySize,
    unitPriceBdt: quote.unitPriceBdt,
    subtotalBdt: quote.subtotalBdt,
    discountBdt: quote.discountBdt,
    totalBdt: quote.totalBdt,
    seatsLeft: quote.seatsLeft,
    coupon:
      quote.coupon === null
        ? null
        : {
            code: quote.coupon.code,
            label: quote.coupon.label,
            discountBdt: quote.coupon.discountBdt,
          },
    couponRefusal:
      quote.couponRefusal === null
        ? null
        : { reason: quote.couponRefusal.reason, message: quote.couponRefusal.message },
  }
}

export function toPublicBooking(row: BookingRow): PublicBooking {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    partySize: row.partySize,
    unitPriceBdt: row.unitPriceBdt,
    subtotalBdt: row.subtotalBdt,
    discountBdt: row.discountBdt,
    totalBdt: row.totalBdt,
    couponCode: row.redemption?.coupon.code ?? null,
    couponLabel: row.redemption?.coupon.label ?? null,
    packageSlug: row.package.slug,
    packageTitle: row.package.title,
    destinationLabel: row.package.destinationLabel,
    country: row.package.country,
    startDate: toIsoDate(row.departure.startDate),
    endDate: toIsoDate(row.departure.endDate),
    departureStatus: row.departure.status,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    bookedAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  }
}
