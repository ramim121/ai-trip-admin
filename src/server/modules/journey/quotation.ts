import type { Prisma } from '@/generated/prisma/client'
import { JourneyStatus, QuoteStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { badRequest, conflict, notFound } from '@/server/http/errors'

/**
 * Pricing a plan somebody else made.
 *
 * THE WHOLE SCREEN IS A COMPARISON, and this module is what makes that possible.
 * A traveller has spent an evening choosing things and has been shown estimates
 * throughout — bands from Viator's "from" price, bands inferred from a Google
 * price level. None of those are quotes. Ops now goes line by line and says what
 * each thing really costs and who really supplies it, and the traveller sees
 * both columns side by side afterwards.
 *
 * WHY THE BRIEF TRAVELS WITH THE LINE. The plan says the Ibis; the brief says
 * "3-star plus, pool, quiet end of Patong, 4-6k a night". Ops looking at only
 * the first can substitute nothing without guessing. Ops looking at both can put
 * the traveller somewhere better and say why. That pairing is the reason
 * `PreferenceBrief` survives a concrete pick, and this is where it pays off.
 *
 * SUBTOTAL IS DERIVED, NEVER TYPED. Once a revision has lines its subtotal is
 * the sum of them — a hand-typed subtotal beside itemised lines is a number that
 * disagrees with its own breakdown the first time somebody edits one row and
 * forgets the other. `syncTotals` runs after every line write.
 */

/** Statuses in which a quote is still a live conversation. */
const OPEN_STATUSES = [QuoteStatus.REQUESTED, QuoteStatus.PRICED, QuoteStatus.SENT] as const

const LINE_SELECT = {
  id: true,
  journeyItemId: true,
  vendorName: true,
  label: true,
  detail: true,
  priceBdt: true,
  quantity: true,
  sortOrder: true,
} satisfies Prisma.QuoteLineItemSelect

/**
 * The planned side of the comparison.
 *
 * Everything the traveller decided, plus everything they said they wanted, in
 * the order the days run. Unscoped by user on purpose — ops is not the owner,
 * and pricing somebody's trip is exactly the case where that is correct. The
 * console's role guard stands in for ownership, as it does in `readQuoteTrip`.
 */
export async function readJourneyForPricing(journeyId: string) {
  const journey = await db.journey.findUnique({
    where: { id: journeyId },
    select: {
      id: true,
      title: true,
      destinations: true,
      durationDays: true,
      startDate: true,
      dateBucket: true,
      partyAdults: true,
      partyChildren: true,
      budgetMinBdt: true,
      budgetMaxBdt: true,
      tripType: true,
      interests: true,
      status: true,
      rawIntake: true,
      contactWhatsapp: true,
      contactEmail: true,
      contactPreferredTime: true,
      userNotes: true,
      user: { select: { id: true, name: true, email: true } },
      items: {
        orderBy: [{ dayNumber: 'asc' }, { sortOrder: 'asc' }],
        select: {
          id: true,
          dayNumber: true,
          slot: true,
          startMinute: true,
          durationMin: true,
          type: true,
          origin: true,
          source: true,
          externalId: true,
          title: true,
          description: true,
          estPriceMinBdt: true,
          estPriceMaxBdt: true,
          estPricePer: true,
          matchReason: true,
          locationName: true,
          snapshot: true,
          // The half of the comparison ops cannot get anywhere else: what the
          // traveller was actually asking for when they picked this.
          brief: {
            select: { id: true, pillar: true, location: true, summary: true, constraints: true },
          },
        },
      },
      // Briefs with no pick attached are requests nobody has answered yet — a
      // traveller who said what they wanted for food in Krabi and never chose a
      // restaurant. Ops should be able to quote for that too, so it belongs on
      // this screen rather than only on the traveller's.
      briefs: {
        orderBy: [{ location: 'asc' }, { pillar: 'asc' }],
        select: {
          id: true,
          pillar: true,
          location: true,
          summary: true,
          constraints: true,
          _count: { select: { items: true } },
        },
      },
    },
  })

  if (journey === null) throw notFound('That plan was not found.')

  return journey
}

/** The ops queue, oldest first — a plan waiting on a price. */
export async function listJourneyQuoteQueue(take = 100) {
  return db.quote.findMany({
    where: { status: { in: [...OPEN_STATUSES] }, journeyId: { not: null } },
    // Oldest first, deliberately. A queue sorted newest-first is a queue where
    // the request nobody has answered sinks quietly out of sight.
    orderBy: { requestedAt: 'asc' },
    take,
    select: {
      id: true,
      status: true,
      travellerNote: true,
      requestedAt: true,
      journeyId: true,
      user: { select: { name: true, email: true } },
      journey: {
        select: {
          id: true,
          title: true,
          destinations: true,
          durationDays: true,
          startDate: true,
          partyAdults: true,
          partyChildren: true,
          budgetMinBdt: true,
          budgetMaxBdt: true,
          contactWhatsapp: true,
          _count: { select: { items: true } },
        },
      },
      revisions: {
        orderBy: { version: 'desc' },
        take: 1,
        select: { version: true, totalBdt: true, sentAt: true },
      },
    },
  })
}

/**
 * The midpoint of an estimate band, for seeding a line.
 *
 * A STARTING NUMBER, NOT A PRICE. Ops overwrites it — that is the point of the
 * screen — but starting from the traveller's own band beats starting from zero,
 * because a line already in the right order of magnitude makes a typo visible.
 * Null where there was no band, so the caller can badge it rather than render a
 * confident 0.
 */
function seedPrice(min: number | null, max: number | null): number | null {
  if (min === null && max === null) return null
  if (min === null) return max
  if (max === null) return min
  return Math.round((min + max) / 2)
}

/**
 * Sum the lines onto the revision.
 *
 * Runs inside every line write's transaction. `discountBdt` is ops's own number
 * and has nothing to do with the breakdown, so it survives — but it is clamped
 * to the new subtotal rather than allowed to violate the CHECK. Clamping is
 * right here: the alternative is an error thrown from a line edit, about a
 * discount the person editing did not touch.
 */
async function syncTotals(tx: Prisma.TransactionClient, revisionId: string) {
  const lines = await tx.quoteLineItem.findMany({
    where: { quoteRevisionId: revisionId },
    select: { priceBdt: true, quantity: true },
  })

  const subtotalBdt = lines.reduce((sum, line) => sum + line.priceBdt * line.quantity, 0)

  const revision = await tx.quoteRevision.findUnique({
    where: { id: revisionId },
    select: { discountBdt: true },
  })

  const discountBdt = Math.min(revision?.discountBdt ?? 0, subtotalBdt)

  const updated = await tx.quoteRevision.updateMany({
    where: { id: revisionId, sentAt: null },
    data: { subtotalBdt, discountBdt, totalBdt: subtotalBdt - discountBdt },
  })

  if (updated.count === 0) {
    throw conflict('That version has already been sent. Create a new one instead.')
  }
}

/**
 * The draft ops is working on, creating and seeding it on first open.
 *
 * SEEDED ONCE, FROM THE PLAN. A fresh draft arrives with one line per planned
 * item, labelled with the traveller's own title and priced at the midpoint of
 * their estimate — so ops starts by correcting a filled-in sheet rather than by
 * retyping a week of activities. Reopening does not reseed: those are ops's
 * edits by then, and re-running the seed would quietly discard them.
 *
 * A SENT revision is never reopened. Sending is what makes a number theirs, so
 * the next edit starts a new version — which is what this does when the latest
 * revision has `sentAt` set.
 */
export async function openPricingDraft(quoteId: string, adminId: string) {
  const quote = await db.quote.findUnique({
    where: { id: quoteId },
    select: {
      id: true,
      status: true,
      journeyId: true,
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

  const latest = quote.revisions[0]
  if (latest !== undefined && latest.sentAt === null) return readPricingDraft(latest.id)

  const journey =
    quote.journeyId === null
      ? null
      : await db.journey.findUnique({
          where: { id: quote.journeyId },
          select: {
            partyAdults: true,
            partyChildren: true,
            items: {
              orderBy: [{ dayNumber: 'asc' }, { sortOrder: 'asc' }],
              select: {
                id: true,
                dayNumber: true,
                title: true,
                locationName: true,
                estPriceMinBdt: true,
                estPriceMaxBdt: true,
                estPricePer: true,
              },
            },
          },
        })

  const items = journey?.items ?? []

  /*
   * A LINE IS WHAT WE CHARGE FOR THE BOOKING, NOT WHAT ONE PERSON PAYS.
   *
   * The traveller's estimates carry a `per` unit, and a tour quoted per person
   * has to be multiplied by the party before it becomes a line — seeding the
   * per-person figure, as this first did, put a family of four's boat trip in at
   * a quarter of its price. It also disagreed with the budget meter the
   * traveller had been watching, which multiplies for exactly the same reason.
   */
  const party = Math.max(1, (journey?.partyAdults ?? 1) + (journey?.partyChildren ?? 0))

  /*
   * Carried forward when there is a previous version, so revising a quote does
   * not mean retyping every vendor name ops already researched. A revision is
   * usually a change to two lines out of fifteen.
   */
  const previous =
    latest === undefined
      ? []
      : await db.quoteLineItem.findMany({
          where: { quoteRevisionId: latest.id },
          orderBy: { sortOrder: 'asc' },
          select: LINE_SELECT,
        })

  const revisionId = await db.$transaction(async (tx) => {
    const revision = await tx.quoteRevision.create({
      data: {
        quoteId,
        version: (latest?.version ?? 0) + 1,
        subtotalBdt: 0,
        discountBdt: 0,
        totalBdt: 0,
        pricedByAdminId: adminId,
      },
      select: { id: true },
    })

    const seeded =
      previous.length > 0
        ? previous.map((line, index) => ({
            quoteRevisionId: revision.id,
            journeyItemId: line.journeyItemId,
            vendorName: line.vendorName,
            label: line.label,
            detail: line.detail,
            priceBdt: line.priceBdt,
            quantity: line.quantity,
            sortOrder: index,
          }))
        : items.map((item, index) => ({
            quoteRevisionId: revision.id,
            journeyItemId: item.id,
            vendorName: null,
            label: item.title,
            detail:
              item.locationName === null
                ? `Day ${item.dayNumber}`
                : `Day ${item.dayNumber} - ${item.locationName}`,
            // Zero rather than null where there was no band: a line has to carry
            // a number, and 0 is what the screen badges as "not priced yet".
            priceBdt:
              (seedPrice(item.estPriceMinBdt, item.estPriceMaxBdt) ?? 0) *
              (item.estPricePer === 'person' ? party : 1),
            quantity: 1,
            sortOrder: index,
          }))

    if (seeded.length > 0) await tx.quoteLineItem.createMany({ data: seeded })

    await syncTotals(tx, revision.id)

    if (quote.status === QuoteStatus.REQUESTED) {
      await tx.quote.update({ where: { id: quoteId }, data: { status: QuoteStatus.PRICED } })
    }

    return revision.id
  })

  return readPricingDraft(revisionId)
}

/** One revision with its lines, in sheet order. */
export async function readPricingDraft(revisionId: string) {
  const revision = await db.quoteRevision.findUnique({
    where: { id: revisionId },
    select: {
      id: true,
      quoteId: true,
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
      lines: { orderBy: { sortOrder: 'asc' }, select: LINE_SELECT },
    },
  })

  if (revision === null) throw notFound('That quote version was not found.')

  return revision
}

/**
 * The quote side of the workbench: the conversation, and its newest version.
 *
 * NEWEST RATHER THAN NEWEST-SENT, because this is the ops screen and the draft
 * is the thing being worked on. `readComparison` makes the opposite choice for
 * the traveller, and the difference between those two lines is the whole reason
 * a draft can exist at all.
 *
 * Returns null where the traveller has not asked yet — a plan can be read here
 * before anybody requests a price, and that is not an error.
 */
export async function readQuoteStateForJourney(journeyId: string) {
  const quote = await db.quote.findFirst({
    where: { journeyId },
    orderBy: { requestedAt: 'desc' },
    select: {
      id: true,
      status: true,
      travellerNote: true,
      requestedAt: true,
      decidedAt: true,
      revisions: {
        orderBy: { version: 'desc' },
        select: {
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
          lines: { orderBy: { sortOrder: 'asc' }, select: LINE_SELECT },
        },
      },
    },
  })

  if (quote === null) return null

  const latest = quote.revisions[0] ?? null

  return {
    quote: {
      id: quote.id,
      status: quote.status,
      travellerNote: quote.travellerNote,
      requestedAt: quote.requestedAt,
      decidedAt: quote.decidedAt,
    },
    latest,
    /** Sent versions, newest first — what the traveller has actually been shown. */
    history: quote.revisions.filter((revision) => revision.sentAt !== null),
  }
}

export interface LineInput {
  vendorName: string | null
  label: string
  detail: string | null
  priceBdt: number
  quantity: number
}

export interface NewLineInput extends LineInput {
  /**
   * The planned item this prices, or null for something nobody planned.
   *
   * NOT ALWAYS NULL, which it was at first and which made removal one-way: ops
   * who dropped a line by mistake had no way to put it back against its item,
   * because the only re-add path wrote null and the row would then render under
   * "added by us" instead of beside the thing it prices. The unique index still
   * stops a second line against an item that already has one.
   */
  journeyItemId: string | null
}

/**
 * Edit one line — the vendor name and the real price.
 *
 * The unsent predicate sits in the WHERE rather than being read and trusted. The
 * trigger would refuse a sent revision regardless; this turns that into a
 * sentence instead of a 500.
 */
export async function updateLine(revisionId: string, lineId: string, input: LineInput) {
  if (input.label.trim() === '') throw badRequest('A line needs a name.')
  if (input.priceBdt < 0) throw badRequest('A price cannot be negative.')
  if (input.quantity < 1) throw badRequest('A line covers at least one of something.')

  await db.$transaction(async (tx) => {
    const open = await tx.quoteRevision.findFirst({
      where: { id: revisionId, sentAt: null },
      select: { id: true },
    })

    if (open === null) {
      throw conflict('That version has already been sent. Create a new one instead.')
    }

    const claimed = await tx.quoteLineItem.updateMany({
      where: { id: lineId, quoteRevisionId: revisionId },
      data: {
        vendorName: input.vendorName === null || input.vendorName.trim() === ''
          ? null
          : input.vendorName.trim(),
        label: input.label.trim(),
        detail: input.detail === null || input.detail.trim() === '' ? null : input.detail.trim(),
        priceBdt: input.priceBdt,
        quantity: input.quantity,
      },
    })

    if (claimed.count === 0) throw notFound('That line was not found on this version.')

    await syncTotals(tx, revisionId)
  })

  return readPricingDraft(revisionId)
}

/**
 * Add a line — either something nobody planned, or one put back.
 *
 * A null `journeyItemId` is the visa fee, the airport pickup, the insurance:
 * what the partial unique index leaves alone and what the comparison renders
 * under "added by us". A non-null one restores a line ops dropped, back beside
 * the item it prices.
 */
export async function addLine(revisionId: string, input: NewLineInput) {
  if (input.label.trim() === '') throw badRequest('A line needs a name.')
  if (input.priceBdt < 0) throw badRequest('A price cannot be negative.')

  await db.$transaction(async (tx) => {
    const open = await tx.quoteRevision.findFirst({
      where: { id: revisionId, sentAt: null },
      select: { id: true },
    })

    if (open === null) {
      throw conflict('That version has already been sent. Create a new one instead.')
    }

    const last = await tx.quoteLineItem.aggregate({
      where: { quoteRevisionId: revisionId },
      _max: { sortOrder: true },
    })

    await tx.quoteLineItem.create({
      data: {
        quoteRevisionId: revisionId,
        journeyItemId: input.journeyItemId,
        vendorName: input.vendorName === null || input.vendorName.trim() === ''
          ? null
          : input.vendorName.trim(),
        label: input.label.trim(),
        detail: input.detail === null || input.detail.trim() === '' ? null : input.detail.trim(),
        priceBdt: input.priceBdt,
        quantity: Math.max(1, input.quantity),
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    })

    await syncTotals(tx, revisionId)
  })

  return readPricingDraft(revisionId)
}

/**
 * Drop a line.
 *
 * ONE OF THE TWO REASONS THE COMPARISON EXISTS. Ops removing a line means "we
 * are not quoting for this", and the traveller has to see that rather than
 * discover it on arrival — so the planned item stays on their side of the screen
 * with nothing beside it, which is exactly what joining lines onto items
 * produces once the line is gone.
 */
export async function removeLine(revisionId: string, lineId: string) {
  await db.$transaction(async (tx) => {
    const open = await tx.quoteRevision.findFirst({
      where: { id: revisionId, sentAt: null },
      select: { id: true },
    })

    if (open === null) {
      throw conflict('That version has already been sent. Create a new one instead.')
    }

    const deleted = await tx.quoteLineItem.deleteMany({
      where: { id: lineId, quoteRevisionId: revisionId },
    })

    if (deleted.count === 0) throw notFound('That line was not found on this version.')

    await syncTotals(tx, revisionId)
  })

  return readPricingDraft(revisionId)
}

export interface TermsInput {
  discountBdt: number
  inclusions: string[]
  exclusions: string[]
  terms: string | null
  travellerMessage: string | null
  validUntil: Date | null
}

/**
 * Everything on the revision that is not a line.
 *
 * The subtotal is absent from this input by design — it belongs to the lines,
 * and accepting one here would let the two disagree. `totalBdt` follows from the
 * pair, computed rather than accepted, as money always is here.
 */
export async function saveTerms(revisionId: string, adminId: string, input: TermsInput) {
  const revision = await db.quoteRevision.findFirst({
    where: { id: revisionId, sentAt: null },
    select: { subtotalBdt: true },
  })

  if (revision === null) {
    throw conflict('That version has already been sent. Create a new one instead.')
  }

  if (input.discountBdt < 0) throw badRequest('A discount cannot be negative.')

  if (input.discountBdt > revision.subtotalBdt) {
    throw badRequest('The discount cannot be larger than the subtotal.', [
      { path: 'discountBdt', message: 'Larger than the subtotal.' },
    ])
  }

  const updated = await db.quoteRevision.updateMany({
    where: { id: revisionId, sentAt: null },
    data: {
      discountBdt: input.discountBdt,
      totalBdt: revision.subtotalBdt - input.discountBdt,
      inclusions: input.inclusions,
      exclusions: input.exclusions,
      terms: input.terms,
      travellerMessage: input.travellerMessage,
      validUntil: input.validUntil,
      pricedByAdminId: adminId,
    },
  })

  if (updated.count === 0) {
    throw conflict('That version has already been sent. Create a new one instead.')
  }

  return readPricingDraft(revisionId)
}

/**
 * Both columns: what was planned, and what it costs.
 *
 * THE PLAN IS THE SPINE AND THE QUOTE HANGS OFF IT. Every planned item appears
 * whether or not ops priced it, so a line they dropped shows as an absence
 * rather than by simply not being there — which is the difference between a
 * traveller noticing now and noticing at the airport.
 *
 * `userId` NULL MEANS OPS, AND IT CHANGES WHAT IS VISIBLE. A traveller may only
 * see sent revisions, the same rule `readMyQuote` enforces and for the same
 * reason: a draft is a number nobody has agreed to stand behind. Ops sees the
 * draft, because ops is the one writing it.
 */
export async function readComparison(journeyId: string, userId: string | null) {
  const journey = await db.journey.findFirst({
    where: userId === null ? { id: journeyId } : { id: journeyId, userId },
    select: {
      id: true,
      title: true,
      destinations: true,
      durationDays: true,
      startDate: true,
      partyAdults: true,
      partyChildren: true,
      status: true,
      items: {
        orderBy: [{ dayNumber: 'asc' }, { sortOrder: 'asc' }],
        select: {
          id: true,
          dayNumber: true,
          slot: true,
          type: true,
          title: true,
          locationName: true,
          estPriceMinBdt: true,
          estPriceMaxBdt: true,
          estPricePer: true,
          brief: { select: { pillar: true, summary: true } },
        },
      },
    },
  })

  if (journey === null) throw notFound('That plan was not found.')

  const revision = await db.quoteRevision.findFirst({
    where: {
      quote: userId === null ? { journeyId } : { journeyId, userId },
      sentAt: userId === null ? undefined : { not: null },
    },
    orderBy: { version: 'desc' },
    select: {
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
      quote: { select: { id: true, status: true } },
      lines: { orderBy: { sortOrder: 'asc' }, select: LINE_SELECT },
    },
  })

  const byItem = new Map(
    (revision?.lines ?? [])
      .filter((line) => line.journeyItemId !== null)
      .map((line) => [line.journeyItemId, line])
  )

  return {
    journey: {
      id: journey.id,
      title: journey.title,
      destinations: journey.destinations,
      durationDays: journey.durationDays,
      startDate: journey.startDate,
      partySize: journey.partyAdults + journey.partyChildren,
      status: journey.status,
    },
    quote: revision === null ? null : { id: revision.quote.id, status: revision.quote.status },
    revision:
      revision === null
        ? null
        : {
            id: revision.id,
            version: revision.version,
            subtotalBdt: revision.subtotalBdt,
            discountBdt: revision.discountBdt,
            totalBdt: revision.totalBdt,
            inclusions: revision.inclusions,
            exclusions: revision.exclusions,
            terms: revision.terms,
            travellerMessage: revision.travellerMessage,
            validUntil: revision.validUntil,
            sentAt: revision.sentAt,
          },
    rows: journey.items.map((item) => ({ item, quoted: byItem.get(item.id) ?? null })),
    extras: (revision?.lines ?? []).filter((line) => line.journeyItemId === null),
  }
}

/**
 * Move a journey's status to follow its quote.
 *
 * Kept here rather than inside the quotes service so that module does not have
 * to learn journeys exist. It is called after every quote transition; when the
 * quote belongs to an itinerary instead, `journeyId` is null and this does
 * nothing.
 */
export async function syncJourneyStatus(quoteId: string, status: JourneyStatus) {
  const quote = await db.quote.findUnique({ where: { id: quoteId }, select: { journeyId: true } })

  if (quote === null || quote.journeyId === null) return

  await db.journey.update({ where: { id: quote.journeyId }, data: { status } })
}
