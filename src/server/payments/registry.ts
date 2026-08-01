import { PaymentProvider as PaymentProviderCode } from '@/generated/prisma/enums'
import { internal } from '@/server/http/errors'
import { mockProvider } from './mock'
import type { PaymentProvider } from './provider'

/**
 * Which gateway is in charge.
 *
 * Two questions, deliberately separated, because they have different answers:
 *
 *   "Where should a NEW checkout go?"     → `activePaymentProvider()`
 *   "Who settles THIS existing payment?"  → `paymentProviderFor(payment.provider)`
 *
 * Collapsing them is the bug this file exists to prevent. A payment carries the
 * provider that created it, permanently, and must be settled by that same one —
 * a bKash payment does not become settleable by the sandbox merely because
 * somebody switched the active provider over. Route handlers therefore never ask
 * "what is active?" when settling. They ask the row.
 *
 * ADDING A REAL GATEWAY is a new file implementing `PaymentProvider`, one entry
 * in the map below, and one change to `ACTIVE_PROVIDER`. Nothing in
 * `service.ts`, `settlement.ts` or any route handler is touched, because none of
 * them names a provider — that is the property the interface was built for, and
 * this map is where it is cashed in.
 */

/**
 * Every implementation this build knows about.
 *
 * BKASH, SSLCOMMERZ and MANUAL_BANK are absent rather than stubbed. An entry
 * that throws "not implemented" looks like a working provider to every caller
 * and turns a missing integration into a runtime surprise; a missing entry
 * produces a refusal that names exactly what is missing.
 */
const PROVIDERS: ReadonlyMap<PaymentProviderCode, PaymentProvider> = new Map([
  [PaymentProviderCode.MOCK, mockProvider],
])

/**
 * The provider new checkouts are opened with.
 *
 * A constant today because there is exactly one implementation. With two it
 * becomes a settings lookup — `payments.activeProvider`, editable from the
 * console, so a gateway outage is a dropdown rather than a deploy — and
 * `activePaymentProvider()` is the only function that changes.
 *
 * Pointing this at MOCK is NOT what makes the sandbox safe. Safety is the two
 * flags checked inside the provider itself; this constant only decides which
 * door a checkout knocks on, and knocking on the sandbox's door in production
 * gets a 403.
 */
const ACTIVE_PROVIDER = PaymentProviderCode.MOCK

/**
 * The implementation behind one `PaymentProvider` enum value.
 *
 * Throws rather than returning null: every caller has a payment in hand and no
 * sensible fallback, so a null would only be asserted away at each call site. A
 * 500 is the correct classification — a payment row naming a provider this build
 * cannot service is our misconfiguration, not the caller's mistake.
 */
export function paymentProviderFor(code: PaymentProviderCode): PaymentProvider {
  const provider = PROVIDERS.get(code)

  if (provider === undefined) {
    throw internal(`No payment provider is configured for ${code}.`)
  }

  return provider
}

/** The provider a new checkout should be opened with. */
export function activePaymentProvider(): PaymentProvider {
  return paymentProviderFor(ACTIVE_PROVIDER)
}

/** Whether this build can service payments from a given provider at all. */
export function hasPaymentProvider(code: PaymentProviderCode): boolean {
  return PROVIDERS.has(code)
}
