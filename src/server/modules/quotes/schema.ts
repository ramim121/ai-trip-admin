import { z } from 'zod'
import { QuoteStatus } from '@/generated/prisma/enums'

/**
 * The wire contract for quotations.
 *
 * WHAT IS NOT IN A REQUEST BODY: a subtotal, a discount, a total. The same rule
 * the payments and bookings modules state at length — the client asks for a
 * quote and the server names every figure. `RequestQuoteBody` carries a note
 * and nothing else, so a body arriving with `totalBdt: 1` has that key stripped
 * by zod before any handler sees it.
 *
 * WHAT IS NOT IN A TRAVELLER'S RESPONSE: an unsent revision. That filtering
 * happens in the service, because a schema cannot know who is asking — but it
 * is worth stating in both places that a traveller must never receive a price
 * ops has not agreed to stand behind.
 */

export const QuoteRevisionView = z
  .object({
    id: z.uuid(),
    version: z.int().min(1).describe('1-based. Version 2 exists because the price changed.'),
    subtotalBdt: z.int().nonnegative().describe('Whole taka, before any discount.'),
    discountBdt: z.int().nonnegative(),
    totalBdt: z.int().nonnegative().describe('`subtotalBdt - discountBdt`. What was quoted.'),
    inclusions: z.array(z.string()).describe('What the price covers, as ops wrote it.'),
    exclusions: z.array(z.string()).describe('What it does not.'),
    terms: z.string().nullable(),
    travellerMessage: z.string().nullable(),
    validUntil: z.iso.datetime().nullable().describe('After this the price is no longer held.'),
    sentAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'When the traveller was shown this version. Null means it is still a draft — and a ' +
          'traveller-facing response never contains one, because a draft is a price nobody has ' +
          'agreed to quote them.'
      ),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'QuoteRevisionView' })
export type QuoteRevisionView = z.infer<typeof QuoteRevisionView>

export const QuoteTripView = z
  .object({
    id: z.uuid(),
    title: z.string(),
    destinationLabel: z.string(),
    totalDays: z.int(),
    partySize: z.int(),
  })
  .meta({ id: 'QuoteTripView' })

export const QuoteView = z
  .object({
    id: z.uuid(),
    status: z.enum(QuoteStatus),
    travellerNote: z.string().nullable().describe('What the traveller said when asking.'),
    requestedAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable().describe('Null while the quote is still open.'),
    itineraryId: z.uuid().nullable().describe('Null when the trip has since been deleted.'),
    itinerary: QuoteTripView.nullable(),
    revisions: z
      .array(QuoteRevisionView)
      .describe('Newest first. Empty until ops has sent a price.'),
  })
  .meta({ id: 'QuoteView' })
export type QuoteView = z.infer<typeof QuoteView>

export const RequestQuoteBody = z
  .object({
    note: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe('Anything the traveller wants ops to know before pricing.'),
  })
  .meta({ id: 'RequestQuoteBody' })
export type RequestQuoteBody = z.infer<typeof RequestQuoteBody>

export const DecideQuoteBody = z
  .object({
    accept: z.boolean().describe('True to accept the quote, false to decline it.'),
  })
  .meta({ id: 'DecideQuoteBody' })
export type DecideQuoteBody = z.infer<typeof DecideQuoteBody>

export const QuoteListResponse = z
  .object({ quotes: z.array(QuoteView) })
  .meta({ id: 'QuoteListResponse' })
export type QuoteListResponse = z.infer<typeof QuoteListResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

interface RevisionRow {
  id: string
  version: number
  subtotalBdt: number
  discountBdt: number
  totalBdt: number
  inclusions: string[]
  exclusions: string[]
  terms: string | null
  travellerMessage: string | null
  validUntil: Date | null
  sentAt: Date | null
  createdAt: Date
}

interface QuoteRow {
  id: string
  status: QuoteStatus
  travellerNote: string | null
  requestedAt: Date
  decidedAt: Date | null
  itineraryId: string | null
  itinerary: {
    id: string
    title: string
    destinationLabel: string
    totalDays: number
    partySize: number
  } | null
  revisions: RevisionRow[]
}

export function toQuoteView(row: QuoteRow): QuoteView {
  return {
    id: row.id,
    status: row.status,
    travellerNote: row.travellerNote,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    itineraryId: row.itineraryId,
    itinerary: row.itinerary,
    revisions: row.revisions.map((revision) => ({
      id: revision.id,
      version: revision.version,
      subtotalBdt: revision.subtotalBdt,
      discountBdt: revision.discountBdt,
      totalBdt: revision.totalBdt,
      inclusions: revision.inclusions,
      exclusions: revision.exclusions,
      terms: revision.terms,
      travellerMessage: revision.travellerMessage,
      validUntil: revision.validUntil?.toISOString() ?? null,
      sentAt: revision.sentAt?.toISOString() ?? null,
      createdAt: revision.createdAt.toISOString(),
    })),
  }
}
