'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { recordAudit } from '@/server/audit/log'
import {
  addLine,
  openPricingDraft,
  removeLine,
  saveTerms,
  updateLine,
} from '@/server/modules/journey/quotation'
import { sendQuote, withdrawQuote } from '@/server/modules/quotes/service'
import { QUOTE_WRITE_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'

/**
 * Pricing a plan, line by line.
 *
 * The same shape as `quotes/actions.ts` and for the same reasons — a server
 * action is an HTTP endpoint with a generated URL, so the role check in each one
 * below is the only thing controlling what gets written; the page's check
 * controls only what is displayed.
 *
 * WHAT IS DIFFERENT HERE IS THAT NO SUBTOTAL IS POSTED AT ALL. On an itinerary
 * quote ops types a subtotal and a discount. Here the subtotal is the sum of the
 * lines, recomputed after every line write, so a form accepting one would be
 * offering ops a number its own breakdown could contradict. Only the discount
 * arrives from the form, and even that is clamped.
 *
 * Outcomes travel as `?done=` / `?error=` on a redirect, because this console
 * ships no client JavaScript and there is no `useActionState` to receive a
 * returned object. Every save re-reads the database, so what ops sees afterwards
 * is the stored row rather than what they typed.
 */

/**
 * Whole taka.
 *
 * `z.coerce.number()` would take "12000.75" and let Postgres round it into the
 * Int column silently. Money is whole taka everywhere here, and a fractional
 * input is a mistake rather than a value to round.
 */
const TakaField = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0, {
    message: 'Prices must be a whole number of taka, zero or more.',
  })

const CountField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? 1 : Number(value)))
  .refine((value) => Number.isInteger(value) && value >= 1 && value <= 999, {
    message: 'A line covers between one and 999 of something.',
  })

/** An empty text input means "nothing here", which is null rather than "". */
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))

/** One item per line; blank lines dropped so a stray newline is not a bullet. */
const LinesField = z
  .string()
  .max(4000)
  .transform((value) =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  )

/**
 * `<input type="date">` posts `YYYY-MM-DD`, or an empty string.
 *
 * Parsed to the END of that day in Dhaka. A quote valid until the 20th should
 * still be acceptable at 5pm on the 20th; taking the date at face value expires
 * it as the 20th begins, a full day before the traveller was told. Bangladesh
 * observes no daylight saving, so the fixed +06:00 is right year-round.
 */
const ValidUntilField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : new Date(`${value}T23:59:59+06:00`)))
  .refine((value) => value === null || !Number.isNaN(value.getTime()), {
    message: 'That is not a date we can read.',
  })

const LineForm = z.object({
  journeyId: z.uuid(),
  revisionId: z.uuid(),
  lineId: z.uuid(),
  vendorName: OptionalText(200),
  label: z.string().trim().min(1, 'A line needs a name.').max(200),
  detail: OptionalText(500),
  priceBdt: TakaField,
  quantity: CountField,
})

/**
 * Adding a line, with or without a planned item behind it.
 *
 * The "add an extra" form leaves `journeyItemId` empty; the "put this back" form
 * beside an unquoted item posts its id. One action rather than two, because the
 * only difference between them is which column the row lands in.
 */
const AddLineForm = LineForm.omit({ lineId: true }).extend({
  journeyItemId: z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine((value) => value === null || z.uuid().safeParse(value).success, {
      message: 'That planned item could not be identified.',
    }),
})

const RemoveLineForm = z.object({
  journeyId: z.uuid(),
  revisionId: z.uuid(),
  lineId: z.uuid(),
})

const TermsForm = z.object({
  journeyId: z.uuid(),
  revisionId: z.uuid(),
  discountBdt: TakaField,
  inclusions: LinesField,
  exclusions: LinesField,
  terms: OptionalText(4000),
  travellerMessage: OptionalText(4000),
  validUntil: ValidUntilField,
})

const QuoteForm = z.object({ journeyId: z.uuid(), quoteId: z.uuid() })

/**
 * Where to send somebody when their post fails.
 *
 * The journey id comes off the raw FormData rather than the parsed result, since
 * the parse is what failed. A post with no readable id has no workbench to
 * return to, so it lands on the queue.
 */
function backTo(formData: FormData, message: string): never {
  const raw = formData.get('journeyId')
  const target =
    typeof raw === 'string' && raw !== '' ? `/journeys/${encodeURIComponent(raw)}` : '/journeys'

  redirect(`${target}?error=${encodeURIComponent(message)}`)
}

/** What a thrown service error says, without handing a stack to the page. */
function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'That did not work. Try again.'
}

function backWithNote(journeyId: string, message: string): never {
  revalidatePath(`/journeys/${journeyId}`)
  redirect(`/journeys/${journeyId}?done=${encodeURIComponent(message)}`)
}

/**
 * Start pricing, or pick up where the last version left off.
 *
 * Idempotent on purpose. Ops clicking twice, or arriving from a stale tab, gets
 * the same draft rather than a second one — the service returns the existing
 * unsent revision when there is one, and only starts a version when the last was
 * already sent.
 */
