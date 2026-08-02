import type {
  PaymentProvider as PaymentProviderCode,
  PaymentPurpose,
  PaymentStatus,
} from '@/generated/prisma/enums'

/**
 * The seam a payment gateway plugs into.
 *
 * The point of this file is what it does NOT contain. There is no price in it,
 * no entitlement, no plan, and no rule about what a purchase grants. Those live
 * in `service.ts` and `settlement.ts`, which know nothing about any particular
 * gateway. A provider is only ever asked three things — start a payment, settle
 * one, say what it believes the status of one is — so adding bKash later is a
 * new file implementing this interface plus one line in `registry.ts`. No
 * business logic moves, which is the whole reason the interface exists before
 * there is a second implementation to justify it.
 *
 * The three methods are deliberately asymmetric in what they trust:
 *
 *   `initiate` is handed an intent the SERVER built. Every field in it —
 *   `amountBdt` above all — was resolved from the database, never from a
 *   request body. A provider may not change the amount; it may only take the
 *   traveller somewhere to pay it.
 *
 *   `settle` is the only method that may move a payment out of INITIATED, and
 *   the one that must be idempotent. Real gateways retry callbacks, people
 *   double-click, networks duplicate. `settlePayment()` in settlement.ts holds
 *   the conditional-update discipline every implementation is expected to reuse
 *   rather than reinvent.
 *
 *   `verify` asks the provider what IT believes, which for a real gateway means
 *   calling out to it. It exists so a settlement can be confirmed against the
 *   source rather than against a callback body somebody could have forged.
 */

/**
 * What may actually be bought through a checkout.
 *
 * A narrowing of the database's `PaymentPurpose`. It used to exclude `BOOKING`,
 * on the grounds that a booking was a large trip settled by bank transfer
 * against a quote and never through self-service.
 *
 * That remains true of a quote-driven booking. It is no longer true of a seat
 * on a dated group departure, which has a price the server can read, a party
 * size, and a total already written to a `PackageBooking` row — so BOOKING is
 * now a checkout purpose, pointing at that row through `bookingId`.
 *
 * The narrowing itself still matters: a purpose absent from this union has no
 * code path to a provider at all, which is a stronger guarantee than a check.
 */
export type CheckoutPurpose = Extract<
  PaymentPurpose,
  'ITINERARY_UNLOCK' | 'SUBSCRIPTION' | 'BOOKING'
>

/**
 * A payment the server has decided to take, before any gateway has seen it.
 *
 * Every field is server-resolved. `amountBdt` is read from the Plan row or the
 * unlock-price setting inside `service.ts`; there is no route by which a
 * client-supplied figure can reach this type, and that is the single most
 * important property of this module.
 */
export interface PaymentIntent {
  readonly userId: string
  readonly purpose: CheckoutPurpose
  /** Whole Bangladeshi taka, resolved server-side. Never a float, never a caller's number. */
  readonly amountBdt: number
  /** The itinerary being unlocked. Set iff `purpose` is ITINERARY_UNLOCK. */
  readonly itineraryId: string | null
  /**
   * The plan being subscribed to, by id. Set iff `purpose` is SUBSCRIPTION.
   *
   * The id rather than the `PlanCode`, because this is written straight into a
   * foreign key and a provider must not have to resolve one to the other — that
   * would be a database lookup inside a gateway, which is precisely the sort of
   * business logic the interface exists to keep out. The service has already
   * loaded the row to read its price; it passes on what it found.
   */
  readonly planId: string | null
  /**
   * The booking being paid for. Set iff `purpose` is BOOKING.
   *
   * The row already exists by the time an intent is built, and it already holds
   * its seats and its agreed total. This id is how the settlement knows which
   * booking to confirm — the same argument as `itineraryId`: a gateway callback
   * arrives carrying our reference and nothing about our domain, so the target
   * has to be on the payment.
   */
  readonly bookingId: string | null
  /**
   * Unique across every provider. The column it lands in is what stops a
   * replayed gateway callback granting twice.
   */
  readonly idempotencyKey: string
}

/** What a client needs to continue: an id to poll, and somewhere to send the browser. */
export interface InitiatedPayment {
  readonly paymentId: string
  /**
   * Where to send the traveller to pay.
   *
   * Absolute, and pointing at the PUBLIC web origin rather than at this API —
   * the person paying is in a browser on the website, not talking to the admin
   * service. For a real gateway this is the URL that gateway hands back; for the
   * sandbox it is our own simulated checkout page.
   */
  readonly redirectUrl: string
}

/**
 * What the traveller did at the gateway.
 *
 * FAILURE and CANCEL are kept apart even though both end in no entitlement.
 * They mean different things to everyone downstream: a decline is a payment
 * problem worth retrying with another method, an abandonment is a pricing or
 * intent problem, and a funnel that cannot tell them apart cannot be read.
 */
export type SettlementOutcome = 'SUCCESS' | 'FAILURE' | 'CANCEL'

/**
 * A payment as anything outside this module may see it.
 *
 * Two columns are deliberately absent, and their absence is enforced by this
 * type rather than by everyone remembering: `rawPayload` is a verbatim gateway
 * body, and `idempotencyKey` is the value that stops a replay granting twice.
 * Neither belongs in a response, a log line, or a rendered page.
 */
export interface PaymentRecord {
  readonly id: string
  readonly userId: string | null
  readonly provider: PaymentProviderCode
  readonly purpose: PaymentPurpose
  readonly amountBdt: number
  readonly status: PaymentStatus
  readonly providerRef: string | null
  readonly isTest: boolean
  readonly createdAt: Date
  readonly settledAt: Date | null
}

/**
 * The Prisma projection behind `PaymentRecord`.
 *
 * A select rather than an omit, so a column added to the model later is
 * invisible here until somebody decides it should be published.
 */
export const PAYMENT_SELECT = {
  id: true,
  userId: true,
  provider: true,
  purpose: true,
  amountBdt: true,
  status: true,
  providerRef: true,
  isTest: true,
  createdAt: true,
  settledAt: true,
} as const

export interface PaymentProvider {
  /** Which `PaymentProvider` enum value this implementation stamps on its rows. */
  readonly code: PaymentProviderCode

  /**
   * True when this provider moves no real money.
   *
   * Copied straight onto `Payment.isTest`, so the flag on the row is a property
   * of the gateway that wrote it rather than an argument a caller passes and can
   * forget. A real gateway declares this false and there is no parameter
   * anywhere that could make it true.
   */
  readonly isTest: boolean

  /** Create the Payment row and return somewhere to send the traveller. */
  initiate(intent: PaymentIntent): Promise<InitiatedPayment>

  /**
   * Move a payment to its final state, granting the entitlement if it succeeded.
   *
   * MUST be idempotent: settling an already-SUCCEEDED payment returns the row
   * unchanged and grants nothing further.
   */
  settle(paymentId: string, outcome: SettlementOutcome): Promise<PaymentRecord>

  /** The provider's own view of a payment's status. */
  verify(paymentId: string): Promise<PaymentStatus>
}
