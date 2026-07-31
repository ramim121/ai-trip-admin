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

  const payments = await db.payment.findMany({
    where: status === null ? undefined : { status },
    orderBy: { createdAt: 'desc' },
    take: PAGE_SIZE,
    select: {
      id: true,
      provider: true,
      purpose: true,
      amountBdt: true,
      status: true,
      providerRef: true,
      createdAt: true,
      settledAt: true,
      user: { select: { email: true, name: true } },
    },
  })

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

      <nav className="mt-4 flex flex-wrap gap-2">
        <Link href="/payments" className={tabClass(status === null)}>
          All
        </Link>
        {STATUSES.map((value) => (
          <Link
            key={value}
            href={`/payments?status=${value}`}
            className={tabClass(status === value)}
          >
            {value}
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
                  <div>{payment.provider}</div>
                  <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {payment.providerRef ?? '—'}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums">{formatBdt(payment.amountBdt)}</td>
                <td className={`px-4 py-3 ${STATUS_CLASS[payment.status]}`}>{payment.status}</td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  {formatDateTime(payment.settledAt)}
                </td>
              </tr>
            ))}

            {payments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  {status === null ? 'No payments yet.' : `No payments with status ${status}.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
