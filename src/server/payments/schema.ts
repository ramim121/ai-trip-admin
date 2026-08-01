import { z } from 'zod'
import {
  PaymentProvider as PaymentProviderCode,
  PaymentPurpose,
  PaymentStatus,
  PlanCode,
} from '@/generated/prisma/enums'
import type { CheckoutPurpose, SettlementOutcome } from './provider'
import type { EntitlementGrant } from './settlement'

/**
 * The wire contract for checkout, settlement and payment history.
 *
 * Same rule as every other schema module here: each shape is named and exported
 * so the OpenAPI generator emits it as a component rather than inlining an
 * anonymous object, and the response schemas ARE the definition of what leaves
 * the process. A field absent here is a field no client can come to depend on.
 *
 * WHAT IS DELIBERATELY NOT IN `CheckoutBody`: an amount. Not as an optional
 * field, not as a "quoted price" a client echoes back for us to confirm, not as
 * a currency. The server reads the price from the Plan row or the unlock setting
 * on every call. A body carrying a number that the server then validates is
 * still a body whose number matters, and the only way to be certain a client's
 * figure never reaches a Payment row is for there to be nowhere to put it.
 *
 * The stripping is what enforces that. These are plain `z.object()`s, so zod
 * drops unknown keys silently — a request carrying `amountBdt: 1` parses fine
 * and the field ceases to exist before any handler sees it. Deliberately NOT
 * `.strict()`: refusing such a request with a 400 would be the worse contract,
 * because it teaches a client that the field is meaningful-but-forbidden rather
 * than meaningless.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Annotated with the provider layer's own union so the two cannot drift.
 *
 * `BOOKING` is a real `PaymentPurpose` and is absent here on purpose: it is
 * settled by bank transfer against a quote, and there is no self-service
 * checkout for it. Add it to `CheckoutPurpose` without adding it here and this
 * line stops compiling.
 */
export const CheckoutPurposeSchema: z.ZodType<CheckoutPurpose> = z
  .enum([PaymentPurpose.ITINERARY_UNLOCK, PaymentPurpose.SUBSCRIPTION])
  .meta({
    id: 'CheckoutPurpose',
    description:
      'What is being bought. `ITINERARY_UNLOCK` is the one-off that opens a single trip in full, ' +
      'forever; `SUBSCRIPTION` is a monthly tier. They are not interchangeable — see `planCode`.',
  })

export const CheckoutBody = z
  .object({
    purpose: CheckoutPurposeSchema,
    itineraryId: z
      .uuid()
      .optional()
      .describe(
        'Required for ITINERARY_UNLOCK, and must name an itinerary you own. Ignored otherwise.'
      ),
    planCode: z
      .enum(PlanCode)
      .optional()
      .describe(
        'Required for SUBSCRIPTION. Must name a plan on sale whose interval is MONTHLY: ' +
          'UNLOCK_SINGLE is a price, not a tier, and is refused here.'
      ),
  })
  /*
   * Which field is required depends on the purpose, which no per-field rule can
   * express. Checked here rather than in the handler so a refusal arrives as an
   * ordinary VALIDATION_FAILED with `details[].path` naming the field a form can
   * highlight, instead of as prose in a message.
   */
  .superRefine((body, ctx) => {
    if (body.purpose === PaymentPurpose.ITINERARY_UNLOCK && body.itineraryId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['itineraryId'],
        message: 'itineraryId is required when purpose is ITINERARY_UNLOCK.',
      })
    }

    if (body.purpose === PaymentPurpose.SUBSCRIPTION && body.planCode === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['planCode'],
        message: 'planCode is required when purpose is SUBSCRIPTION.',
      })
    }
  })
  .meta({ id: 'CheckoutBody' })
export type CheckoutBody = z.infer<typeof CheckoutBody>

/** Pinned to the provider layer's union, so an outcome cannot be added on one side only. */
export const SettlementOutcomeSchema: z.ZodType<SettlementOutcome> = z
  .enum(['SUCCESS', 'FAILURE', 'CANCEL'])
  .meta({
    id: 'SettlementOutcome',
    description:
      'What happened at the gateway. FAILURE and CANCEL both end in a FAILED payment and grant ' +
      'nothing; they are distinguished because a decline and an abandonment are different facts ' +
      'about a funnel.',
  })

export const MockCompletionBody = z
  .object({ outcome: SettlementOutcomeSchema })
  .meta({ id: 'MockCompletionBody' })
export type MockCompletionBody = z.infer<typeof MockCompletionBody>

export const PaymentListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})
export type PaymentListQuery = z.infer<typeof PaymentListQuery>

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One payment, as its owner sees it.
 *
 * `rawPayload` and `idempotencyKey` are absent and always will be: the first is
 * a verbatim gateway body, the second is the value that stops a replayed
 * callback granting twice. Neither is something a client needs, and both are
 * things a client should never hold.
 *
 * `isTest` IS published, and prominently. A traveller looking at a receipt is
 * entitled to know that no money moved, and a developer reading an API response
 * should not have to infer it from `provider: "MOCK"`.
 */
