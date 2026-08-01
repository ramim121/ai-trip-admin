import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PaymentStatus, PlannerSessionStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { readConsoleAdmin } from './_lib/console-session'

/**
 * The console's landing screen, at `/`.
 *
 * This sits inside the `(admin)` group, which adds no URL segment, so it is what
 * `localhost:3001` serves. It replaced the create-next-app placeholder that used
 * to occupy that address — the two cannot coexist, since both resolve to `/`.
 *
 * A signed-out viewer is redirected rather than shown an empty shell. The layout
 * cannot do that on their behalf: a layout does not gate the page beneath it, so
 * every page checks for itself and this one is no exception.
 *
 * The counts are deliberately cheap — `count` against indexed columns, nothing
 * joined, nothing aggregated. This screen loads on every visit to the console,
 * and an expensive dashboard is a tax on every other task.
 */

export const dynamic = 'force-dynamic'

interface Tile {
  href: string
  label: string
  value: number
  hint: string
}

export default async function AdminDashboardPage() {
  const admin = await readConsoleAdmin()
  if (admin === null) redirect('/login')

  const [
    activities,
    destinations,
    plans,
    activeSubscriptions,
    pendingPayments,
    testPayments,
    sessions,
    itineraries,
  ] = await Promise.all([
    db.activity.count({ where: { isActive: true } }),
    db.destination.count({ where: { isActive: true } }),
    db.plan.count({ where: { isActive: true } }),
    db.subscription.count({ where: { status: 'ACTIVE' } }),
    db.payment.count({
      where: { status: { in: [PaymentStatus.INITIATED, PaymentStatus.PENDING] } },
    }),
    db.payment.count({ where: { isTest: true } }),
    db.plannerSession.count({ where: { status: PlannerSessionStatus.ACTIVE } }),
    db.itinerary.count(),
  ])

  const tiles: Tile[] = [
    {
      href: '/activities',
      label: 'Published activities',
      value: activities,
      hint: `across ${destinations} destination${destinations === 1 ? '' : 's'} — the only inventory the planner may recommend`,
    },
    { href: '/plans', label: 'Active plans', value: plans, hint: 'what a traveller can buy' },
    {
      href: '/subscriptions',
      label: 'Active subscriptions',
      value: activeSubscriptions,
      hint: 'currently inside their billing period',
    },
    {
      href: '/payments',
      label: 'Payments awaiting settlement',
      value: pendingPayments,
      hint: 'initiated or pending, not yet succeeded or failed',
    },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Console</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Signed in as {admin.role.replace('_', ' ').toLowerCase()}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            className="rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-600"
          >
            <p className="text-2xl font-semibold tabular-nums">{tile.value}</p>
            <p className="mt-1 text-sm font-medium">{tile.label}</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{tile.hint}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium">Planner</p>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            {sessions} active session{sessions === 1 ? '' : 's'} · {itineraries} itinerar
            {itineraries === 1 ? 'y' : 'ies'} created
          </p>
        </div>

        {testPayments > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {testPayments} test payment{testPayments === 1 ? '' : 's'}
            </p>
            {/* Surfaced here and not only on the payments screen, because a test
                row counted as revenue is a mistake nobody notices until the
                numbers are already wrong. */}
            <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
              Created by the sandbox gateway. No money moved — exclude these from any revenue
              figure.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
