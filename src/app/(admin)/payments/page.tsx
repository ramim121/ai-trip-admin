import Link from 'next/link'
import { PaymentStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatBdt, formatDateTime } from '../_lib/format'

/**
 * /payments — every attempt, across every provider.
 *
 * The status filter is a query parameter rather than a client component,
 * because a filtered list should be a URL somebody can paste into a chat thread
 * when they are asking about it. An unrecognised `?status=` is ignored rather
 * than rejected: this is a filter, and the safe reading of a nonsense filter is
 * "no filter", not a 400 in the middle of an incident.
 *
 * Two columns are deliberately absent. `rawPayload` is a verbatim gateway body
 * with no business being rendered into a page, and `idempotencyKey` is what
 * stops a replayed callback granting twice. Neither belongs on a screen, and
 * neither is selected — so neither can leak later when somebody spreads the row
 * into a component.
 *
 * A row can have no traveller. `Payment.userId` detaches rather than cascades
 * on account deletion, precisely so the financial record survives; the column
 * says so instead of rendering an empty cell that reads like a bug.
 *
 * TEST ROWS ARE LOUD RATHER THAN HIDDEN. A sandbox payment granted a real
 * entitlement, so it belongs in this list — but it is not income, and an amount
 * column mixing the two is a revenue figure nobody can trust. Every `isTest` row
 * therefore carries a badge that is hard to skim past, and the filter above the
 * table can take them out entirely. The default view still shows everything,
 * because a filter that hides rows by default is a filter people forget is on.
 */

export const metadata = { title: 'Payments · Beyond Borders' }

const PAGE_SIZE = 100

const STATUSES = [
  PaymentStatus.INITIATED,
  PaymentStatus.PENDING,
  PaymentStatus.SUCCEEDED,
  PaymentStatus.FAILED,
  PaymentStatus.REFUNDED,
] as const

function isPaymentStatus(value: string): value is PaymentStatus {
  return Object.hasOwn(PaymentStatus, value)
}

/**
 * Whether sandbox rows are in view.
 *
 * `null` is "show everything" and is the default. As with `?status=`, an
 * unrecognised value falls back to no filter rather than to a 400 — the safe
 * reading of a nonsense filter is "no filter", and a 400 in the middle of an
 * incident helps nobody.
 */
type TestFilter = 'hide' | 'only' | null

function toTestFilter(value: string | null): TestFilter {
  return value === 'hide' || value === 'only' ? value : null
}

const TEST_FILTERS: { value: TestFilter; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'hide', label: 'Real money only' },
  { value: 'only', label: 'Test only' },
]

/** What an empty table means, given what is filtered. */
function emptyMessage(status: PaymentStatus | null, test: TestFilter): string {
  const clauses = [
    status === null ? null : `with status ${status}`,
    test === 'hide'
      ? 'taken by a real gateway'
      : test === 'only'
        ? 'from the sandbox gateway'
        : null,
  ].filter((clause): clause is string => clause !== null)

  return clauses.length === 0 ? 'No payments yet.' : `No payments ${clauses.join(' and ')}.`
}

/** Preserve the other filter when one of them changes. Both live in the URL. */
function paymentsHref(status: PaymentStatus | null, test: TestFilter): string {
  const params = new URLSearchParams()
  if (status !== null) params.set('status', status)
  if (test !== null) params.set('test', test)

  const query = params.toString()
  return query === '' ? '/payments' : `/payments?${query}`
}

