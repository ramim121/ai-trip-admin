import { randomBytes, randomUUID } from 'node:crypto'
import { PaymentProvider as PaymentProviderCode, PaymentStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { forbidden, notFound } from '@/server/http/errors'
import {
  type InitiatedPayment,
  type PaymentIntent,
  type PaymentProvider,
  type PaymentRecord,
  type SettlementOutcome,
} from './provider'
import { settlePayment } from './settlement'

/**
 * The sandbox gateway.
 *
 * It exists so the purchase flows can be exercised end to end — checkout,
 * redirect, settle, entitlement, receipt — before anyone has a bKash merchant
 * account. It is genuinely useful precisely because it is not a stub: it writes
 * a real Payment row, runs the real settlement transaction, and grants a real
 * ItineraryUnlock or Subscription. Everything downstream of the gateway is the
 * code that will run in production. Only the gateway is pretend.
 *
 * WHICH IS EXACTLY WHY THE TOP OF THIS FILE IS A REFUSAL.
 *
 * A provider that grants paid entitlements on a button press is the paywall with
 * the lock taken off. Reaching production switched on, it is not a broken test
 * tool — it is free Premium for anyone who can read a URL, and the damage is
 * silent: the payments table fills with SUCCEEDED rows and the revenue number
 * simply never arrives.
 *
 * So there are two flags, and they are not redundant:
 *
 *   PAYMENTS_MOCK_ENABLED             — is the sandbox usable at all?
 *   PAYMENTS_ALLOW_MOCK_IN_PRODUCTION — may it run under NODE_ENV=production?
 *
 * One flag is one accident away from disaster. Environment configuration gets
 * copied between deployments wholesale — a staging `.env` becomes a production
 * template, a dashboard receives a paste of the wrong block — and a single
 * variable survives that journey intact. Two variables mean the accident has to
 * happen twice, to two differently-named keys, one of which says PRODUCTION out
 * loud. `PAYMENTS_MOCK_ENABLED` also defaults to false outside development, so
 * the lazy path is the safe one.
 *
 * Both are evaluated in exactly one function, below. Every entry point that
 * could grant anything calls it first, and nothing else in the codebase reads
 * either flag — a second copy of this rule would be a second chance to get it
 * subtly wrong.
 */

/** Named in the refusal messages, and exported so tests assert on the real strings. */
export const MOCK_ENABLED_FLAG = 'PAYMENTS_MOCK_ENABLED'
export const MOCK_PRODUCTION_FLAG = 'PAYMENTS_ALLOW_MOCK_IN_PRODUCTION'

/**
 * Refuse unless the sandbox is permitted here, right now.
 *
 * 403 rather than 404 or 500, and both messages name both flags: the audience is
 * an operator or developer who has just found the sandbox switched off and needs
 * to know precisely which two variables govern it. There is nothing to hide —
 * the existence of a test gateway is not a secret, and a vague refusal would
 * only be answered by somebody guessing at configuration until something worked.
 *
 * Called by `initiate` and `settle`: the two operations that create a payment or
 * hand over an entitlement. Deliberately NOT called by `verify`, which only
 * reads. A payment created while the sandbox was on stays inspectable after it
 * is switched off, because refusing to say what became of somebody's payment
 * helps nobody and hides nothing.
 */
export function assertMockPaymentsPermitted(): void {
  const config = env()

  if (!config.PAYMENTS_MOCK_ENABLED) {
    throw forbidden(
      'The sandbox payment gateway is switched off. Set ' +
        `${MOCK_ENABLED_FLAG}=true to enable it; under NODE_ENV=production it additionally ` +
        `requires ${MOCK_PRODUCTION_FLAG}=true.`
    )
  }

  if (config.NODE_ENV === 'production' && !config.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION) {
    throw forbidden(
      'The sandbox payment gateway refuses to run in production. It grants real entitlements ' +
        `without taking real money, so it requires BOTH ${MOCK_ENABLED_FLAG}=true and ` +
        `${MOCK_PRODUCTION_FLAG}=true — and the second is not set. To take a real payment, ` +
        'configure a real provider instead.'
    )
  }
}

/**
 * Whether the sandbox may be used, without throwing.
 *
 * For the places that need to *describe* availability rather than enforce it — a
 * health check, a console badge. Enforcement always goes through
 * `assertMockPaymentsPermitted`, so this cannot become a second, divergent copy
 * of the rule: it is the same function with the exception caught.
 */
export function mockPaymentsPermitted(): boolean {
  try {
    assertMockPaymentsPermitted()
    return true
  } catch {
    return false
  }
}

/**
 * A reference that could not be mistaken for a real transaction id.
 *
 * bKash trxIDs are short alphanumerics and SSLCommerz val_ids are numeric; this
 * is neither, and it says `mock_test` in front. Somebody reconciling a bank
 * statement against this table should see at a glance that the row is not money,
 * without having to know that `isTest` exists.
 */
function mockProviderRef(): string {
  return `mock_test_${randomBytes(8).toString('hex')}`
}

class MockPaymentProvider implements PaymentProvider {
  readonly code = PaymentProviderCode.MOCK

  /**
   * Hard-coded, and this is why `isTest` is a property of the PROVIDER rather
   * than a parameter of `initiate`. There is no argument any caller can pass
   * that would write `isTest: false` onto a row this class created.
   */
  readonly isTest = true

  /**
   * Create the payment and hand back the simulated gateway's address.
   *
   * The intent arrives fully resolved — `service.ts` has already read the price
   * from the database — so nothing here computes, adjusts or second-guesses an
   * amount. A gateway's job is to collect the number it was given.
   */
  async initiate(intent: PaymentIntent): Promise<InitiatedPayment> {
    assertMockPaymentsPermitted()

    const payment = await db.payment.create({
      data: {
        userId: intent.userId,
        provider: this.code,
        purpose: intent.purpose,
        amountBdt: intent.amountBdt,
        status: PaymentStatus.INITIATED,
        isTest: this.isTest,
        idempotencyKey: intent.idempotencyKey,
        itineraryId: intent.itineraryId,
        planId: intent.planId,
      },
      select: { id: true },
    })

    return {
      paymentId: payment.id,
      // The PUBLIC origin, not this one. The person paying is in a browser on
      // the website; the admin service is not somewhere a traveller ever goes.
      redirectUrl: `${env().PUBLIC_WEB_ORIGIN}/checkout/${payment.id}`,
    }
  }

  /**
   * Settle on a button press.
   *
   * The interesting thing here is how little happens. Deciding the outcome is
   * the gateway's job and it is one argument; everything that matters — the
   * conditional status flip, the entitlement, the transaction around both — is
   * `settlePayment`, which bKash will call with exactly these arguments once it
   * has verified a callback signature instead of reading a button. That is the
   * whole claim of the provider interface, and this method is the evidence for
   * it.
   */
  async settle(paymentId: string, outcome: SettlementOutcome): Promise<PaymentRecord> {
    assertMockPaymentsPermitted()

    const now = new Date()

    return settlePayment(paymentId, outcome, {
      providerRef: mockProviderRef(),
      // Stands in for the verbatim callback body a real gateway would send.
      // `outcome` is recorded because FAILURE and CANCEL both map to the FAILED
      // status, and the difference is worth keeping for the funnel.
      rawPayload: {
        simulated: true,
        provider: this.code,
        outcome,
        settledAt: now.toISOString(),
      },
      now,
    })
  }

  /**
   * What this provider believes the status is.
   *
   * For the sandbox that is simply the row, because the sandbox has no state
   * anywhere else — there is no remote ledger to disagree with us. A real
   * implementation calls the gateway and compares, which is the point of having
   * the method at all: a callback body is something an attacker can post, and a
   * verification call is not.
   */
  async verify(paymentId: string): Promise<PaymentStatus> {
    const payment = await db.payment.findUnique({
      where: { id: paymentId },
      select: { status: true, provider: true },
    })

    if (payment === null || payment.provider !== this.code) {
      throw notFound('That payment was not found.')
    }

    return payment.status
  }
}

/**
 * The single instance.
 *
 * Stateless, so one is enough — and a module-level constant means the registry
 * holds a reference rather than constructing a provider per request.
 */
export const mockProvider: PaymentProvider = new MockPaymentProvider()

/**
 * A fresh idempotency key for a sandbox checkout.
 *
 * Random per checkout rather than derived from the purchase, and the distinction
 * is worth stating because the column's name invites the other reading. What
 * `Payment.idempotencyKey` protects against is a REPLAYED SETTLEMENT — a gateway
 * firing its callback twice — not a traveller opening checkout twice. Deriving
 * the key from (user, itinerary) would collapse the second case into the first
 * and make a retry after a genuine decline impossible, because the FAILED row
 * would own the key forever.
 */
export function mockIdempotencyKey(): string {
  return `mock_${randomUUID()}`
}
