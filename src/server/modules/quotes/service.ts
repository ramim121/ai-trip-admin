import { ItineraryStatus, QuoteStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { badRequest, conflict, notFound } from '@/server/http/errors'

/**
 * Quotations: what a trip would actually cost, and who said so.
 *
 * The shape of this module follows one rule — A PRICE SOMEBODY HAS SEEN IS
 * IMMUTABLE. Every write below either targets an unsent draft or creates a new
 * version, and the two guards that make that true live in the database rather
 * than here: a CHECK for the arithmetic, and a trigger refusing any change to a
 * revision with `sentAt` set. The predicates in this file are the first line;
 * deliberately not the only one, because a predicate somebody forgets to write
 * is not a rule.
 *
 * Ownership is a WHERE clause throughout, as everywhere else here. A traveller's
 * read is scoped on their user id inside the query, so no path can return a
 * stranger's quote — and a mismatch answers 404 rather than 403, because "not
 * yours" and "does not exist" must look identical from outside or the endpoint
 * becomes a way to enumerate real quote ids.
 *
 * WHAT THIS MODULE DOES NOT DO IS TAKE MONEY. An accepted quote is an
 * agreement, not a payment: it sets a status and stops. Turning one into a
 * booking belongs to the commerce module, and holding that boundary is what
 * stops a second, half-built payment path growing here.
 */

/** Statuses in which a quote is still a live conversation. */
const OPEN_STATUSES = [QuoteStatus.REQUESTED, QuoteStatus.PRICED, QuoteStatus.SENT] as const

const REVISION_SELECT = {
  id: true,
  version: true,
  subtotalBdt: true,
  discountBdt: true,
  totalBdt: true,
  inclusions: true,
  exclusions: true,
  terms: true,
  travellerMessage: true,
  validUntil: true,
  sentAt: true,
  createdAt: true,
} as const

const QUOTE_SELECT = {
  id: true,
  status: true,
  travellerNote: true,
  requestedAt: true,
  decidedAt: true,
  itineraryId: true,
  itinerary: {
    select: { id: true, title: true, destinationLabel: true, totalDays: true, partySize: true },
  },
  revisions: { orderBy: { version: 'desc' }, select: REVISION_SELECT },
} as const

/**
 * Ask what a trip would cost.
 *
 * The itinerary is loaded with the user id in the WHERE clause, so asking for a
 * quote on somebody else's trip is indistinguishable from asking about a trip
 * that does not exist.
 *
 * ONE OPEN QUOTE PER TRIP. Asking twice while a conversation is open is the
 * same conversation, not a second one — the database enforces that with a
 * partial unique index, and this check exists so the traveller gets a sentence
 * instead of a constraint violation. Asking again after a decline IS a new
 * request, which is exactly why that index is partial rather than plain.
 */
export async function requestQuote(
  userId: string,
  itineraryId: string,
  travellerNote: string | null
) {
  const itinerary = await db.itinerary.findFirst({
    where: { id: itineraryId, userId },
    select: { id: true, status: true, days: { select: { id: true }, take: 1 } },
  })

  if (itinerary === null) throw notFound('That itinerary was not found.')

  // Pricing an empty trip wastes an ops cycle and tells the traveller nothing.
  if (itinerary.days.length === 0) {
    throw badRequest('Add at least one day to this trip before asking us to price it.')
  }

  /*
   * THE TRIP MUST ALREADY BE SAVED, and this is an entitlement gate rather than
   * a tidiness rule.
   *
   * SUBMITTED is a member of SAVED_ITINERARY_STATUSES — the exact set the free
   * tier's saved-trip cap counts. Setting it here unconditionally, as this
   * function first did, let anybody at their cap create one more DRAFT and then
   * "ask for a quote" to smuggle it into the saved set, walking straight past
   * the gate `POST /save` enforces on the very same column.
   *
   * Refusing a DRAFT closes that without duplicating the cap arithmetic: by the
   * time a trip is SAVED it has already been counted and allowed. Duplicating
   * the check would have been the obvious fix and the worse one — two
   * implementations of one limit drift, and the copy nobody remembers is the
   * one that stays wrong.
   */
  if (itinerary.status === ItineraryStatus.DRAFT) {
    throw badRequest('Save this trip before asking us to price it.')
  }

  const open = await db.quote.findFirst({
    where: { itineraryId, status: { in: [...OPEN_STATUSES] } },
    select: { id: true },
  })

  if (open !== null) throw conflict('We are already working on a quote for this trip.')

  const created = await db.$transaction(async (tx) => {
    const quote = await tx.quote.create({
      data: { userId, itineraryId, travellerNote, status: QuoteStatus.REQUESTED },
      select: { id: true },
    })

    // The trip's own status follows, so "with us for pricing" shows on the
    // itinerary itself rather than only inside the quote.
    await tx.itinerary.update({
      where: { id: itineraryId },
      data: { status: ItineraryStatus.SUBMITTED },
    })

    return quote
  })

  return readQuote(created.id)
}

/** One quote, unfiltered. For ops — ownership is the caller's to enforce. */
export async function readQuote(quoteId: string) {
  const quote = await db.quote.findUnique({ where: { id: quoteId }, select: QUOTE_SELECT })
  if (quote === null) throw notFound('That quote was not found.')
  return quote
}

/**
 * A traveller's own quote.
 *
 * UNSENT REVISIONS ARE FILTERED OUT HERE, and that is the entire reason this
 * exists separately from `readQuote`. Ops drafts numbers before they are ready
 * to stand behind them; a traveller shown a draft would be seeing a price
 * nobody has agreed to quote them, and would quite reasonably hold us to it.
 */
export async function readMyQuote(userId: string, quoteId: string) {
  const quote = await db.quote.findFirst({ where: { id: quoteId, userId }, select: QUOTE_SELECT })
  if (quote === null) throw notFound('That quote was not found.')

  return { ...quote, revisions: quote.revisions.filter((r) => r.sentAt !== null) }
}

/** Every quote this traveller has asked for, newest first. Sent versions only. */
export async function listMyQuotes(userId: string, take = 50) {
  const quotes = await db.quote.findMany({
    where: { userId },
    orderBy: { requestedAt: 'desc' },
    take,
    select: QUOTE_SELECT,
  })

  return quotes.map((q) => ({ ...q, revisions: q.revisions.filter((r) => r.sentAt !== null) }))
}

/** The ops queue: everything still open. */
export async function listQuoteQueue(take = 100) {
  return db.quote.findMany({
    where: { status: { in: [...OPEN_STATUSES] } },
    // Oldest first, deliberately. A queue sorted newest-first is a queue where
    // the request nobody has answered sinks quietly out of sight.
    orderBy: { requestedAt: 'asc' },
    take,
    select: { ...QUOTE_SELECT, user: { select: { email: true, name: true } } },
  })
}

/**
 * The trip itself, for the person pricing it.
 *
 * Not `getItinerary` — that is scoped to the owner, as every traveller-facing
 * read here is, and ops is not the owner. Pricing somebody's trip is precisely
 * the case where an unscoped read is correct, so it gets its own function whose
 * name says that rather than a `userId` parameter somebody could pass anything
 * to. The console's role guard is what stands in for ownership.
 *
 * A DIFFERENT PROJECTION FROM THE PLANNER'S, deliberately. `ItineraryView`
 * carries allowances, conflicts and transit-sync state — all answers to "what
 * may this traveller still change", which is not a question anybody pricing the
 * trip is asking. What ops needs is what was planned and what it is estimated to
 * cost, so that is what this returns.
 *
 * `costBdt` here is the PLANNER'S estimate and never the quote. It is the
 * starting point for a human, shown so nobody has to add up a week of activities
 * by hand, and the number that reaches the traveller is the one ops types.
 */
export async function readQuoteTrip(itineraryId: string) {
  return db.itinerary.findUnique({
    where: { id: itineraryId },
    select: {
      id: true,
      title: true,
      destinationLabel: true,
      totalDays: true,
      partySize: true,
      startDate: true,
      endDate: true,
      pace: true,
      budgetBand: true,
      transportPreference: true,
      status: true,
      days: {
        orderBy: { dayNumber: 'asc' },
        select: {
          id: true,
          dayNumber: true,
          date: true,
          title: true,
          notes: true,
          blocks: {
            orderBy: [{ startMinute: 'asc' }, { sortOrder: 'asc' }],
            select: {
              id: true,
              kind: true,
              title: true,
              description: true,
              startMinute: true,
              endMinute: true,
              transitMode: true,
              costBdt: true,
              // The catalogue row behind an ACTIVITY block, where there is one.
              // `pricePerPersonBdt` is PER PERSON while the block's `costBdt` is
              // for the whole party, and `priceNote` is where "per boat" or
              // "entry only" lives — both matter to somebody working out what to
              // charge, and neither is recoverable from the block alone.
              activity: { select: { name: true, pricePerPersonBdt: true, priceNote: true } },
            },
          },
        },
      },
    },
  })
}

export interface RevisionInput {
  subtotalBdt: number
  discountBdt: number
  inclusions: string[]
  exclusions: string[]
  terms: string | null
  travellerMessage: string | null
  validUntil: Date | null
}

/**
 * Draft the numbers, or redraft them.
 *
 * Updates the current unsent revision when there is one, and creates the next
 * version when there is not — so "ops pricing this for the first time" and "ops
 * fixing a typo before sending" are one action rather than two the caller has
 * to choose between.
 *
 * `totalBdt` IS COMPUTED HERE AND NEVER ACCEPTED FROM A CALLER — the rule the
 * whole codebase follows for money: a client names what it wants, the server
 * names the number. The CHECK constraint would catch a disagreement, but being
 * unable to express one is better than catching it.
 */
export async function priceQuote(quoteId: string, adminId: string, input: RevisionInput) {
  const quote = await db.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      status: true,
      revisions: {
        orderBy: { version: 'desc' },
        take: 1,
        select: { id: true, version: true, sentAt: true },
      },
    },
  })

  if (quote === null) throw notFound('That quote was not found.')

  if (quote.status === QuoteStatus.ACCEPTED || quote.status === QuoteStatus.WITHDRAWN) {
    throw conflict(`A ${quote.status.toLowerCase()} quote cannot be repriced.`)
  }

  if (input.discountBdt > input.subtotalBdt) {
    throw badRequest('The discount cannot be larger than the subtotal.', [
      { path: 'discountBdt', message: 'Larger than the subtotal.' },
    ])
  }

  const totalBdt = input.subtotalBdt - input.discountBdt
  const latest = quote.revisions[0]

  await db.$transaction(async (tx) => {
    if (latest !== undefined && latest.sentAt === null) {
      /*
       * Redrafting. `sentAt: null` sits in the WHERE rather than being checked
       * above and trusted: between that read and this write somebody else may
       * have sent it, and an `updateMany` matching no row is the honest outcome
       * of that race.
       */
      const updated = await tx.quoteRevision.updateMany({
        where: { id: latest.id, sentAt: null },
        data: { ...input, totalBdt, pricedByAdminId: adminId },
      })

      if (updated.count === 0) {
        throw conflict('That version has already been sent. Create a new one instead.')
      }
    } else {
      await tx.quoteRevision.create({
        data: {
          quoteId,
          version: (latest?.version ?? 0) + 1,
          ...input,
          totalBdt,
          pricedByAdminId: adminId,
        },
      })
    }

    /*
     * A SENT quote stays SENT while ops drafts the next version.
     *
     * THE STATUS DESCRIBES WHAT THE TRAVELLER SEES, not what ops is doing
     * privately. Setting PRICED unconditionally here looked harmless and was
     * not: `decideQuote` is predicated on SENT, so the moment ops began
     * drafting a revision the traveller silently lost the ability to accept the
     * version they had already been shown. A live offer is not withdrawn
     * because somebody in the office opened a draft beside it.
     *
     * Caught by exercising the whole lifecycle rather than each call alone —
     * every individual step was correct.
     */
    if (quote.status !== QuoteStatus.SENT) {
      await tx.quote.update({ where: { id: quoteId }, data: { status: QuoteStatus.PRICED } })
    }
  })

  return readQuote(quoteId)
}

