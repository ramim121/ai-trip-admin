import { Prisma } from '@/generated/prisma/client'
import {
  BillingInterval,
  PaymentPurpose,
  PaymentStatus,
  PlanCode,
  SubscriptionStatus,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { conflict, internal, notFound } from '@/server/http/errors'
import { addMonths } from '@/server/modules/entitlements/service'
import { PAYMENT_SELECT, type PaymentRecord, type SettlementOutcome } from './provider'

/**
 * Turning a settled payment into an entitlement, atomically.
 *
 * Provider-agnostic on purpose, and this is where the interface in provider.ts
 * earns its keep: bKash's implementation will differ from the sandbox's only in
 * how it decides the outcome — a signed callback and a verification call rather
 * than a button press. What happens once the outcome is known is identical, so
 * it lives here and both call it. Swapping the gateway therefore cannot change
 * what a purchase grants, because the grant is not in the gateway.
 *
 * TWO PROPERTIES CARRY THE WHOLE FILE.
 *
 * IDEMPOTENCE. The status flip is a conditional `UPDATE` whose predicate is the
 * current status — the discipline `claimItineraryCreation` uses on the usage
 * counter, applied to a different row. Postgres evaluates that predicate under a
 * row lock against committed state, so of two concurrent settlements — a gateway
 * retrying its callback while the traveller double-clicks — precisely one
 * reports a row count of 1 and reaches the grant. The other counts zero, grants
 * nothing, and returns the row as it now stands. A caller cannot get this wrong
 * by forgetting to check first, because there is no check to forget: the
 * predicate IS the check.
 *
 * ATOMICITY. The flip and the grant are one transaction. Split them and every
 * failure mode is a support ticket — crash between the two and the traveller has
 * paid for nothing, or holds a grant with no payment behind it. Nothing here
 * commits a payment as SUCCEEDED without the entitlement it bought, and nothing
 * writes an entitlement a rollback would not take back with it.
 */

/**
 * The statuses a settlement may move a payment OUT of.
 *
 * INITIATED is the row as checkout created it; PENDING is a real gateway having
 * acknowledged the attempt. SUCCEEDED, FAILED and REFUNDED are terminal and are
 * absent from this list, which is the entire idempotence mechanism — a second
 * settlement matches no row.
 */
const SETTLEABLE_STATUSES = [PaymentStatus.INITIATED, PaymentStatus.PENDING] as const

/** Postgres unique violation, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002'

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION
}

/**
 * What the payment actually bought, as the traveller should be told.
 *
 * Read back from the grant rows rather than assembled from the settlement's own
 * local variables, so a replayed settlement — which grants nothing — still
 * describes the entitlement correctly. A double-submitted completion therefore
 * answers identically both times, which is what makes the endpoint safe to
 * retry.
 */
export interface EntitlementGrant {
  readonly kind: Extract<PaymentPurpose, 'ITINERARY_UNLOCK' | 'SUBSCRIPTION'>
  readonly itineraryId: string | null
  readonly itineraryTitle: string | null
  readonly planCode: PlanCode | null
  readonly planName: string | null
  /** When a subscription's period ends. Null for a one-off unlock, which never expires. */
  readonly activeUntil: Date | null
}

/** Everything the grant step needs, on top of what callers are allowed to see. */
const SETTLEMENT_SELECT = {
  ...PAYMENT_SELECT,
  itineraryId: true,
  planId: true,
} as const

/**
 * The final status each outcome maps to.
 *
 * FAILURE and CANCEL both land on FAILED, because `PaymentStatus` has no
 * CANCELLED member and inventing one is a schema change for a distinction the
 * ledger does not need — neither took money and neither granted anything. The
 * difference survives in `rawPayload`, where the funnel can read it, rather than
 * being flattened away entirely.
 */
function statusFor(outcome: SettlementOutcome): PaymentStatus {
  return outcome === 'SUCCESS' ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED
}

export interface SettleOptions {
  /** The gateway's own transaction id, once it has one. */
  readonly providerRef?: string | null
  /** Verbatim from the provider. Never read back to decide status or amount. */
  readonly rawPayload?: Prisma.InputJsonValue
  readonly now?: Date
}

/**
 * Move a payment to its final state and grant what it bought, in one transaction.
 *
 * Returns the row as it stands afterwards. A payment already in a terminal state
 * comes back unchanged and untouched — a success, not an error, because from the
 * caller's point of view the payment is settled either way, and the only thing a
 * 409 would achieve is teaching clients to ignore it.
 */
export async function settlePayment(
  paymentId: string,
  outcome: SettlementOutcome,
  options: SettleOptions = {}
): Promise<PaymentRecord> {
  const now = options.now ?? new Date()
  const nextStatus = statusFor(outcome)

  return db.$transaction(async (tx) => {
    /*
     * The claim. Everything else in this function is downstream of the row
     * count it returns.
     *
     * `updateMany` rather than `update`, because `update` addresses a row by id
     * alone and would cheerfully re-settle a SUCCEEDED payment; the status has
     * to be inside the WHERE clause for Postgres to arbitrate between two
     * concurrent callers. Zero rows affected is the honest answer "somebody
     * else got here first", and it is the only answer that makes granting twice
     * impossible rather than merely unlikely.
     */
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: [...SETTLEABLE_STATUSES] } },
      data: {
        status: nextStatus,
        // Set for failures too: this is when the attempt stopped being in
        // flight, which is what an operator staring at a stuck payment needs.
        // It is always read beside `status`, so it cannot be mistaken for
        // "when money arrived".
        settledAt: now,
        ...(options.providerRef !== undefined ? { providerRef: options.providerRef } : {}),
        ...(options.rawPayload !== undefined ? { rawPayload: options.rawPayload } : {}),
      },
    })

    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: SETTLEMENT_SELECT,
    })

    // Deleted between the caller's ownership check and this claim, or never
    // there at all. Either way there is nothing to settle.
    if (payment === null) throw notFound('That payment was not found.')

    // Already terminal. Grant nothing, change nothing, hand back what is there —
    // the replay case, and the whole reason the predicate above exists.
    if (claimed.count === 0) return toRecord(payment)

    if (outcome === 'SUCCESS') {
      await grant(tx, payment, now)
    }

    return toRecord(payment)
  })
}

