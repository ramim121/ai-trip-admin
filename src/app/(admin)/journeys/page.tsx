import Link from 'next/link'
import { QuoteStatus } from '@/generated/prisma/enums'
import { listJourneyQuoteQueue } from '@/server/modules/journey/quotation'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatBdt, formatDateTime } from '../_lib/format'

/**
 * /journeys — plans waiting on a price.
 *
 * SEPARATE FROM /quotes, and not for tidiness. Pricing an itinerary is typing
 * one total against a trip somebody else assembled. Pricing a plan is going
 * through fifteen lines and saying, for each, which hotel and which boat and
 * what it really costs — a different job, done on a different screen, against a
 * different table. Mixing the queues would put a row on /quotes whose workbench
 * cannot price it.
 *
 * OLDEST FIRST, as every work queue here is. A queue sorted newest-first is a
 * queue where the request nobody has answered sinks quietly out of sight while
 * the top of the page stays busy.
 *
 * THE BUDGET COLUMN IS THE ONE OPS READS FIRST. It is what the traveller said
 * they had, and every line they are about to be quoted is measured against it. A
 * plan whose own estimates already sit above the band is a conversation to have
 * before pricing it rather than after.
 */

export const metadata = { title: 'Plan quotes · Beyond Borders' }

const PAGE_SIZE = 100

/** How long this has sat. Colour is always paired with words, never alone. */
const AGE_CLASS = {
  fresh: 'text-zinc-600 dark:text-zinc-400',
  aging: 'text-amber-700 dark:text-amber-400',
  overdue: 'text-red-700 dark:text-red-400',
} as const

const HOUR = 60 * 60 * 1000
const AGING_AFTER = 24 * HOUR
const OVERDUE_AFTER = 72 * HOUR

function describeAge(
  requestedAt: Date,
  now: number
): { text: string; tone: keyof typeof AGE_CLASS } {
  const elapsed = now - requestedAt.getTime()
  const hours = Math.floor(elapsed / HOUR)
  const tone = elapsed >= OVERDUE_AFTER ? 'overdue' : elapsed >= AGING_AFTER ? 'aging' : 'fresh'

  if (hours < 1) return { text: 'under an hour', tone }
  if (hours < 24) return { text: `${hours}h`, tone }

  const days = Math.floor(hours / 24)
  return { text: `${days}d ${hours % 24}h`, tone }
}

/**
 * What the status means to the person reading the queue.
 *
 * The enum name alone will not do: PRICED and SENT differ by exactly the thing
 * that matters — whether the traveller can see it — and "PRICED" on its own
 * reads as finished when it means the opposite.
 */
const STATUS_META: Record<
  'REQUESTED' | 'PRICED' | 'SENT',
  { label: string; hint: string; className: string }
> = {
  REQUESTED: {
    label: 'Needs pricing',
    hint: 'Nobody has opened this yet.',
    className: 'text-red-700 dark:text-red-400',
  },
  PRICED: {
    label: 'Draft in progress',
    hint: 'Lines exist but nothing has been sent.',
    className: 'text-amber-700 dark:text-amber-400',
  },
  SENT: {
    label: 'With traveller',
    hint: 'Waiting on their answer.',
    className: 'text-emerald-700 dark:text-emerald-400',
  },
}

function isQueueStatus(value: QuoteStatus): value is keyof typeof STATUS_META {
  return (
    value === QuoteStatus.REQUESTED || value === QuoteStatus.PRICED || value === QuoteStatus.SENT
  )
}

/** The band the traveller gave, or an honest blank. */
function describeBudget(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'not stated'
  if (min === null) return `up to ${formatBdt(max ?? 0)}`
  if (max === null) return `${formatBdt(min)}+`
  return `${formatBdt(min)} – ${formatBdt(max)}`
}

