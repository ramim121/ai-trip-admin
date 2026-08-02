import {
  BillingInterval,
  BookingStatus,
  PaymentProvider as PaymentProviderCode,
  PaymentPurpose,
  PaymentStatus,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit/log'
import { badRequest, conflict, notFound } from '@/server/http/errors'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { mockIdempotencyKey } from './mock'
import type { PaymentIntent, SettlementOutcome } from './provider'
import { activePaymentProvider, paymentProviderFor } from './registry'
import {
  PAYMENT_DETAIL_SELECT,
  toPaymentDetail,
  toPaymentGrant,
  type CheckoutBody,
  type CheckoutResponse,
  type PaymentCompletionResponse,
  type PaymentDetail,
  type PaymentListQuery,
  type PaymentListResponse,
} from './schema'
import { describeGrant } from './settlement'

/**
 * What a purchase costs, who may buy it, and who may settle it.
 *
 * The gateway layer beside this file knows how to take a payment. This file
 * knows what we sell — and every rule in it exists because the alternative is a
 * client deciding one of those things for itself.
 *
 * THE PRICE IS READ, NEVER RECEIVED. `resolveIntent` below is the only thing in
 * the codebase that puts a number into `Payment.amountBdt`, and it takes that
 * number from the Plan row or the unlock-price setting on every single call.
 * `CheckoutBody` has no amount field, a plain `z.object()` strips one if a
 * client sends it anyway, and nothing between here and the database would accept
 * it if it survived. Three layers, because "the client sends the price" is the
 * oldest mistake in commerce software and it is only ever discovered afterwards.
 *
 * OWNERSHIP IS PART OF THE QUERY — not a check performed on a row after fetching
 * it. `userId` is in the WHERE clause, so there is no code path that loads
 * somebody else's payment at all. Another traveller's payment answers 404, the
 * same as one that never existed, which is the convention the itinerary routes
 * already follow: a 403 would confirm that a guessed id is real.
 */

/**
 * How many checkouts one account may open in an hour.
 *
 * Not a fraud control — the sandbox takes no money and a real gateway does its
 * own — but a bound on row creation. Every checkout writes a `payments` row that
 * nothing later deletes, so an unbounded endpoint is an unbounded table. Twenty
 * an hour is far more than a person buying a trip will need, and far less than a
 * script would like.
 */
const CHECKOUT_RATE_LIMIT = { limit: 20, windowSeconds: 3_600 } as const

/** Statuses from which nothing further happens without a refund. */
const TERMINAL_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.FAILED,
  PaymentStatus.REFUNDED,
]