/** Narrow the settlement projection back to what callers may see. */
function toRecord(row: {
  id: string
  userId: string | null
  provider: PaymentRecord['provider']
  purpose: PaymentPurpose
  amountBdt: number
  status: PaymentStatus
  providerRef: string | null
  isTest: boolean
  createdAt: Date
  settledAt: Date | null
}): PaymentRecord {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    purpose: row.purpose,
    amountBdt: row.amountBdt,
    status: row.status,
    providerRef: row.providerRef,
    isTest: row.isTest,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  }
}

type TransactionClient = Prisma.TransactionClient

interface SettlingPayment {
  id: string
  userId: string | null
  purpose: PaymentPurpose
  itineraryId: string | null
  planId: string | null
}

/**
 * Hand over what was bought.
 *
 * Dispatches on `purpose` — the column set at checkout — and never on the plan
 * behind the payment. That direction is the subject of the loudest comment in
 * this module, below.
 */
async function grant(tx: TransactionClient, payment: SettlingPayment, now: Date): Promise<void> {
  // A payment with no owner cannot grant anything: `userId` is nullable because
  // the financial record outlives a deleted account, and settling one of those
  // would mean writing an entitlement for nobody.
  if (payment.userId === null) {
    throw conflict('That payment is no longer attached to an account and cannot be settled.')
  }

  switch (payment.purpose) {
    case PaymentPurpose.ITINERARY_UNLOCK:
      return grantItineraryUnlock(tx, payment, payment.userId)

    case PaymentPurpose.SUBSCRIPTION:
      return grantSubscription(tx, payment, payment.userId, now)

    case PaymentPurpose.BOOKING:
      /*
       * Deliberately nothing. A booking is a trip ops fulfils against a quote;
       * there is no self-service entitlement to hand over, and no checkout in
       * this module creates one. Reachable only if somebody later routes a
       * BOOKING payment through here, and silence is then correct — the payment
       * is recorded and a human does the rest.
       */
      return
  }
}

/**
 * The 200 BDT one-off: the full length of ONE itinerary, forever.
 *
 * Note what is NOT here: any reference to the UNLOCK_SINGLE plan. That row
 * exists only so the price has somewhere to live, and turning it into a
 * Subscription is the most expensive mistake this file could make —
 * `unlockOffer()` publishes `planCode: 'UNLOCK_SINGLE'` to every client, so a
 * settlement doing the obvious thing with the offer it was handed would convert
 * one 200 BDT purchase into a permanent account-wide tier. The entitlement
 * service already excludes `interval = NONE` from every subscription lookup, and
 * `grantSubscription` below refuses such a plan outright; this function simply
 * never reaches for a plan at all, which is the cheapest of the three locks and
 * the only one that cannot be forgotten.
 */
