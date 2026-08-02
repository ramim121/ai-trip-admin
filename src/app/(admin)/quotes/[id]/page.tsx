import Link from 'next/link'
import { notFound } from 'next/navigation'
import { QuoteStatus } from '@/generated/prisma/enums'
import { readQuote, readQuoteTrip } from '@/server/modules/quotes/service'
import { Locked } from '../../_components/locked'
import {
  COMMERCE_READ_ROLES,
  QUOTE_WRITE_ROLES,
  readConsoleAdminWithRole,
} from '../../_lib/console-session'
import { formatBdt, formatDateTime } from '../../_lib/format'
import { priceQuoteAction, sendQuoteAction, withdrawQuoteAction } from '../actions'

/**
 * /quotes/[id] — price one trip.
 *
 * THE WHOLE SCREEN IS ARRANGED AROUND ONE DISTINCTION: a draft is invisible to
 * the traveller, and a sent version is permanent. Saving and sending are two
 * separate buttons for that reason and never one "save and send" — the first is
 * free to get wrong and the second cannot be taken back, so collapsing them
 * would turn every typo into a new version in somebody's inbox.
 *
 * WRITE ACCESS IS CHECKED HERE AND AGAIN IN EVERY ACTION. This check decides
 * what is DISPLAYED; the action's decides what is WRITTEN. A colleague who may
 * read commerce but not price gets the trip and the history without the form,
 * which is the useful outcome rather than a locked page.
 *
 * The form is pre-filled from the current DRAFT only. Pre-filling from a sent
 * version would put an immutable revision's numbers in an editable box, and the
 * first thing anybody would do is edit them and be refused by a trigger.
 */

export const metadata = { title: 'Quote · Beyond Borders' }

const MINUTES_IN_HOUR = 60

/** Minutes from local midnight as a clock time. A block past midnight wraps. */
function formatMinute(minute: number): string {
  const hour = Math.floor(minute / MINUTES_IN_HOUR) % 24
  const rest = minute % MINUTES_IN_HOUR
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

/** A `@db.Date` as the calendar date it is — the bookings screen explains the UTC pin. */
function formatTripDate(value: Date | null): string {
  if (value === null) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value)
}

/**
 * `<input type="date">` wants `YYYY-MM-DD`.
 *
 * Formatted in Dhaka, matching how `ValidUntilField` parses it back. `en-CA` is
 * used because it is the locale that natively renders ISO order — building the
 * string from `getFullYear()` and friends would read the server's zone instead.
 */
function toDateInput(value: Date | null): string {
  if (value === null) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}

const FIELD =
  'mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950'
const LABEL = 'block text-sm font-medium'
const HINT = 'mt-1 text-xs text-zinc-500 dark:text-zinc-400'