/**
 * Show the traveller what it costs.
 *
 * Stamping `sentAt` is what makes the revision immutable — from here the
 * trigger refuses every change to it and a correction must be a new version.
 * That is the intended cost of sending: it is the moment the number stops being
 * ours and starts being theirs.
 */
export async function sendQuote(quoteId: string, now: Date = new Date()) {
  const draft = await db.quoteRevision.findFirst({
    where: { quoteId, sentAt: null },
    orderBy: { version: 'desc' },
    select: { id: true },
  })

  if (draft === null) throw conflict('There is nothing new to send on this quote.')

  await db.$transaction(async (tx) => {
    const sent = await tx.quoteRevision.updateMany({
      where: { id: draft.id, sentAt: null },
      data: { sentAt: now },
    })

    if (sent.count === 0) throw conflict('That version has already been sent.')

    await tx.quote.update({ where: { id: quoteId }, data: { status: QuoteStatus.SENT } })

    const quote = await tx.quote.findUnique({
      where: { id: quoteId },
      select: { itineraryId: true },
    })

    if (quote?.itineraryId) {
      await tx.itinerary.update({
        where: { id: quote.itineraryId },
        data: { status: ItineraryStatus.QUOTED },
      })
    }
  })

  return readQuote(quoteId)
}

/**
 * Close a quote we are not going to fulfil.
 *
 * THIS IS NOT HOUSEKEEPING, it is the release valve on the partial unique index.
 * Only one quote per itinerary may be open, so a request ops cannot price — the
 * dates are gone, the party is too large, the traveller stopped replying — would
 * otherwise sit REQUESTED forever and permanently block that traveller from ever
 * asking about that trip again. Without this, the index that stops duplicate
 * conversations becomes a way to lock somebody out of their own itinerary.
 *
 * An ACCEPTED quote is not withdrawable. Once a traveller has agreed a price
 * they are owed a conversation, not a status change made without them.
 */