export default async function JourneyQuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const query = await searchParams
  const done = typeof query.done === 'string' ? query.done : null
  const error = typeof query.error === 'string' ? query.error : null

  const quotes = await listJourneyQuoteQueue(PAGE_SIZE)
  // One clock read for the whole page, so every age below is measured from the
  // same instant rather than drifting row by row.
  const now = new Date().getTime()

  const untouched = quotes.filter((quote) => quote.status === QuoteStatus.REQUESTED)

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Plan quotes</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Trips built in the planner, waiting on real prices. Open one to see what the traveller chose
        beside what they asked for, and put a vendor and a figure against every line.
      </p>

      {done !== null && (
        <p className="mt-3 max-w-prose rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          {done}
        </p>
      )}

      {error !== null && (
        <p className="mt-3 max-w-prose rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700/60 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {untouched.length > 0 && (
        <p className="mt-3 max-w-prose rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">{untouched.length}</span>{' '}
          {untouched.length === 1 ? 'plan has' : 'plans have'} not been opened yet.
        </p>
      )}

      {quotes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Nothing waiting. Every plan somebody asked us to price has been answered.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[68rem] border-collapse text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3 font-medium">Waiting</th>
                <th className="px-4 py-3 font-medium">Traveller</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Party</th>
                <th className="px-4 py-3 font-medium">Their budget</th>
                <th className="px-4 py-3 font-medium">Our latest</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Asked</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {quotes.map((quote) => {
                const age = describeAge(quote.requestedAt, now)
                const latest = quote.revisions[0]
                const meta = isQueueStatus(quote.status) ? STATUS_META[quote.status] : null
                const journey = quote.journey

                return (
                  <tr key={quote.id}>
                    <td className={`px-4 py-3 font-medium whitespace-nowrap ${AGE_CLASS[age.tone]}`}>
                      {age.text}
                    </td>

                    <td className="px-4 py-3">
                      {/* `userId` is nullable so a quote survives an account
                          deletion. Saying so beats an empty cell that reads
                          like a bug. */}
                      {quote.user === null ? (
                        <span className="text-xs text-zinc-500 italic dark:text-zinc-400">
                          account removed
                        </span>
                      ) : (
                        <>
                          <div className="font-medium">{quote.user.name ?? 'No name given'}</div>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            {quote.user.email}
                          </div>
                        </>
                      )}
                      {journey?.contactWhatsapp != null && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          WhatsApp {journey.contactWhatsapp}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      {journey === null ? (
                        <span className="text-zinc-500 dark:text-zinc-400">Plan deleted</span>
                      ) : (
                        <>
                          <Link
                            href={`/journeys/${journey.id}`}
                            className="font-medium underline-offset-4 hover:underline"
                          >
                            {journey.title ?? journey.destinations.join(', ')}
                          </Link>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            {journey.destinations.join(' → ')} · {journey.durationDays}{' '}
                            {journey.durationDays === 1 ? 'day' : 'days'} · {journey._count.items}{' '}
                            {journey._count.items === 1 ? 'item' : 'items'}
                          </div>
                        </>
                      )}
                    </td>

                    <td className="px-4 py-3 tabular-nums">
                      {journey === null ? '—' : journey.partyAdults + journey.partyChildren}
                      {journey !== null && journey.partyChildren > 0 && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {journey.partyChildren}{' '}
                          {journey.partyChildren === 1 ? 'child' : 'children'}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3 tabular-nums whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                      {journey === null
                        ? '—'
                        : describeBudget(journey.budgetMinBdt, journey.budgetMaxBdt)}
                    </td>

                    <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                      {latest === undefined ? (
                        <span className="text-zinc-500 dark:text-zinc-400">—</span>
                      ) : (
                        <>
                          {formatBdt(latest.totalBdt)}
                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                            v{latest.version}
                            {latest.sentAt === null && ' · draft'}
                          </div>
                        </>
                      )}
                    </td>

                    <td className="px-4 py-3">
                      <span className={`font-medium ${meta?.className ?? ''}`}>
                        {meta?.label ?? quote.status}
                      </span>
                      {meta !== null && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">{meta.hint}</div>
                      )}
                    </td>

                    <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                      {formatDateTime(quote.requestedAt)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
