import Link from 'next/link'
import { db } from '@/lib/db'
import { Locked } from '../_components/locked'
import { COMMERCE_READ_ROLES, readConsoleAdminWithRole } from '../_lib/console-session'
import { formatBdt, formatLimit } from '../_lib/format'

/**
 * /plans — every entitlement tier, on sale or retired.
 *
 * Unlike the public endpoint, retired plans are listed. Ops needs to see the
 * row a lapsed subscription still points at; hiding it would make a
 * subscription to a plan that "does not exist" look like data corruption rather
 * than a deliberate retirement.
 *
 * Every limit renders through `formatLimit`, so a null shows as "Unlimited".
 * This is the screen where somebody decides what to charge, and a column that
 * printed unlimited as an empty cell would be read as zero by exactly the
 * person who must not read it that way.
 */

export const metadata = { title: 'Plans · Beyond Borders' }

const PLAN_SELECT = {
  code: true,
  name: true,
  priceBdt: true,
  interval: true,
  maxItineraryDays: true,
  maxSavedItineraries: true,
  itinerariesPerPeriod: true,
  isActive: true,
} as const

export default async function PlansPage() {
  const admin = await readConsoleAdminWithRole(COMMERCE_READ_ROLES)
  if (admin === null) return <Locked />

  const plans = await db.plan.findMany({
    orderBy: [{ sortOrder: 'asc' }, { priceBdt: 'asc' }],
    select: PLAN_SELECT,
  })

  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight">Plans</h1>
      <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        Prices are whole taka. A limit shown as “Unlimited” is stored as null, and enforcement reads
        it that way — it is not zero.
      </p>

      <div className="mt-6 overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <thead className="border-b border-zinc-200 text-left text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3 font-medium">Plan</th>
              <th className="px-4 py-3 font-medium">Price</th>
              <th className="px-4 py-3 font-medium">Interval</th>
              <th className="px-4 py-3 font-medium">Max days</th>
              <th className="px-4 py-3 font-medium">Max saved</th>
              <th className="px-4 py-3 font-medium">Per period</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>

          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {plans.map((plan) => (
              <tr key={plan.code} className={plan.isActive ? undefined : 'opacity-60'}>
                <td className="px-4 py-3">
                  <div className="font-medium">{plan.name}</div>
                  <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {plan.code}
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums">{formatBdt(plan.priceBdt)}</td>
                <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{plan.interval}</td>
                <td className="px-4 py-3 tabular-nums">{formatLimit(plan.maxItineraryDays)}</td>
                <td className="px-4 py-3 tabular-nums">{formatLimit(plan.maxSavedItineraries)}</td>
                <td className="px-4 py-3 tabular-nums">{formatLimit(plan.itinerariesPerPeriod)}</td>
                <td className="px-4 py-3">
                  {plan.isActive ? (
                    <span className="text-emerald-700 dark:text-emerald-400">On sale</span>
                  ) : (
                    <span className="text-zinc-500 dark:text-zinc-400">Retired</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/plans/${plan.code}`}
                    className="underline underline-offset-4 hover:no-underline"
                  >
                    Edit
                  </Link>
                </td>
              </tr>
            ))}

            {plans.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500 dark:text-zinc-400">
                  No plans yet. Run <code className="font-mono">npm run db:seed</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