export async function withdrawQuote(quoteId: string, now: Date = new Date()) {
  const claimed = await db.quote.updateMany({
    where: { id: quoteId, status: { in: [...OPEN_STATUSES] } },
    data: { status: QuoteStatus.WITHDRAWN, decidedAt: now },
  })

  if (claimed.count === 0) throw conflict('This quote is no longer open to withdraw.')

  /*
   * The trip returns to the traveller's hands as SAVED — never DRAFT.
   *
   * Leaving it SUBMITTED or QUOTED would show "with us for pricing" on a trip
   * nobody is pricing. But dropping it to DRAFT, which this first did, is worse
   * than the problem it solves: `requestQuote` only accepts a trip that is
   * already saved, so the status before the quote was SAVED, and DRAFT is
   * outside SAVED_ITINERARY_STATUSES. An ops withdrawal would therefore silently
   * un-save a trip the traveller had spent one of their saved slots on, and take
   * it out of the set My trips counts — a housekeeping action on our side
   * quietly deleting something on theirs.
   */
  const quote = await db.quote.findUnique({ where: { id: quoteId }, select: { itineraryId: true } })

  if (quote?.itineraryId) {
    await db.itinerary.update({
      where: { id: quote.itineraryId },
      data: { status: ItineraryStatus.SAVED },
    })
  }

  return readQuote(quoteId)
}