export const PaymentDetail = z
  .object({
    id: z.uuid(),
    purpose: z.enum(PaymentPurpose),
    provider: z.enum(PaymentProviderCode),
    amountBdt: z
      .int()
      .nonnegative()
      .describe('Whole Bangladeshi taka. There is no minor unit and no fractional amount.'),
    status: z.enum(PaymentStatus),
    isTest: z
      .boolean()
      .describe(
        'True when no money moved — a sandbox payment. It still grants a real entitlement, which ' +
          'is exactly why it is labelled rather than hidden.'
      ),
    itineraryId: z
      .uuid()
      .nullable()
      .describe('The trip this payment unlocks, when it unlocks one.'),
    itineraryTitle: z.string().nullable(),
    planCode: z.enum(PlanCode).nullable().describe('The tier this payment buys, when it buys one.'),
    planName: z.string().nullable(),
    createdAt: z.iso.datetime(),
    settledAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'When the attempt reached a terminal state — set for failures too. Always read it beside ' +
          '`status`; on its own it does not mean money arrived.'
      ),
  })
  .meta({ id: 'PaymentDetail' })
export type PaymentDetail = z.infer<typeof PaymentDetail>

export const CheckoutResponse = z
  .object({
    paymentId: z.uuid(),
    purpose: CheckoutPurposeSchema,
    amountBdt: z
      .int()
      .nonnegative()
      .describe(
        'What will be charged, in whole taka, read server-side from the Plan row or the unlock ' +
          'price setting. Any amount in the request body was ignored.'
      ),
    provider: z.enum(PaymentProviderCode),
    isTest: z
      .boolean()
      .describe(
        'True when the checkout was opened against the sandbox gateway. A client that renders a ' +
          'payment page MUST say so visibly when this is true.'
      ),
    redirectUrl: z
      .url()
      .describe('Where to send the traveller to pay. Absolute, and on the public web origin.'),
  })
  .meta({ id: 'CheckoutResponse' })
export type CheckoutResponse = z.infer<typeof CheckoutResponse>

export const PaymentGrant = z
  .object({
    kind: z.enum([PaymentPurpose.ITINERARY_UNLOCK, PaymentPurpose.SUBSCRIPTION]),
    itineraryId: z.uuid().nullable(),
    itineraryTitle: z.string().nullable(),
    planCode: z.enum(PlanCode).nullable(),
    planName: z.string().nullable(),
    activeUntil: z.iso
      .datetime()
      .nullable()
      .describe(
        'End of the subscription period this payment funded. Null for a one-off unlock, which ' +
          'never expires.'
      ),
  })
  .meta({ id: 'PaymentGrant' })
export type PaymentGrant = z.infer<typeof PaymentGrant>

export const PaymentCompletionResponse = z
  .object({
    payment: PaymentDetail,
    grant: PaymentGrant.nullable().describe(
      'What the traveller now has. Null when the payment did not succeed. Identical on a repeated ' +
        'completion of the same payment — it is read back from the entitlement rather than ' +
        'reported by the settlement, so a double submit does not answer differently the second ' +
        'time.'
    ),
  })
  .meta({ id: 'PaymentCompletionResponse' })
export type PaymentCompletionResponse = z.infer<typeof PaymentCompletionResponse>

export const PaymentListResponse = z
  .object({
    payments: z.array(PaymentDetail),
    total: z.int().nonnegative().describe('Everything matching, ignoring `limit` and `offset`.'),
  })
  .meta({ id: 'PaymentListResponse' })
export type PaymentListResponse = z.infer<typeof PaymentListResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exactly the columns `PaymentDetail` needs, relations included.
 *
 * `userId` is selected but never published: the service compares it for
 * ownership and `toPaymentDetail` drops it. `rawPayload` and `idempotencyKey`
 * are not selected at all, so they cannot leak later when somebody spreads a row
 * into a component.
 */
export const PAYMENT_DETAIL_SELECT = {
  id: true,
  userId: true,
  provider: true,
  purpose: true,
  amountBdt: true,
  status: true,
  isTest: true,
  createdAt: true,
  settledAt: true,
  itineraryId: true,
  itinerary: { select: { title: true } },
  plan: { select: { code: true, name: true } },
} as const

/** The row shape `toPaymentDetail` consumes. Declared rather than inferred, so it is readable. */
export interface PaymentDetailRow {
  id: string
  provider: PaymentDetail['provider']
  purpose: PaymentDetail['purpose']
  amountBdt: number
  status: PaymentDetail['status']
  isTest: boolean
  createdAt: Date
  settledAt: Date | null
  itineraryId: string | null
  itinerary: { title: string } | null
  plan: { code: PlanCode; name: string } | null
}

/** Written out field by field rather than spread, so a new column never leaks by default. */
export function toPaymentDetail(row: PaymentDetailRow): PaymentDetail {
  return {
    id: row.id,
    purpose: row.purpose,
    provider: row.provider,
    amountBdt: row.amountBdt,
    status: row.status,
    isTest: row.isTest,
    itineraryId: row.itineraryId,
    itineraryTitle: row.itinerary?.title ?? null,
    planCode: row.plan?.code ?? null,
    planName: row.plan?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  }
}

export function toPaymentGrant(grant: EntitlementGrant): PaymentGrant {
  return {
    kind: grant.kind,
    itineraryId: grant.itineraryId,
    itineraryTitle: grant.itineraryTitle,
    planCode: grant.planCode,
    planName: grant.planName,
    activeUntil: grant.activeUntil?.toISOString() ?? null,
  }
}