export async function openDraftAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  // Silently doing nothing would look like a successful save. Throwing lands on
  // the error boundary, which is the honest outcome for a post no holder of this
  // session should have been able to make.
  if (admin === null) throw new Error('Not permitted.')

  const parsed = QuoteForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, 'That quote could not be identified.')

  const { journeyId, quoteId } = parsed.data
  let version: number

  try {
    const draft = await openPricingDraft(quoteId, admin.adminUserId)
    version = draft.version
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'journey.quote.drafted',
    entityType: 'quote',
    entityId: quoteId,
    adminUserId: admin.adminUserId,
    after: { version },
  })

  backWithNote(journeyId, `Working on version ${version}. The traveller sees none of it yet.`)
}

/** The real vendor and the real price for one planned thing. */
export async function updateLineAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = LineForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, parsed.error.issues[0]?.message ?? 'Invalid input.')

  const { journeyId, revisionId, lineId, ...input } = parsed.data

  try {
    await updateLine(revisionId, lineId, input)
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'journey.quote.line.priced',
    entityType: 'quote_line_item',
    entityId: lineId,
    adminUserId: admin.adminUserId,
    // Vendor and figures only. The message to the traveller is their
    // conversation and does not belong in an ops audit payload.
    after: { vendorName: input.vendorName, priceBdt: input.priceBdt, quantity: input.quantity },
  })

  backWithNote(journeyId, `Saved "${input.label}".`)
}

/** Something nobody planned — a visa fee, an airport pickup, insurance. */
export async function addLineAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = AddLineForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, parsed.error.issues[0]?.message ?? 'Invalid input.')

  const { journeyId, revisionId, ...input } = parsed.data

  try {
    await addLine(revisionId, input)
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'journey.quote.line.added',
    entityType: 'quote_revision',
    entityId: revisionId,
    adminUserId: admin.adminUserId,
    after: { label: input.label, priceBdt: input.priceBdt },
  })

  backWithNote(journeyId, `Added "${input.label}".`)
}

/**
 * We are not quoting for this.
 *
 * The planned item does not disappear — it stays on the traveller's side of the
 * comparison with nothing beside it, which is the difference between them
 * noticing now and noticing at the airport.
 */
export async function removeLineAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = RemoveLineForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, 'That line could not be identified.')

  const { journeyId, revisionId, lineId } = parsed.data

  try {
    await removeLine(revisionId, lineId)
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'journey.quote.line.removed',
    entityType: 'quote_line_item',
    entityId: lineId,
    adminUserId: admin.adminUserId,
  })

  backWithNote(journeyId, 'Line removed. The traveller will see it was not quoted for.')
}

/** Discount, inclusions, terms, validity — everything that is not a line. */
export async function saveTermsAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = TermsForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, parsed.error.issues[0]?.message ?? 'Invalid input.')

  const { journeyId, revisionId, ...input } = parsed.data

  try {
    await saveTerms(revisionId, admin.adminUserId, input)
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'journey.quote.terms.saved',
    entityType: 'quote_revision',
    entityId: revisionId,
    adminUserId: admin.adminUserId,
    after: { discountBdt: input.discountBdt, validUntil: input.validUntil?.toISOString() ?? null },
  })

  backWithNote(journeyId, 'Terms saved. Still a draft.')
}

/**
 * THE IRREVERSIBLE ONE.
 *
 * Sending stamps `sentAt`, and from that moment a trigger refuses every change
 * to the revision AND to its lines — a correction has to be a new version. That
 * is the intended cost: it is the point at which the numbers stop being ours and
 * start being theirs.
 */
export async function sendQuoteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = QuoteForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, 'That quote could not be identified.')

  const { journeyId, quoteId } = parsed.data
  let version: number | null
  let totalBdt: number | null

  try {
    const quote = await sendQuote(quoteId)
    const latest = quote.revisions[0]
    version = latest?.version ?? null
    totalBdt = latest?.totalBdt ?? null
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'journey.quote.sent',
    entityType: 'quote',
    entityId: quoteId,
    adminUserId: admin.adminUserId,
    after: { version, totalBdt },
  })

  revalidatePath('/journeys')
  backWithNote(journeyId, `Version ${version ?? 1} is now with the traveller.`)
}

/**
 * Close a request we are not going to fulfil.
 *
 * Releases the one-open-quote-per-plan index so the traveller can ask again, and
 * hands the plan back as PLANNING so they can change it first. Without this a
 * request nobody can price sits open forever and locks somebody out of their own
 * trip.
 */
export async function withdrawQuoteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = QuoteForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, 'That quote could not be identified.')

  const { quoteId } = parsed.data

  try {
    await withdrawQuote(quoteId)
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'journey.quote.withdrawn',
    entityType: 'quote',
    entityId: quoteId,
    adminUserId: admin.adminUserId,
  })

  revalidatePath('/journeys')
  redirect(
    `/journeys?done=${encodeURIComponent('Withdrawn. The traveller can edit their plan and ask again.')}`
  )
}
