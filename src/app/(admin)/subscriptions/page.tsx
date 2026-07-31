import { SubscriptionStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatBdt, formatDateTime } from '../_lib/format'

/**
 * /subscriptions — who is on what, and until when.
 *
 * Ordered by `currentPeriodEnd` descending, so the rows that matter
 * operationally — about to lapse, or just renewed — are at the top, rather than
 * whichever accounts happened to sign up first.
 *
 * Two columns are worth reading together. A row can be ACTIVE *and* cancelled:
 * cancelling is not a refund, so the subscription runs to the end of the period
 * that was paid for. And a row can be ACTIVE with `currentPeriodEnd` in the
 * past, which is not an entitlement — `resolveEntitlement` requires the period
 * to be live, so that account is already being served as FREE. Those are marked
 * rather than left for somebody to reconcile a status column against a date
 * column by eye.
 */

export const metadata = { title: 'Subscriptions · Beyond Borders' }

/** Enough to work with, not so many that the page becomes a report. */
const PAGE_SIZE = 100

export default async function SubscriptionsPage() {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const now = new Date()

  const subscriptions = await db.subscription.findMany({
    orderBy: { currentPeriodEnd: 'desc' },
    take: PAGE_SIZE,
    select: {
      id: true,
      status: true,
      startedAt: true,
      currentPeriodEnd: true,
      cancelledAt: true,
      plan: { select: { name: true, priceBdt: true } },
      user: { select: { email: true, name: true } },
    },
  })

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Subscriptions</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        The {PAGE_SIZE} most recently running subscriptions. Cancelling is not a refund — a
        cancelled subscription stays ACTIVE until its period ends.
      </p>

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">Traveller</th>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Started</th>
              <th className="px-4 py-3 font-medium">Period ends</th>
              <th className="px-4 py-3 font-medium">Cancelled</th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {subscriptions.map((subscription) => {
              const lapsed =
                subscription.status === SubscriptionStatus.ACTIVE &&
                subscription.currentPeriodEnd.getTime() <= now.getTime()

              return (
                <tr key={subscription.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{subscription.user.name}</div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {subscription.user.email}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>{subscription.plan.name}</div>
                    <div className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      {formatBdt(subscription.plan.priceBdt)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span>{subscription.status}</span>
                    {lapsed && (
                      <div className="text-xs text-amber-700 dark:text-amber-400">
                        period over — served as FREE
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                    {formatDateTime(subscription.startedAt)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {formatDateTime(subscription.currentPeriodEnd)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                    {formatDateTime(subscription.cancelledAt)}
                  </td>
                </tr>
              )
            })}

            {subscriptions.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No subscriptions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