function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** Where a request came from, for the audit trail. Resolved by the route via `clientContext`. */
export interface RequestContext {
  readonly ip: string | null
  readonly userAgent: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide what this purchase actually is, and what it costs.
 *
 * Every branch ends by reading a price out of the database. Note that none of
 * them consults the request for anything but *which* thing is being bought: the
 * body names a target, and the server names the number.
 */
async function resolveIntent(userId: string, body: CheckoutBody): Promise<PaymentIntent> {
  const idempotencyKey = mockIdempotencyKey()

  if (body.purpose === PaymentPurpose.BOOKING) {
    const bookingId = body.bookingId
    if (bookingId === undefined) {
      throw badRequest('bookingId is required when purpose is BOOKING.', [
        { path: 'bookingId', message: 'Required for a booking.' },
      ])
    }

    /*
     * Ownership and state, both in the WHERE clause.
     *
     * `userId` for the same reason the itinerary branch has it — somebody
     * else's booking is indistinguishable from one that does not exist.
     * `status` because a booking that is already CONFIRMED has been paid for,
     * and opening a second checkout against it is how one party pays twice for
     * the same seats. A cancelled booking has released its seats and must not
     * be resurrected by a payment either.
     */
    const booking = await db.packageBooking.findFirst({
      where: { id: bookingId, userId, status: BookingStatus.PENDING_PAYMENT },
      select: { id: true, totalBdt: true },
    })

    if (booking === null) {
      throw notFound('That booking was not found, or is no longer awaiting payment.')
    }

    return {
      userId,
      purpose: PaymentPurpose.BOOKING,
      /*
       * The booking's own stored total.
       *
       * Not recomputed from the departure's price and the coupon's terms, which
       * is the whole reason those figures were snapshot when the booking was
       * created: a repricing between booking and payment must not change what
       * somebody agreed to. The database enforces that this number equals
       * subtotal minus discount, so it cannot have drifted from its own parts.
       */
      amountBdt: booking.totalBdt,
      itineraryId: null,
      planId: null,
      bookingId: booking.id,
      idempotencyKey,
    }
  }

  const planCode = body.planCode
  if (planCode === undefined) {
    throw badRequest('planCode is required when purpose is SUBSCRIPTION.', [
      { path: 'planCode', message: 'Required for a subscription.' },
    ])
  }

  const plan = await db.plan.findUnique({
    where: { code: planCode },
    select: { id: true, code: true, priceBdt: true, interval: true, isActive: true },
  })

  // A retired plan still exists — payments and subscriptions reference it — but
  // it is not on sale, and 404 says so without distinguishing it from a code we
  // have never issued.
  if (plan === null || !plan.isActive) {
    throw notFound('No such plan is on sale.')
  }

  /*
   * THE REJECTION THIS ENDPOINT EXISTS TO MAKE.
   *
   * `interval = NONE` means a one-off purchase rather than a tier: FREE and
   * UNLOCK_SINGLE both carry it. A SUBSCRIPTION checkout naming UNLOCK_SINGLE
   * would settle into a Subscription row whose plan the entitlement resolver
   * ranks by `sortOrder` — and 200 BDT would buy an account-wide grant instead
   * of one itinerary.
   *
   * This is the FIRST of three locks. `grantSubscription` refuses the same plan
   * at settlement, and `LIVE_SUBSCRIPTION` in the entitlement service excludes
   * `interval = NONE` from every subscription lookup, so even a row written by
   * some future path would grant nothing. Refusing here as well is what turns
   * that from a silent no-op into an error somebody can read.
   */
  if (plan.interval === BillingInterval.NONE) {
    throw badRequest(
      `${plan.code} is a one-off purchase, not a monthly plan, and cannot be subscribed to. ` +
        'Buy it against a specific itinerary with purpose ITINERARY_UNLOCK instead.',
      [{ path: 'planCode', message: 'This plan has no billing interval.' }]
    )
  }

  return {
    userId,
    purpose: PaymentPurpose.SUBSCRIPTION,
    // The Plan row's own column. Not a figure from the request, and not a
    // constant in this file that would go stale the day ops repriced a tier.
    amountBdt: plan.priceBdt,
    itineraryId: null,
    planId: plan.id,
    bookingId: null,
    idempotencyKey,
  }
}

/**
 * Open a checkout and hand back somewhere to pay.
 *
 * Note the shape of the last three steps: resolve the intent, hand it to
 * whichever provider is active, return what that provider said. The sandbox is
 * not mentioned anywhere in this function. Swapping in bKash changes
 * `activePaymentProvider()` and nothing here — which is the claim the interface
 * was built to make good on.
 */
export async function openCheckout(
  userId: string,
  body: CheckoutBody,
  context: RequestContext
): Promise<CheckoutResponse> {
  await enforceRateLimit(
    { key: `payments:checkout:user:${userId}`, ...CHECKOUT_RATE_LIMIT },
    'Too many checkouts started. Finish or abandon the one in progress, then try again.'
  )

  const intent = await resolveIntent(userId, body)
  const provider = activePaymentProvider()

  const initiated = await provider.initiate(intent)

  await recordAudit({
    action: 'payment.checkout_opened',
    entityType: 'payment',
    entityId: initiated.paymentId,
    userId,
    after: {
      provider: provider.code,
      purpose: intent.purpose,
      amountBdt: intent.amountBdt,
      isTest: provider.isTest,
      itineraryId: intent.itineraryId,
      planId: intent.planId,
      bookingId: intent.bookingId,
    },
    ip: context.ip,
    userAgent: context.userAgent,
  })

  return {
    paymentId: initiated.paymentId,
    purpose: intent.purpose,
    amountBdt: intent.amountBdt,
    provider: provider.code,
    isTest: provider.isTest,
    redirectUrl: initiated.redirectUrl,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settle a sandbox payment on the traveller's own instruction.
 *
 * THE LOOKUP IS THE SECURITY. Three conditions in one WHERE clause:
 *
 *   `id`              — the payment being settled
 *   `userId`          — it is theirs; anyone else's answers 404
 *   `provider: MOCK`  — it was created by the sandbox
 *
 * The third is not decoration. Without it, this endpoint would settle a REAL
 * bKash payment on a button press: a traveller opens a genuine checkout, never
 * pays, POSTs here, and is granted the entitlement. Putting it in the query
 * rather than in a branch afterwards means there is no version of this function
 * that forgets it.
 *
 * All three failures answer 404 together, deliberately. "Not yours" and "not a
 * sandbox payment" are both things the caller has no business distinguishing.
 */
export async function completeMockPayment(
  userId: string,
  paymentId: string,
  outcome: SettlementOutcome,
  context: RequestContext
): Promise<PaymentCompletionResponse> {
  const existing = await db.payment.findFirst({
    where: { id: paymentId, userId, provider: PaymentProviderCode.MOCK },
    select: { id: true, status: true },
  })

  if (existing === null) throw notFound('That payment was not found.')

  // Read before the settlement, because afterwards there is no way to tell a
  // first completion from a replay — and that distinction is the most useful
  // thing this audit row carries.
  const wasAlreadySettled = isTerminal(existing.status)

  const provider = paymentProviderFor(PaymentProviderCode.MOCK)
  const settled = await provider.settle(paymentId, outcome)

  await recordAudit({
    action: 'payment.mock_settled',
    entityType: 'payment',
    entityId: paymentId,
    userId,
    before: { status: existing.status },
    after: {
      status: settled.status,
      outcome,
      // True means this call changed nothing: the payment was already terminal
      // and the entitlement was granted by an earlier one. A run of these is how
      // a double-submitting client shows up in the audit trail instead of in the
      // revenue numbers.
      alreadySettled: wasAlreadySettled,
      isTest: settled.isTest,
      amountBdt: settled.amountBdt,
      purpose: settled.purpose,
    },
    ip: context.ip,
    userAgent: context.userAgent,
  })

  // Re-read for the relations the response carries, and take the grant from the
  // entitlement rather than from the settlement — so a replay answers exactly
  // what the first call answered.
  const [detail, grant] = await Promise.all([
    readPayment(userId, paymentId),
    describeGrant(paymentId),
  ])

  return { payment: detail, grant: grant === null ? null : toPaymentGrant(grant) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One payment, for polling.
 *
 * A non-terminal payment has its status confirmed with the provider before it is
 * reported. For the sandbox that is a read of the same row and cannot disagree;
 * for a real gateway it is the difference between reporting what we last heard
 * and reporting what is true — a callback can be lost, and a traveller staring
 * at "pending" for a payment that cleared ten minutes ago is how a support queue
 * fills up. Terminal statuses are trusted as they stand: nothing further happens
 * to a SUCCEEDED payment without a refund, which is its own operation.
 */
export async function readPayment(userId: string, paymentId: string): Promise<PaymentDetail> {
  const row = await db.payment.findFirst({
    where: { id: paymentId, userId },
    select: PAYMENT_DETAIL_SELECT,
  })

  if (row === null) throw notFound('That payment was not found.')

  const detail = toPaymentDetail(row)

  if (isTerminal(row.status)) return detail

  const provider = paymentProviderFor(row.provider)
  return { ...detail, status: await provider.verify(paymentId) }
}

/** Default page size for payment history. Small — this is a receipts list, not a ledger. */
const DEFAULT_PAGE_SIZE = 20

/**
 * The caller's own payments, newest first.
 *
 * There is no parameter for whose payments to list. The user id comes from the
 * token and goes straight into the WHERE clause, so there is nothing here to
 * tamper with — the arrangement `GET /api/v1/itineraries` already uses.
 *
 * Test payments are NOT filtered out. This is the traveller's own history, and
 * hiding a row that granted them an entitlement would make their own account
 * inexplicable to them; `isTest` on each row says what it is. The filtering that
 * matters is in the admin console and in revenue reporting, where the question
 * being asked is about money rather than about what somebody owns.
 */
export async function listPayments(
  userId: string,
  query: PaymentListQuery
): Promise<PaymentListResponse> {
  const take = query.limit ?? DEFAULT_PAGE_SIZE
  const skip = query.offset ?? 0

  const [rows, total] = await Promise.all([
    db.payment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      select: PAYMENT_DETAIL_SELECT,
    }),
    db.payment.count({ where: { userId } }),
  ])

  return { payments: rows.map(toPaymentDetail), total }
}