async function grantItineraryUnlock(
  tx: TransactionClient,
  payment: SettlingPayment,
  userId: string
): Promise<void> {
  const itineraryId = payment.itineraryId

  // The column is nullable for BOOKING's sake. An ITINERARY_UNLOCK without one
  // is a checkout bug, and taking money for a grant we cannot deliver is worse
  // than failing the settlement and leaving the payment un-settled for ops.
  if (itineraryId === null) {
    throw internal('That payment does not name an itinerary to unlock.')
  }

  try {
    await tx.itineraryUnlock.create({
      data: { userId, itineraryId, paymentId: payment.id },
    })
  } catch (e) {
    /*
     * `@@unique([userId, itineraryId])` — they already own this trip.
     *
     * Reachable when two DIFFERENT payments for the same itinerary settle
     * together; the status predicate upstream only serialises settlements of one
     * payment. Checkout refuses to open a second unlock for an itinerary already
     * unlocked, so this is the narrow race rather than the common path.
     *
     * Swallowed rather than propagated: the traveller has the entitlement they
     * paid for, which is the outcome that matters, and rolling back would leave
     * a paid-for grant undelivered. The duplicate shows up to ops as a SUCCEEDED
     * payment with no unlock attached — a refund conversation, not a 500 in the
     * middle of a checkout.
     */
    if (!isUniqueViolation(e)) throw e
  }

  /*
   * Refresh the denormalised flag the list views read.
   *
   * `ItineraryUnlock` remains the record of truth — `isItineraryUnlocked()`
   * reads the row and never this column — so this is a cache being brought into
   * line inside the same transaction that created the thing it caches. Scoped on
   * `userId` as well as id, so a payment can only ever mark the buyer's own
   * itinerary.
   */
  await tx.itinerary.updateMany({
    where: { id: itineraryId, userId },
    data: { isFullyUnlocked: true },
  })
}

/**
 * A monthly tier, active from now until one month from now.
 *
 * The interval check is the second lock on the door described above, and it is
 * here rather than only at checkout because this function is what a future bKash
 * callback will call. A settlement path that trusted checkout to have validated
 * is a path that stops being validated the moment somebody adds a second way to
 * create a payment.
 */
async function grantSubscription(
  tx: TransactionClient,
  payment: SettlingPayment,
  userId: string,
  now: Date
): Promise<void> {
  if (payment.planId === null) {
    throw internal('That payment does not name a plan to subscribe to.')
  }

  const plan = await tx.plan.findUnique({
    where: { id: payment.planId },
    select: { id: true, code: true, interval: true },
  })

  if (plan === null) throw internal('The plan behind that payment no longer exists.')

  if (plan.interval === BillingInterval.NONE) {
    throw conflict(
      `${plan.code} is a one-off purchase, not a subscription tier, and cannot be granted as one.`
    )
  }

  await tx.subscription.create({
    data: {
      userId,
      planId: plan.id,
      status: SubscriptionStatus.ACTIVE,
      startedAt: now,
      // Clamping month arithmetic shared with `resolvePeriod`, so the boundary
      // set here is the one the meter later steps back from.
      currentPeriodEnd: addMonths(now, 1),
      paymentId: payment.id,
    },
  })
}

/**
 * What a settled payment granted, read back from the grant rows.
 *
 * Separate from `settlePayment` so the answer is the same whether this call did
 * the settling or merely observed one that had already happened. That is what
 * makes a double-submitted completion return an identical body instead of a
 * first response with a grant and a second without one.
 */
export async function describeGrant(paymentId: string): Promise<EntitlementGrant | null> {
  const [unlock, subscription] = await Promise.all([
    db.itineraryUnlock.findUnique({
      where: { paymentId },
      select: { itineraryId: true, itinerary: { select: { title: true } } },
    }),
    db.subscription.findUnique({
      where: { paymentId },
      select: {
        currentPeriodEnd: true,
        plan: { select: { code: true, name: true } },
      },
    }),
  ])

  if (unlock !== null) {
    return {
      kind: PaymentPurpose.ITINERARY_UNLOCK,
      itineraryId: unlock.itineraryId,
      itineraryTitle: unlock.itinerary.title,
      planCode: null,
      planName: null,
      activeUntil: null,
    }
  }

  if (subscription !== null) {
    return {
      kind: PaymentPurpose.SUBSCRIPTION,
      itineraryId: null,
      itineraryTitle: null,
      planCode: subscription.plan.code,
      planName: subscription.plan.name,
      activeUntil: subscription.currentPeriodEnd,
    }
  }

  return null
}
