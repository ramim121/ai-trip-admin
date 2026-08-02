'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { recordAudit } from '@/server/audit/log'
import { priceQuote, sendQuote, withdrawQuote } from '@/server/modules/quotes/service'
import { QUOTE_WRITE_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'

/**
 * Pricing a trip by hand.
 *
 * A server action is an HTTP endpoint with a generated URL, not a function call.
 * Anyone who can reach the console can post to one whether or not the form that
 * binds it ever rendered for them, so the role check in each action below is not
 * a duplicate of the page's: the page's check controls what is DISPLAYED, this
 * one is the only thing controlling what is WRITTEN.
 *
 * NO TOTAL IS ACCEPTED FROM THE FORM. Subtotal and discount come in, the service
 * computes `total = subtotal - discount`, and a CHECK constraint refuses the row
 * if the two ever disagree. A hidden total field would be a number the browser
 * gets to choose.
 *
 * Outcomes travel back as `?error=` or `?done=` on a redirect rather than as a
 * returned object, because this console ships no client JavaScript and there is
 * no `useActionState` to receive one. The whole page re-renders from the
 * database, so what ops reads after a save is the saved row rather than the form
 * they submitted.
 */

/**
 * Whole taka.
 *
 * `z.coerce.number()` would take "12000.75" and let Postgres round it into the
 * Int column silently, so the integer check is explicit — the same reasoning the
 * plan editor's `PriceField` states. Money is whole taka everywhere in this
 * codebase, and a fractional input is a mistake rather than a value to round.
 */
const TakaField = z
  .string()
  .trim()
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value >= 0, {
    message: 'Prices must be a whole number of taka, zero or more.',
  })

/**
 * One item per line.
 *
 * A textarea rather than a repeating field set, because ops writes these as
 * prose and pasting five lines out of an email is the common case. Blank lines
 * are dropped so a trailing newline does not become an empty bullet on the
 * traveller's quote.
 */
const LinesField = z
  .string()
  .max(4000)
  .transform((value) =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  )

/** An empty text input means "nothing here", which is null rather than "". */
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))

/**
 * `<input type="date">` posts `YYYY-MM-DD`, or an empty string.
 *
 * Parsed to the END of that day in Dhaka rather than its midnight. A quote
 * marked valid until the 20th should still be acceptable at 5pm on the 20th;
 * taking the date at face value expires it the instant the 20th begins, a full
 * day earlier than the traveller was told. +06:00 is Bangladesh's offset and it
 * observes no daylight saving, so the fixed suffix is correct year-round.
 */
const ValidUntilField = z
  .string()
  .trim()
  .transform((value) => (value === '' ? null : new Date(`${value}T23:59:59+06:00`)))
  .refine((value) => value === null || !Number.isNaN(value.getTime()), {
    message: 'That is not a date we can read.',
  })

const PriceForm = z.object({
  quoteId: z.uuid(),
  subtotalBdt: TakaField,
  discountBdt: TakaField,
  inclusions: LinesField,
  exclusions: LinesField,
  terms: OptionalText(4000),
  travellerMessage: OptionalText(4000),
  validUntil: ValidUntilField,
})

const QuoteIdForm = z.object({ quoteId: z.uuid() })

/**
 * Where to send somebody when their post fails.
 *
 * The quote id comes off the raw FormData rather than the parsed result, since
 * the parse is what failed. A post with no readable id has no detail page to go
 * back to, so it lands on the queue.
 */
function backTo(formData: FormData, message: string): never {
  const raw = formData.get('quoteId')
  const target = typeof raw === 'string' && raw !== '' ? `/quotes/${encodeURIComponent(raw)}` : '/quotes'
  redirect(`${target}?error=${encodeURIComponent(message)}`)
}

/** What a thrown service error says, without handing a stack to the page. */
function describe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return 'That did not work. Try again.'
}

/**
 * Save the numbers as a draft.
 *
 * Drafting and redrafting are one action — the service updates the current
 * unsent revision when there is one and creates the next version when there is
 * not, so ops never has to decide which of the two they are doing. Nothing here
 * is visible to the traveller until `sendQuoteAction` runs.
 */
export async function priceQuoteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  // Silently doing nothing would look like a successful save. Throwing lands on
  // the error boundary, which is the honest outcome for a post that no holder of
  // this session should have been able to make.
  if (admin === null) throw new Error('Not permitted.')

  const parsed = PriceForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, parsed.error.issues[0]?.message ?? 'Invalid input.')

  const { quoteId, ...input } = parsed.data
  let version: number

  try {
    const quote = await priceQuote(quoteId, admin.adminUserId, input)
    version = quote.revisions[0]?.version ?? 1
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'quote.priced',
    entityType: 'quote',
    entityId: quoteId,
    adminUserId: admin.adminUserId,
    // Identifiers and figures only. The message to the traveller is their
    // conversation and does not belong in an ops audit payload.
    after: { version, subtotalBdt: input.subtotalBdt, discountBdt: input.discountBdt },
  })

  revalidatePath('/quotes')
  redirect(`/quotes/${quoteId}?done=${encodeURIComponent(`Saved as version ${version}. Not sent yet.`)}`)
}

/**
 * Show the traveller the price.
 *
 * THE IRREVERSIBLE ONE. Sending stamps `sentAt`, and from that moment a database
 * trigger refuses every change to the revision — a correction has to be a new
 * version. That is the intended cost: it is the point at which the number stops
 * being ours and starts being theirs.
 */
export async function sendQuoteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = QuoteIdForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, 'That quote could not be identified.')

  const { quoteId } = parsed.data
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
    action: 'quote.sent',
    entityType: 'quote',
    entityId: quoteId,
    adminUserId: admin.adminUserId,
    after: { version, totalBdt },
  })

  revalidatePath('/quotes')
  redirect(
    `/quotes/${quoteId}?done=${encodeURIComponent(`Version ${version ?? 1} is now with the traveller.`)}`
  )
}

/**
 * Close a request we are not going to fulfil.
 *
 * Releases the one-open-quote-per-trip index so the traveller can ask again.
 * Without it, a request ops cannot price sits open forever and locks somebody
 * out of their own itinerary — the service has the longer version.
 */
export async function withdrawQuoteAction(formData: FormData): Promise<void> {
  const admin = await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)
  if (admin === null) throw new Error('Not permitted.')

  const parsed = QuoteIdForm.safeParse(Object.fromEntries(formData))
  if (!parsed.success) backTo(formData, 'That quote could not be identified.')

  const { quoteId } = parsed.data

  try {
    await withdrawQuote(quoteId)
  } catch (error) {
    backTo(formData, describe(error))
  }

  await recordAudit({
    action: 'quote.withdrawn',
    entityType: 'quote',
    entityId: quoteId,
    adminUserId: admin.adminUserId,
  })

  revalidatePath('/quotes')
  redirect(
    `/quotes?done=${encodeURIComponent('Withdrawn. The traveller can ask again when they are ready.')}`
  )
}