/**
 * The traveller's answer.
 *
 * Predicated on the quote still being SENT, so two clicks — or a click racing
 * an ops withdrawal — resolve to one decision rather than to whichever write
 * happened to land last.
 */
export async function decideQuote(
  userId: string,
  quoteId: string,
  accept: boolean,
  now: Date = new Date()
) {
  const claimed = await db.quote.updateMany({
    where: { id: quoteId, userId, status: QuoteStatus.SENT },
    data: {
      status: accept ? QuoteStatus.ACCEPTED : QuoteStatus.DECLINED,
      decidedAt: now,
    },
  })

  if (claimed.count === 0) throw conflict('This quote is no longer open for a decision.')

  /*
   * THE TRIP FOLLOWS THE DECISION EITHER WAY.
   *
   * Accepting moves it to ACCEPTED, which is the obvious half. Declining moves
   * it back to SAVED, which is the half that was missing: this first updated the
   * itinerary only when `accept` was true, so a declined quote left the trip
   * sitting at QUOTED and My trips went on advertising "Quote ready" for a price
   * the traveller had just refused. The status a traveller sees has to reflect
   * the last thing they did, and declining is a thing they did.
   *
   * SAVED rather than DRAFT, for the reason `withdrawQuote` gives at length.
   */
  const quote = await db.quote.findUnique({
    where: { id: quoteId },
    select: { itineraryId: true },
  })

  if (quote?.itineraryId) {
    await db.itinerary.update({
      where: { id: quote.itineraryId },
      data: { status: accept ? ItineraryStatus.ACCEPTED : ItineraryStatus.SAVED },
    })
  }

  return readMyQuote(userId, quoteId)
}