export default async function QuoteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const canWrite = (await readConsoleAdminWithRole(QUOTE_WRITE_ROLES)) !== null
  const canRead = canWrite || (await readConsoleAdminWithRole(COMMERCE_READ_ROLES)) !== null
  if (!canRead) return <Locked />

  const [{ id }, query] = await Promise.all([params, searchParams])
  const done = typeof query.done === 'string' ? query.done : null
  const error = typeof query.error === 'string' ? query.error : null

  // `readQuote` throws a 404-shaped error for an id that is not there; on this
  // screen that is Next's notFound rather than an error boundary.
  const quote = await readQuote(id).catch(() => null)
  if (quote === null) notFound()

  const trip = quote.itineraryId === null ? null : await readQuoteTrip(quote.itineraryId)

  const latest = quote.revisions[0]
  const draft = latest !== undefined && latest.sentAt === null ? latest : null
  const sent = quote.revisions.filter((revision) => revision.sentAt !== null)

  const isOpen =
    quote.status === QuoteStatus.REQUESTED ||
    quote.status === QuoteStatus.PRICED ||
    quote.status === QuoteStatus.SENT

  /*
   * What the planner reckoned, before anybody looked at it.
   *
   * A starting figure, labelled as one. Ops is pricing hotels, transport and
   * margin the planner knows nothing about, so presenting this as the cost would
   * mislead — but making somebody add up a week of activities by hand to find
   * the floor is worse. Nulls count as nothing here, which is right for a sum
   * and is why the per-row rendering below still distinguishes them.
   */
  const estimate =
    trip?.days.reduce(
      (sum, day) => sum + day.blocks.reduce((dayTotal, b) => dayTotal + (b.costBdt ?? 0), 0),
      0
    ) ?? 0

  return (
    <section className="max-w-5xl">
      <Link
        href="/quotes"
        className="text-sm text-zinc-600 underline-offset-4 hover:underline dark:text-zinc-400"
      >
        ← Back to the queue
      </Link>

      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        {quote.itinerary?.title ?? 'Trip deleted'}
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {quote.itinerary === null ? (
          'The itinerary behind this quote has been deleted. The quote is kept for the record.'
        ) : (
          <>
            {quote.itinerary.destinationLabel} · {quote.itinerary.totalDays}{' '}
            {quote.itinerary.totalDays === 1 ? 'day' : 'days'} · {quote.itinerary.partySize}{' '}
            {quote.itinerary.partySize === 1 ? 'traveller' : 'travellers'}
            {trip !== null && trip.startDate !== null && (
              <>
                {' · '}
                {formatTripDate(trip.startDate)} to {formatTripDate(trip.endDate)}
              </>
            )}
          </>
        )}
      </p>

      {done !== null && (
        <p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {done}
        </p>
      )}

      {error !== null && (
        <p className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      <dl className="mt-6 grid gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-sm sm:grid-cols-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Status
          </dt>
          <dd className="mt-1 font-medium">{quote.status.toLowerCase()}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Asked
          </dt>
          <dd className="mt-1">{formatDateTime(quote.requestedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Planner estimate
          </dt>
          <dd className="mt-1 tabular-nums">{formatBdt(estimate)}</dd>
          <p className={HINT}>Activities only. No hotels, transport or margin.</p>
        </div>
      </dl>

      {quote.travellerNote !== null && (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-xs tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            What they said
          </h2>
          <p className="mt-2 text-sm whitespace-pre-wrap">{quote.travellerNote}</p>
        </div>
      )}

      {/* ── The trip, day by day ─────────────────────────────────────────── */}
      {trip !== null && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold dark:border-zinc-800">
            What they planned
          </h2>

          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {trip.days.map((day) => (
              <div key={day.id} className="px-4 py-3">
                <h3 className="text-sm font-medium">
                  Day {day.dayNumber}
                  {day.title !== null && (
                    <span className="text-zinc-500 dark:text-zinc-400"> · {day.title}</span>
                  )}
                </h3>

                {day.blocks.length === 0 ? (
                  <p className="mt-1 text-xs text-zinc-500 italic dark:text-zinc-400">
                    Nothing planned for this day.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {day.blocks.map((block) => (
                      <li key={block.id} className="flex gap-3 text-sm">
                        <span className="w-24 shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                          {formatMinute(block.startMinute)}–{formatMinute(block.endMinute)}
                        </span>
                        <span className="flex-1">
                          {block.title}
                          <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                            {block.kind.toLowerCase()}
                            {block.transitMode !== null && ` · ${block.transitMode.toLowerCase()}`}
                          </span>
                          {/* The catalogue's own words about its price. "Per
                              boat" or "entry only" changes what a party of six
                              costs, and it is not recoverable from the block. */}
                          {block.activity?.priceNote != null && (
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                              {block.activity.priceNote}
                              {block.activity.pricePerPersonBdt !== null &&
                                ` · ${formatBdt(block.activity.pricePerPersonBdt)} pp`}
                            </span>
                          )}
                        </span>
                        <span className="w-24 shrink-0 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                          {/* Absent, not zero. A free activity and an unpriced
                              one are different facts, and the person building a
                              quote is exactly who needs to tell them apart. */}
                          {block.costBdt === null ? '—' : formatBdt(block.costBdt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Versions already sent ────────────────────────────────────────── */}
      {sent.length > 0 && (
        <div className="mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold dark:border-zinc-800">
            Already sent
          </h2>

          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {sent.map((revision) => (
              <div key={revision.id} className="px-4 py-3 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">Version {revision.version}</span>
                  <span className="tabular-nums">{formatBdt(revision.totalBdt)}</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    sent {formatDateTime(revision.sentAt)}
                    {revision.validUntil !== null &&
                      ` · valid until ${formatDateTime(revision.validUntil)}`}
                  </span>
                </div>
                {revision.discountBdt > 0 && (
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {formatBdt(revision.subtotalBdt)} less {formatBdt(revision.discountBdt)} discount
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── The form ─────────────────────────────────────────────────────── */}
      {!canWrite ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          You can read this quote but not price it.
        </p>
      ) : !isOpen ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          This quote was {quote.status.toLowerCase()}
          {quote.decidedAt !== null && ` on ${formatDateTime(quote.decidedAt)}`}. There is nothing
          left to price.
        </p>
      ) : (
        <>
          <form action={priceQuoteAction} className="mt-6">
            <input type="hidden" name="quoteId" value={quote.id} />

            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-sm font-semibold">
                {draft === null
                  ? `Draft version ${(latest?.version ?? 0) + 1}`
                  : `Editing draft version ${draft.version}`}
              </h2>
              <p className={HINT}>
                Nothing here reaches the traveller until you send it. Saving as many times as you
                like costs nothing.
              </p>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="subtotalBdt">
                    Subtotal (BDT)
                  </label>
                  <input
                    className={FIELD}
                    id="subtotalBdt"
                    name="subtotalBdt"
                    type="number"
                    min={0}
                    step={1}
                    required
                    defaultValue={draft?.subtotalBdt ?? ''}
                  />
                  <p className={HINT}>Everything before discount. Whole taka.</p>
                </div>

                <div>
                  <label className={LABEL} htmlFor="discountBdt">
                    Discount (BDT)
                  </label>
                  <input
                    className={FIELD}
                    id="discountBdt"
                    name="discountBdt"
                    type="number"
                    min={0}
                    step={1}
                    required
                    defaultValue={draft?.discountBdt ?? 0}
                  />
                  {/* There is no total field on purpose. The server computes it
                      and a CHECK constraint refuses the row if the arithmetic
                      ever disagrees. */}
                  <p className={HINT}>The total is subtotal less this, worked out on save.</p>
                </div>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="inclusions">
                    What the price covers
                  </label>
                  <textarea
                    className={FIELD}
                    id="inclusions"
                    name="inclusions"
                    rows={5}
                    defaultValue={draft?.inclusions.join('\n') ?? ''}
                  />
                  <p className={HINT}>One per line.</p>
                </div>

                <div>
                  <label className={LABEL} htmlFor="exclusions">
                    What it does not
                  </label>
                  <textarea
                    className={FIELD}
                    id="exclusions"
                    name="exclusions"
                    rows={5}
                    defaultValue={draft?.exclusions.join('\n') ?? ''}
                  />
                  <p className={HINT}>
                    One per line. Worth being generous here — this is the list that prevents an
                    argument later.
                  </p>
                </div>
              </div>

              <div className="mt-4">
                <label className={LABEL} htmlFor="travellerMessage">
                  Message to the traveller
                </label>
                <textarea
                  className={FIELD}
                  id="travellerMessage"
                  name="travellerMessage"
                  rows={3}
                  defaultValue={draft?.travellerMessage ?? ''}
                />
                <p className={HINT}>Shown with the price. Leave blank for none.</p>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={LABEL} htmlFor="terms">
                    Terms
                  </label>
                  <textarea
                    className={FIELD}
                    id="terms"
                    name="terms"
                    rows={3}
                    defaultValue={draft?.terms ?? ''}
                  />
                </div>

                <div>
                  <label className={LABEL} htmlFor="validUntil">
                    Hold this price until
                  </label>
                  <input
                    className={FIELD}
                    id="validUntil"
                    name="validUntil"
                    type="date"
                    defaultValue={toDateInput(draft?.validUntil ?? null)}
                  />
                  <p className={HINT}>
                    Runs to the end of that day, Dhaka time. Blank means no stated expiry.
                  </p>
                </div>
              </div>

              <button
                type="submit"
                className="mt-5 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                Save draft
              </button>
            </div>
          </form>

          <div className="mt-4 flex flex-wrap gap-3">
            {/* SEPARATE FORMS, not extra buttons inside the one above. A second
                submit button in that form would post the whole draft, so "send"
                would silently save whatever was on screen first — including an
                edit somebody was halfway through typing. */}
            <form action={sendQuoteAction}>
              <input type="hidden" name="quoteId" value={quote.id} />
              <button
                type="submit"
                disabled={draft === null}
                className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send version {draft?.version ?? latest?.version ?? 1} to the traveller
              </button>
            </form>

            <form action={withdrawQuoteAction}>
              <input type="hidden" name="quoteId" value={quote.id} />
              <button
                type="submit"
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
              >
                Withdraw
              </button>
            </form>
          </div>

          <p className={`${HINT} mt-2`}>
            {draft === null
              ? 'There is no unsent draft, so there is nothing to send. Save one above first.'
              : 'Sending is permanent — that version can never be edited afterwards, only replaced by a newer one.'}{' '}
            Withdrawing closes the request and lets the traveller ask again.
          </p>
        </>
      )}
    </section>
  )
}
