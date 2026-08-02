import Link from 'next/link'
import { QuoteStatus } from '@/generated/prisma/enums'
import { listQuoteQueue } from '@/server/modules/quotes/service'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatBdt, formatDateTime } from '../_lib/format'

/**
 * /quotes — trips waiting on a price.
 *
 * OLDEST FIRST, and that ordering is the point of the screen. Every other list
 * in this console is newest-first, because there the recent row is the
 * interesting one. A work queue sorted that way is a queue where the request
 * nobody has answered sinks quietly out of sight while the top of the page stays
 * busy. The request that has waited longest is the one that most needs somebody.
 *
 * ONLY OPEN QUOTES ARE HERE. Accepted, declined and withdrawn quotes are
 * finished conversations — they live on the itinerary and in the audit log, and
 * keeping them in the queue would mean the queue never empties and so stops
 * being readable as a list of work.
 *
 * The waiting column is measured against one timestamp taken per render rather
 * than per row, so every age on the page is measured from the same instant.
 */

export const metadata = { title: 'Quotes · Beyond Borders' }

const PAGE_SIZE = 100

/** How long this has sat. Colour is always paired with the words, never alone. */
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
 * The enum name alone will not do here: PRICED and SENT differ by exactly the
 * thing that matters — whether the traveller can see it — and "PRICED" on its
 * own reads as finished when it means the opposite.
 */
const STATUS_META: Record<
  'REQUESTED' | 'PRICED' | 'SENT',
  { label: string; hint: string; className: string }
> = {
  REQUESTED: {
    label: 'Needs a price',
    hint: 'Nobody has quoted this yet.',
    className: 'text-red-700 dark:text-red-400',
  },
  PRICED: {
    label: 'Draft ready',
    hint: 'Priced but not sent — the traveller cannot see it.',
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

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const query = await searchParams
  const done = typeof query.done === 'string' ? query.done : null
  const error = typeof query.error === 'string' ? query.error : null

  const quotes = await listQuoteQueue(PAGE_SIZE)
  // One clock read for the whole page, matching the other console screens, so
  // every age below is measured from the same instant.
  const now = new Date().getTime()

  const unpriced = quotes.filter((quote) => quote.status === QuoteStatus.REQUESTED)

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Quotes</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Open requests only, oldest first — the one that has waited longest is at the top. Finished
        quotes leave this list; they stay on the itinerary and in the audit log.
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

      {unpriced.length > 0 && (
        <p className="mt-3 max-w-prose rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">{unpriced.length}</span>{' '}
          {unpriced.length === 1 ? 'request has' : 'requests have'} no price at all yet.
        </p>
      )}

      {quotes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          Nothing waiting. Every quote that has been asked for has been answered.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <table className="w-full min-w-[60rem] border-collapse text-sm">
            <thead className="border-b border-zinc-200 text-left text-xs tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3 font-medium">Waiting</th>
                <th className="px-4 py-3 font-medium">Traveller</th>
                <th className="px-4 py-3 font-medium">Trip</th>
                <th className="px-4 py-3 font-medium">Party</th>
                <th className="px-4 py-3 font-medium">Latest price</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Asked</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {quotes.map((quote) => {
                const age = describeAge(quote.requestedAt, now)
                const latest = quote.revisions[0]
                const meta = isQueueStatus(quote.status) ? STATUS_META[quote.status] : null

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
                    </td>

                    <td className="px-4 py-3">
                      <Link
                        href={`/quotes/${quote.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {quote.itinerary?.title ?? 'Trip deleted'}
                      </Link>
                      {quote.itinerary !== null && (
                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                          {quote.itinerary.destinationLabel} · {quote.itinerary.totalDays}{' '}
                          {quote.itinerary.totalDays === 1 ? 'day' : 'days'}
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3 tabular-nums">{quote.itinerary?.partySize ?? '—'}</td>

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