/** Colour carries meaning here, so it is always paired with the word, never alone. */
const STATUS_CLASS: Record<PaymentStatus, string> = {
  INITIATED: 'text-zinc-600 dark:text-zinc-400',
  PENDING: 'text-amber-700 dark:text-amber-400',
  SUCCEEDED: 'text-emerald-700 dark:text-emerald-400',
  FAILED: 'text-red-700 dark:text-red-400',
  REFUNDED: 'text-violet-700 dark:text-violet-400',
}

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const query = await searchParams
  const raw = typeof query.status === 'string' ? query.status : null
  const status = raw !== null && isPaymentStatus(raw) ? raw : null
  const test = toTestFilter(typeof query.test === 'string' ? query.test : null)

  const where = {
    ...(status === null ? {} : { status }),
    ...(test === null ? {} : { isTest: test === 'only' }),
  }

  const [payments, testCount] = await Promise.all([
    db.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      select: {
        id: true,
        provider: true,
        purpose: true,
        amountBdt: true,
        status: true,
        providerRef: true,
        isTest: true,
        createdAt: true,
        settledAt: true,
        user: { select: { email: true, name: true } },
      },
    }),
    /*
     * Counted across the WHOLE table, not just this page and not just the
     * current filter.
     *
     * The number that matters is "how many rows in here are not money", and it
     * has to be visible even while looking at a filtered view — otherwise the
     * one state in which somebody most needs the warning ("Real money only") is
     * the state in which it disappears.
     */
    db.payment.count({ where: { isTest: true } }),
  ])

  const tabClass = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${
      active
        ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
        : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-400'
    }`

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Payments</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        The {PAGE_SIZE} most recent attempts{status === null ? '' : ` with status ${status}`}. A
        gateway reference appears once the provider has acknowledged the attempt.
      </p>

      {/*
       * Said before the table rather than only inside it. Somebody totalling
       * this column by eye needs to know the sandbox rows exist BEFORE they
       * start, not after they meet one halfway down.
       */}
      {testCount > 0 && (
        <p className="mt-3 max-w-prose rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">{testCount}</span>{' '}
          {testCount === 1 ? 'payment was' : 'payments were'} taken by the sandbox gateway. No money
          moved, but each granted a real entitlement. Exclude them from any revenue figure — use
          &ldquo;Real money only&rdquo; below.
        </p>
      )}

      <nav className="mt-4 flex flex-wrap gap-2">
        <Link href={paymentsHref(null, test)} className={tabClass(status === null)}>
          All
        </Link>
        {STATUSES.map((value) => (
          <Link key={value} href={paymentsHref(value, test)} className={tabClass(status === value)}>
            {value}
          </Link>
        ))}
      </nav>

      <nav className="mt-2 flex flex-wrap gap-2">
        {TEST_FILTERS.map((option) => (
          <Link
            key={option.label}
            href={paymentsHref(status, option.value)}
            className={tabClass(test === option.value)}
          >
            {option.label}
          </Link>
        ))}
      </nav>

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium">Traveller</th>
              <th className="px-4 py-3 font-medium">Purpose</th>
              <th className="px-4 py-3 font-medium">Provider</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Settled</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {payments.map((payment) => (
              <tr key={payment.id}>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {formatDateTime(payment.createdAt)}
                </td>
                <td className="px-4 py-3">
                  {payment.user === null ? (
                    <span className="text-zinc-500 dark:text-zinc-400">account removed</span>
                  ) : (
                    <>
                      <div className="font-medium">{payment.user.name}</div>
                      <div className="text-xs text-zinc-500 dark:text-zinc-400">
                        {payment.user.email}
                      </div>
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{payment.purpose}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span>{payment.provider}</span>
                    {payment.isTest && (
                      <span
                        className="rounded border border-amber-500 bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-bold tracking-wide text-amber-900 uppercase dark:border-amber-500/70 dark:bg-amber-900/50 dark:text-amber-200"
                        title="Sandbox payment — no money moved, but a real entitlement was granted."
                      >
                        Test
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {payment.providerRef ?? '—'}
                  </div>
                </td>
                {/*
                 * Struck through on a test row. Colour alone would fail anyone
                 * who cannot see it and anyone printing the page, and the badge
                 * two columns to the left is easy to lose in a long table — this
                 * marks the number itself as not-money, which is the only figure
                 * on the row anybody is going to add up.
                 */}
                <td
                  className={`px-4 py-3 tabular-nums ${
                    payment.isTest ? 'text-zinc-400 line-through dark:text-zinc-500' : ''
                  }`}
                >
                  {formatBdt(payment.amountBdt)}
                </td>
                <td className={`px-4 py-3 ${STATUS_CLASS[payment.status]}`}>{payment.status}</td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {formatDateTime(payment.settledAt)}
                </td>
              </tr>
            ))}

            {payments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  {/*
                   * Names the filters in force. "No payments yet" under an
                   * active filter is a lie that sends somebody looking for a
                   * bug — particularly "Real money only", where an empty table
                   * is the expected result on a development database.
                   */}
                  {emptyMessage(status, test)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
